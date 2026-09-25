"""Cliente de la Local API (device-bridge) del honei Terminal.

Contrato (ver https://integration.terminal.honei.app/api-reference/pay-at-counter-and-apk/local-api):

- Base URL: ``https://<ip-del-terminal>:8743/device-bridge``, certificado autofirmado
  que se valida fijando su huella SHA-256 (no hay CA).
- Cada petición (salvo ``health``) lleva ``counter`` (estrictamente creciente) y
  ``hmac`` (HMAC-SHA256 de todos los campos salvo ``hmac``, ordenados por nombre y
  unidos como ``k=v`` con ``&``). El secreto se usa tal cual como bytes UTF-8, sin
  decodificar el hex.
- Las respuestas vienen firmadas del mismo modo y se verifican aquí.

Los valores se serializan igual que el ``toString()`` de Dart que usa el terminal
para canonicalizar: ``null``/``true``/``false`` y los ``double`` siempre con parte
decimal (``12.0``), igual que ``repr`` de un ``float`` en Python.
"""

import hashlib
import hmac as hmac_lib
import json
import logging

import urllib3

_logger = logging.getLogger(__name__)

DEFAULT_PORT = 8743
CONNECT_TIMEOUT = 4
READ_TIMEOUT = 10


class DeviceBridgeError(Exception):
    """Error de transporte (terminal inalcanzable, TLS, huella incorrecta...)."""


def _canonical_value(value):
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, float):
        return repr(value)
    return str(value)


def canonicalize(fields):
    keys = sorted(k for k in fields if k != "hmac")
    return "&".join(f"{k}={_canonical_value(fields[k])}" for k in keys)


def sign(fields, secret):
    return hmac_lib.new(
        secret.encode("utf-8"), canonicalize(fields).encode("utf-8"), hashlib.sha256
    ).hexdigest()


def verify(fields, secret):
    provided = fields.get("hmac")
    if not isinstance(provided, str) or not provided:
        return False
    return hmac_lib.compare_digest(provided, sign(fields, secret))


def normalize_fingerprint(fingerprint):
    return (fingerprint or "").replace(":", "").replace(" ", "").strip().lower()


def base_url(host):
    host = (host or "").strip()
    for prefix in ("https://", "http://"):
        if host.startswith(prefix):
            host = host[len(prefix):]
    host = host.split("/", 1)[0]
    if ":" not in host:
        host = f"{host}:{DEFAULT_PORT}"
    return f"https://{host}/device-bridge"


def _pool(fingerprint):
    fingerprint = normalize_fingerprint(fingerprint)
    if not fingerprint:
        raise DeviceBridgeError("missing_fingerprint")
    # La huella fijada sustituye a la validación por CA y de hostname: urllib3
    # compara el SHA-256 del certificado presentado y aborta si no coincide.
    return urllib3.PoolManager(
        cert_reqs="CERT_NONE",
        assert_fingerprint=fingerprint,
        timeout=urllib3.Timeout(connect=CONNECT_TIMEOUT, read=READ_TIMEOUT),
        retries=False,
    )


def request(host, fingerprint, method, path, fields=None, secret=None):
    """Hace una petición al terminal y devuelve ``(http_status, body)``.

    Si se pasa ``secret``, firma ``fields`` (que ya debe incluir ``counter``) y
    verifica la firma de las respuestas 2xx. En GET los campos van en la query.
    Lanza :class:`DeviceBridgeError` si no se llega a obtener respuesta.
    """
    url = base_url(host) + path
    payload = dict(fields or {})
    if secret is not None:
        payload["hmac"] = sign(payload, secret)

    try:
        pool = _pool(fingerprint)
        if method == "GET":
            response = pool.request("GET", url, fields={k: str(v) for k, v in payload.items()})
        else:
            response = pool.request(
                method,
                url,
                body=json.dumps(payload).encode("utf-8"),
                headers={"Content-Type": "application/json"},
            )
    except DeviceBridgeError:
        raise
    except urllib3.exceptions.SSLError as e:
        _logger.warning("honei device-bridge TLS error on %s: %s", url, e)
        raise DeviceBridgeError("tls_error") from e
    except urllib3.exceptions.HTTPError as e:
        _logger.warning("honei device-bridge unreachable on %s: %s", url, e)
        raise DeviceBridgeError("unreachable") from e

    try:
        body = json.loads(response.data.decode("utf-8")) if response.data else {}
    except ValueError:
        body = {}
    if not isinstance(body, dict):
        body = {}

    if secret is not None and 200 <= response.status < 300 and not verify(body, secret):
        _logger.warning("honei device-bridge invalid response signature on %s", url)
        raise DeviceBridgeError("invalid_response_signature")

    body.pop("hmac", None)
    return response.status, body
