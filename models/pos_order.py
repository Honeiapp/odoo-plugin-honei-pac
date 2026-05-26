from odoo import api, models


class PosOrder(models.Model):
    _inherit = "pos.order"

    @api.model
    def get_honei_refund_data(self, order_id):
        """Return the original Honei payment transaction_id for a refund order."""
        order = self.browse(order_id)
        if not order.exists():
            return False

        refunded_orderline_ids = order.lines.mapped("refunded_orderline_id")
        if not refunded_orderline_ids:
            return False

        original_order = refunded_orderline_ids[0].order_id
        for payment in original_order.payment_ids:
            if payment.payment_method_id.is_honei_payment and payment.transaction_id:
                return {
                    "original_payment_id": payment.transaction_id,
                    "original_terminal_code": payment.payment_ref_no or False,
                }

        return False
