from odoo import fields, models


class PosConfig(models.Model):
    _inherit = "pos.config"

    honei_terminal_ids = fields.One2many(
        "pos.config.honei_terminal",
        "pos_config_id",
        string="Terminales honei",
    )
