"""Client for the honei Terminal Local API (device-bridge).

https://integration.terminal.honei.app/api-reference/pay-at-counter-and-apk/local-api

Requests carry a strictly increasing ``counter`` and an ``hmac`` (HMAC-SHA256
over every other field, sorted by name and joined as ``k=v`` with ``&``, keyed
with the secret's raw UTF-8 bytes). Values are stringified like Dart's
``toString()`` on the terminal: ``null``/``true``/``false`` and doubles always
with a decimal part, which is what ``repr`` gives for a Python float.
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
    """No response from the terminal (unreachable, TLS, fingerprint mismatch...)."""


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
    # Self-signed certificate: the pinned fingerprint replaces CA and hostname checks.
    return urllib3.PoolManager(
        cert_reqs="CERT_NONE",
        assert_fingerprint=fingerprint,
        timeout=urllib3.Timeout(connect=CONNECT_TIMEOUT, read=READ_TIMEOUT),
        retries=False,
    )


def request(host, fingerprint, method, path, fields=None, secret=None):
    """Send a request to the terminal and return ``(http_status, body)``.

    With ``secret``, signs ``fields`` (which must already include ``counter``)
    and verifies the signature of 2xx responses. GET sends fields as query
    params. Raises :class:`DeviceBridgeError` when no response is obtained.
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
        if "Fingerprints did not match" in str(e):
            raise DeviceBridgeError("tls_error") from e
        # Handshake failed: the request was never sent.
        raise DeviceBridgeError("unreachable") from e
    except (urllib3.exceptions.NewConnectionError, urllib3.exceptions.ConnectTimeoutError) as e:
        _logger.warning("honei device-bridge unreachable on %s: %s", url, e)
        raise DeviceBridgeError("unreachable") from e
    except urllib3.exceptions.HTTPError as e:
        # Connected but got no response: the terminal may or may not have received it.
        _logger.warning("honei device-bridge no response from %s: %s", url, e)
        raise DeviceBridgeError("no_response") from e

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

