from odoo import fields, models, api


class PosPaymentMethod(models.Model):
    _inherit = "pos.payment.method"

    is_honei_payment = fields.Boolean(
        "Honei Payment",
        default=False,
        help="Marca esta casilla si este método de pago usa la integración Honei Terminal.",
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

    @api.model
    def _load_pos_data_fields(self, config_id):
        fields_list = super()._load_pos_data_fields(config_id)
        fields_list += ["is_honei_payment", "venue_api_key", "is_staging", "odoo_integration_secret"]
        return fields_list
