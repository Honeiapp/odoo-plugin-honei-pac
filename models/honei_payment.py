from odoo import fields, models


class HoneiPayment(models.Model):
    _name = "pos.config.honei_payment"
    _description = "Honei Payment"

    name = fields.Char("Name", required=True)
    terminal_id = fields.Char("Terminal ID", required=True)
    pos_config_id = fields.Many2one("pos.config", "POS Config", required=True)
