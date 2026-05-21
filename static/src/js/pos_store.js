/** @odoo-module **/

import { patch } from "@web/core/utils/patch";
import { PosStore } from "@point_of_sale/app/services/pos_store";
import { getActiveHoneiValidationPopup } from "./honei_validation_popup";

patch(PosStore.prototype, {
    async onClickBackButton() {
        const honeiPopup = getActiveHoneiValidationPopup();
        if (honeiPopup) {
            await honeiPopup.cancel();
            return;
        }
        return super.onClickBackButton(...arguments);
    },
});
