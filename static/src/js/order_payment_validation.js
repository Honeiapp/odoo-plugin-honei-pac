/** @odoo-module **/

import OrderPaymentValidation from "@point_of_sale/app/utils/order_payment_validation";
import { patch } from "@web/core/utils/patch";
import { RPCError } from "@web/core/network/rpc";

patch(OrderPaymentValidation.prototype, {
    _honeiShouldAutoNextOrder() {
        return this.order.payment_ids.some(
            (payment) =>
                payment.payment_method_id.is_honei_payment &&
                payment.payment_method_id.honei_auto_next_order
        );
    },

    async shouldHideValidationBehindFeedbackScreen() {
        if (!this._honeiShouldAutoNextOrder()) {
            return super.shouldHideValidationBehindFeedbackScreen(...arguments);
        }

        try {
            this.pos.env.services.ui.block();
            const response = await this.finalizeValidation();
            if (response instanceof RPCError) {
                return false;
            }
        } finally {
            this.pos.env.services.ui.unblock();
        }

        this.pos.orderDone(this.order);
        return true;
    },
});
