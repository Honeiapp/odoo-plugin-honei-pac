from odoo import fields, models


class PosConfig(models.Model):
    _inherit = "pos.config"

    honei_payment_ids = fields.One2many("pos.config.honei_payment", "pos_config_id",
                                        string="Configuracions de Pagament Honei")

    def _load_pos_data(self, data):
        config_data_result = super()._load_pos_data(data)
        honei_payment_ids = self.env['pos.config.honei_payment'].browse(
            config_data_result['data'][0]['honei_payment_ids'])
        honei_payments_data = [{'id': honei_payment.id,
                                'name': honei_payment.name,
                                'code': honei_payment.terminal_id
                                } for honei_payment in honei_payment_ids]
        config_data_result['data'][0]['honei_payment_data'] = honei_payments_data
        return config_data_result
