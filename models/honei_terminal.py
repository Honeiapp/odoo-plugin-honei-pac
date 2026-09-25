import logging
import time
from datetime import datetime, timezone

import requests

from odoo import _, api, fields, models
from odoo.exceptions import UserError

from . import device_bridge

_logger = logging.getLogger(__name__)

CLOUD_TIMEOUT = 15


class HoneiTerminal(models.Model):
    _name = "pos.config.honei_terminal"
    _description = "honei Terminal"
    _inherit = ["pos.load.mixin"]

    name = fields.Char("Name", required=True)
    terminal_id = fields.Char("Terminal ID", required=True)
    pos_config_id = fields.Many2one("pos.config", "POS Config", required=True)

    # Local integration: requests are signed server-side, so the secret and
    # counter are never loaded into the POS.
    local_host = fields.Char(
        "IP local",
        help="IP del terminal en la red local (p. ej. 192.168.1.50). Puerto 8743 por defecto; "
        "se puede indicar otro con 192.168.1.50:puerto.",
    )
    local_secret = fields.Char(
        "Secreto local",
        groups="point_of_sale.group_pos_manager",
        copy=False,
        help="Clave de firma HMAC emitida por honei para este terminal (se obtiene con "
        "el botón Vincular).",
    )
    local_cert_fingerprint = fields.Char(
        "Huella del certificado",
        groups="point_of_sale.group_pos_manager",
        copy=False,
        help="SHA-256 del certificado HTTPS del terminal, para validarlo sin CA.",
    )
    local_key_issued_at = fields.Datetime("Clave emitida", readonly=True, copy=False)
    # Last counter sent (epoch ms or above); Float because Integer is int4.
    local_counter = fields.Float(
        "Último counter", groups="base.group_system", copy=False, readonly=True
    )
    local_status = fields.Char("Estado local", compute="_compute_local_status")

    @api.depends("local_host", "local_secret", "local_cert_fingerprint")
    def _compute_local_status(self):
        for terminal in self.sudo():
            if not terminal.local_host:
                terminal.local_status = _("Sin IP")
            elif not terminal.local_secret:
                terminal.local_status = _("Sin vincular")
            elif not terminal.local_cert_fingerprint:
                terminal.local_status = _("Sin huella")
            else:
                terminal.local_status = _("Listo")

    @api.model
    def _load_pos_data_fields(self, config):
        return ["id", "name", "terminal_id", "pos_config_id"]

    @api.model
    def _load_pos_data_domain(self, data, config):
        return [("pos_config_id", "=", config.id)]

    def _get_cloud_payment_method(self):
        self.ensure_one()
        methods = self.pos_config_id.payment_method_ids.filtered(
            lambda m: m.is_honei_payment and m.venue_api_key and m.odoo_integration_secret
        )
        if not methods:
            raise UserError(
                _(
                    "El punto de venta %s no tiene ningún método de pago honei con Venue API Key "
                    "y Odoo Integration Secret configurados.",
                    self.pos_config_id.display_name,
                )
            )
        return methods[0]

    def action_honei_local_provision(self):
        """Fetch the terminal's signing key and certificate fingerprint from the cloud API.

        Every call rotates the key: the terminal rejects the previous one immediately.
        """
        self.ensure_one()
        method = self._get_cloud_payment_method().sudo()
        base = (
            "https://staging.api.honei.app/v1"
            if method.is_staging
            else "https://api.honei.app/v1"
        )
        url = f"{base}/terminals/{self.terminal_id}/device-bridge-key"
        try:
            response = requests.post(
                url,
                headers={
                    "Content-Type": "application/json",
                    "Authorization": f"Bearer {method.odoo_integration_secret}",
                    "venue-api-key": method.venue_api_key,
                },
                timeout=CLOUD_TIMEOUT,
            )
        except requests.RequestException as e:
            raise UserError(_("No se ha podido contactar con honei: %s", e)) from e

        if response.status_code != 200:
            try:
                message = response.json().get("message")
            except ValueError:
                message = None
            raise UserError(
                _(
                    "honei ha rechazado la vinculación del terminal %(terminal)s (%(status)s): %(message)s",
                    terminal=self.terminal_id,
                    status=response.status_code,
                    message=message or response.text[:200],
                )
            )

        data = response.json()
        issued_at = data.get("issuedAt")
        fingerprint = device_bridge.normalize_fingerprint(data.get("certificateFingerprint"))
        # The key belongs to the physical terminal: update every POS using it.
        same_terminal = self.sudo().search([("terminal_id", "=", self.terminal_id)])
        same_terminal.write(
            {
                "local_secret": data["secret"],
                "local_cert_fingerprint": fingerprint or False,
                "local_key_issued_at": datetime.fromtimestamp(
                    issued_at / 1000, tz=timezone.utc
                ).replace(tzinfo=None)
                if issued_at
                else fields.Datetime.now(),
            }
        )
        _logger.info("honei terminal %s: device-bridge key provisioned", self.terminal_id)

        if not fingerprint:
            return self._notify(
                _(
                    "Clave obtenida, pero el terminal aún no ha reportado la huella de su "
                    "certificado. Enciende el terminal, espera un minuto y vuelve a vincular."
                ),
                "warning",
            )
        return self._notify(_("Terminal %s vinculado para integración local.", self.name), "success")

    def action_honei_local_test(self):
        """Check connection, certificate and signature against the terminal."""
        self.ensure_one()
        result = self.honei_local_status("odoo-connection-test")
        if result.get("error"):
            return self._notify(self._local_error_message(result["error"]), "danger", sticky=True)
        # 404 for an unknown ref means the signed request was accepted.
        if result["http_status"] in (200, 404):
            return self._notify(_("Conexión local con %s correcta.", self.name), "success")
        return self._notify(
            _(
                "El terminal respondió %(status)s: %(reason)s",
                status=result["http_status"],
                reason=result["data"].get("reason") or "-",
            ),
            "danger",
            sticky=True,
        )

    def _notify(self, message, notif_type, sticky=False):
        return {
            "type": "ir.actions.client",
            "tag": "display_notification",
            "params": {
                "title": _("honei Terminal"),
                "message": message,
                "type": notif_type,
                "sticky": sticky,
            },
        }

    @api.model
    def _local_error_message(self, error):
        messages = {
            "not_configured": _("Falta la IP local o la vinculación del terminal."),
            "missing_fingerprint": _("Falta la huella del certificado del terminal."),
            "unreachable": _("No se puede conectar con el terminal en la red local."),
            "no_response": _("El terminal no ha respondido."),
            "tls_error": _(
                "El certificado del terminal no coincide con la huella guardada. "
                "Vuelve a vincular el terminal."
            ),
            "invalid_response_signature": _("La respuesta del terminal no tiene una firma válida."),
            "busy": _("El terminal está ocupado."),
        }
        return messages.get(error, error)

    def _local_call(self, method, path, fields_=None):
        """Sign and send a request to the terminal.

        The counter is reserved and the request sent while the terminal row is
        locked in its own transaction, so concurrent workers can't overtake each
        other (the terminal rejects any counter not above the last one it saw)
        and the counter survives a rollback of the RPC transaction.

        Returns ``{"http_status", "data"}``, or ``{"error"}`` when there was no response.
        """
        self.ensure_one()
        terminal = self.sudo()
        if not terminal.local_host or not terminal.local_secret:
            return {"error": "not_configured"}
        if not terminal.local_cert_fingerprint:
            return {"error": "missing_fingerprint"}

        host = terminal.local_host
        secret = terminal.local_secret
        fingerprint = terminal.local_cert_fingerprint

        with self.env.registry.cursor() as cr:
            cr.execute("SET LOCAL lock_timeout = '15s'")
            cr.execute(
                "SELECT local_counter FROM pos_config_honei_terminal WHERE id = %s FOR UPDATE",
                [self.id],
            )
            last = int(cr.fetchone()[0] or 0)
            # Epoch-ms based so it stays ahead even after a database restore.
            counter = max(last + 1, int(time.time() * 1000))
            cr.execute(
                "UPDATE pos_config_honei_terminal SET local_counter = %s WHERE id = %s",
                [counter, self.id],
            )
            payload = dict(fields_ or {}, counter=counter)
            try:
                status, data = device_bridge.request(
                    host, fingerprint, method, path, payload, secret=secret
                )
            except device_bridge.DeviceBridgeError as e:
                return {"error": str(e)}

        return {"http_status": status, "data": data}

    @api.model
    def _check_ref(self, ref):
        if not ref or not all(c.isalnum() or c in "-_" for c in ref) or len(ref) > 100:
            raise UserError(_("Referencia de operación no válida."))

    def honei_local_init_payment(self, ref, amount):
        self._check_ref(ref)
        amount = round(abs(float(amount)), self.pos_config_id.currency_id.decimal_places or 2)
        return self._local_call("POST", "/init-payment", {"ref": ref, "amount": amount})

    def honei_local_init_refund(self, ref, payment_id, amount):
        self._check_ref(ref)
        if not payment_id:
            raise UserError(_("Falta el pago original de la devolución."))
        amount = round(abs(float(amount)), self.pos_config_id.currency_id.decimal_places or 2)
        return self._local_call(
            "POST", f"/payments/{ref}/refund", {"paymentId": payment_id, "amount": amount}
        )

    def honei_local_abort(self, ref):
        """Only supported by A77 and A920 Pro terminals."""
        self._check_ref(ref)
        return self._local_call("POST", f"/payments/{ref}/abort")

    def honei_local_status(self, ref):
        self._check_ref(ref)
        return self._local_call("GET", f"/payments/{ref}/status")
