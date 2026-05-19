from odoo import fields, models


class PosConfig(models.Model):
    _inherit = "pos.config"

    honei_terminal_ids = fields.One2many(
        "pos.config.honei_terminal",
        "pos_config_id",
        string="Terminales honei",
    )

    def sync_honei_terminals_pos_data(self, local_terminal_ids=None):
        """Devuelve terminales actuales y los IDs locales que ya no existen."""
        self.ensure_one()
        terminal_model = self.env["pos.config.honei_terminal"]
        terminals = terminal_model.search([("pos_config_id", "=", self.id)])
        current_ids = set(terminals.ids)
        local_ids = set(local_terminal_ids or [])
        return {
            "records": terminal_model._load_pos_data_read(terminals, self),
            "remove_ids": list(local_ids - current_ids),
        }
