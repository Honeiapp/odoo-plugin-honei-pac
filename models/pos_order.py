from odoo import api, models


class PosOrder(models.Model):
    _inherit = "pos.order"

    @api.model
    def get_honei_refund_data(self, original_order_id):
        """Return the Honei payment data of the given (original) order."""
        order = self.browse(original_order_id)
        if not order.exists():
            return False

        for payment in order.payment_ids:
            if payment.payment_method_id.is_honei_payment and payment.transaction_id:
                return {
                    "original_payment_id": payment.transaction_id,
                    "original_terminal_code": payment.payment_ref_no or False,
                }

        return False
