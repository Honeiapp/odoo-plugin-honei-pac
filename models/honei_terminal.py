import logging
from datetime import datetime, timezone

import requests

from odoo import _, api, fields, models
from odoo.exceptions import UserError

_logger = logging.getLogger(__name__)

CLOUD_TIMEOUT = 15


class HoneiTerminal(models.Model):
    _name = "pos.config.honei_terminal"
    _description = "honei Terminal"
    _inherit = ["pos.load.mixin"]

    name = fields.Char("Name", required=True)
    terminal_id = fields.Char("Terminal ID", required=True)
    pos_config_id = fields.Many2one("pos.config", "POS Config", required=True)

    # Local integration: the POS talks to the terminal directly over the shop's
    # network and signs requests itself, so it loads the host and secret.
    local_host = fields.Char(
        "IP local",
        help="IP del terminal en la red local (p. ej. 192.168.1.50). Puerto 8743 por defecto; "
        "se puede indicar otro con 192.168.1.50:puerto.",
    )
    local_secret = fields.Char(
        "Secreto local",
        copy=False,
        help="Clave de firma HMAC emitida por honei para este terminal (se obtiene con "
        "el botón Vincular).",
    )
    local_key_issued_at = fields.Datetime("Clave emitida", readonly=True, copy=False)
    local_status = fields.Char("Estado local", compute="_compute_local_status")

    @api.depends("local_host", "local_secret")
    def _compute_local_status(self):
        for terminal in self:
            if not terminal.local_host:
                terminal.local_status = _("Sin IP")
            elif not terminal.local_secret:
                terminal.local_status = _("Sin vincular")
            else:
                terminal.local_status = _("Listo")

    @api.model
    def _load_pos_data_fields(self, config):
        return ["id", "name", "terminal_id", "pos_config_id", "local_host", "local_secret"]

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
        """Fetch the terminal's signing key from the cloud API.

        Asks for the plain-HTTP transport: the POS browser calls the terminal
        directly and can't accept its self-signed certificate. Every call rotates
        the key: the terminal rejects the previous one immediately.
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
                json={"transport": "http"},
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
        # The key belongs to the physical terminal: update every POS using it.
        same_terminal = self.sudo().search([("terminal_id", "=", self.terminal_id)])
        same_terminal.write(
            {
                "local_secret": data["secret"],
                "local_key_issued_at": datetime.fromtimestamp(
                    issued_at / 1000, tz=timezone.utc
                ).replace(tzinfo=None)
                if issued_at
                else fields.Datetime.now(),
            }
        )
        _logger.info("honei terminal %s: device-bridge key provisioned", self.terminal_id)

        return self._notify(_("Terminal %s vinculado para integración local.", self.name), "success")

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
