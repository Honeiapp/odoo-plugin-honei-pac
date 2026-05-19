from odoo import fields, models, api


class PosPaymentMethod(models.Model):
    _inherit = "pos.payment.method"

    is_honei_payment = fields.Boolean(
        "honei Payment",
        default=False,
        help="Marca esta casilla si este método de pago usa la integración honei Terminal.",
    )
    venue_api_key = fields.Char(
        "Venue API Key",
        help="Clave de API del establecimiento. Se envía en el header venue-api-key.",
    )
    is_staging = fields.Boolean(
        "Entorno de pruebas (Staging)",
        default=False,
        help="Si está marcado, se usará la API de staging. Si no, producción.",
    )
    odoo_integration_secret = fields.Char(
        "Odoo Integration Secret",
        help="Secreto de integración. Se envía en el header Authorization Bearer.",
    )
    honei_auto_next_order = fields.Boolean(
        "Ir a la siguiente venta tras el pago",
        default=False,
        help="Si está marcado, al completar un pago honei se registra la venta y se abre "
        "directamente una nueva venta, sin pasar por la pantalla del ticket.",
    )

    @api.model
    def _load_pos_data_fields(self, config):
        fields_list = super()._load_pos_data_fields(config)
        fields_list += [
            "is_honei_payment",
            "venue_api_key",
            "is_staging",
            "odoo_integration_secret",
            "honei_auto_next_order",
        ]
        return fields_list
