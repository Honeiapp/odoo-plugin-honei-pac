from odoo import fields, models


class HoneiTerminal(models.Model):
    _name = "pos.config.honei_terminal"
    _description = "Honei Terminal"

    name = fields.Char("Name", required=True)
    terminal_id = fields.Char("Terminal ID", required=True)
    pos_config_id = fields.Many2one("pos.config", "POS Config", required=True)
