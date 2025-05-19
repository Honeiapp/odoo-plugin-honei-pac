/** @odoo-module **/

import { PaymentScreen } from "@point_of_sale/app/screens/payment_screen/payment_screen";
import { patch } from "@web/core/utils/patch";
import { AlertDialog } from "@web/core/confirmation_dialog/confirmation_dialog";
import { _t } from "@web/core/l10n/translation";
import { HoneiValidationPopup } from "./honei_validation_popup";

patch(PaymentScreen.prototype, {
    setup() {
        super.setup(...arguments);
        this.honei_payment = this.pos.config.baseData[this.pos.config.id].honei_payment_data || [];
    },

    async addNewPaymentLine(paymentMethod) {
        const isHonei = paymentMethod.is_honei_payment;

        if (!isHonei) {
            return await super.addNewPaymentLine(paymentMethod);
        }

        if (this.honei_payment.length === 0) {
            this.dialog.add(AlertDialog, {
                title: _t("Error de Configuració"),
                body: _t("No s'han trobat configuracions de pagament Honei vàlides."),
            });
            return;
        }

        // Utilitzem una Promise per gestionar el flux asíncron
        return new Promise((resolve) => {
            this.dialog.add(HoneiValidationPopup, {
                title: _t("Selecciona una opció de pagament Honei"),
                paymentMethodName: paymentMethod.name,
                honeiConfigs: this.honei_payment,
                token: paymentMethod.honei_token || "",
                onConfirm: async (selectedHoneiConfig, apiResponse) => {
                    if (!apiResponse || apiResponse.status !== "done") {
                        this.dialog.add(AlertDialog, {
                            title: _t("Error de Pagament"),
                            body: _t("El pagament no s'ha pogut processar correctament."),
                        });
                        resolve(null);
                        return;
                    }

                    const paymentLineAdded = await super.addNewPaymentLine(paymentMethod);
                    if (paymentLineAdded) {
                        const order = this.currentOrder || this.pos.get_order();
                        const newLine = order.get_selected_paymentline();
                        if (newLine) {
                            newLine.transaction_id = apiResponse.transactionId;
                            newLine.set_payment_status(apiResponse.status);
                            newLine.payment_ref_no = selectedHoneiConfig.terminal_id;
                            resolve(newLine);
                        } else {
                            this.dialog.add(AlertDialog, {
                                title: _t("Error de Línia de Pagament"),
                                body: _t("No s'ha pogut obtenir la línia de pagament acabada de crear."),
                            });
                            resolve(null);
                        }
                    } else {
                        this.dialog.add(AlertDialog, {
                            title: _t("Error en Afegir Pagament"),
                            body: _t("No s'ha pogut afegir la línia de pagament. Intenta-ho de nou."),
                        });
                        resolve(null);
                    }
                },
                onCancel: () => {
                    console.log("Popup Honei cancel·lat.");
                    resolve(null);
                }
            });
        });
    }
});
