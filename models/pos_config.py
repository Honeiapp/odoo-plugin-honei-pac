from odoo import api, fields, models


class PosConfig(models.Model):
    _inherit = "pos.config"

    honei_terminal_ids = fields.One2many(
        "pos.config.honei_terminal",
        "pos_config_id",
        string="Terminales honei",
    )
    honei_has_local_mode = fields.Boolean(compute="_compute_honei_has_local_mode")

    @api.depends("payment_method_ids.is_honei_payment", "payment_method_ids.honei_integration_mode")
    def _compute_honei_has_local_mode(self):
        for config in self:
            config.honei_has_local_mode = any(
                m.is_honei_payment and m.honei_integration_mode == "local"
                for m in config.payment_method_ids
            )

    def sync_honei_terminals_pos_data(self, local_terminal_ids=None):
        """Return the current terminals and the local IDs that no longer exist."""
        self.ensure_one()
        terminal_model = self.env["pos.config.honei_terminal"]
        terminals = terminal_model.search([("pos_config_id", "=", self.id)])
        current_ids = set(terminals.ids)
        local_ids = set(local_terminal_ids or [])
        return {
            "records": terminal_model._load_pos_data_read(terminals, self),
            "remove_ids": list(local_ids - current_ids),
        }
