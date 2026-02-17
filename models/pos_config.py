from odoo import fields, models


class PosConfig(models.Model):
    _inherit = "pos.config"

    honei_terminal_ids = fields.One2many(
        "pos.config.honei_terminal",
        "pos_config_id",
        string="Terminales Honei",
    )

    def _load_pos_data(self, data):
        config_data_result = super()._load_pos_data(data)
        honei_terminal_ids = self.env["pos.config.honei_terminal"].browse(
            config_data_result["data"][0]["honei_terminal_ids"]
        )
        honei_terminals_data = [
            {"id": t.id, "name": t.name, "code": t.terminal_id}
            for t in honei_terminal_ids
        ]
        config_data_result["data"][0]["honei_terminal_data"] = honei_terminals_data
        return config_data_result
