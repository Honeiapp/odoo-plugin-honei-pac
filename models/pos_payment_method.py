from odoo import fields, models, api


class PosPaymentMethod(models.Model):
    _inherit = "pos.payment.method"

    is_honei_payment = fields.Boolean("Honei Payment", default=False,
                                      help="Marca aquesta casella si aquest mètode de pagament utilitza la integració Honei.")
    honei_token = fields.Char("Honei Token", help="Token d'autenticació per a la integració Honei.")

    @api.model
    def _load_pos_data_fields(self, config_id):
        fields_list = super()._load_pos_data_fields(config_id)
        fields_list += ['is_honei_payment', 'honei_token']
        return fields_list
