from odoo import api, fields, models


class HoneiTerminal(models.Model):
    _name = "pos.config.honei_terminal"
    _description = "honei Terminal"
    _inherit = ["pos.load.mixin"]

    name = fields.Char("Name", required=True)
    terminal_id = fields.Char("Terminal ID", required=True)
    pos_config_id = fields.Many2one("pos.config", "POS Config", required=True)

    @api.model
    def _load_pos_data_fields(self, config):
        return ["id", "name", "terminal_id", "pos_config_id"]

    @api.model
    def _load_pos_data_domain(self, data, config):
        return [("pos_config_id", "=", config.id)]
