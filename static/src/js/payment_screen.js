/** @odoo-module **/

import { PaymentScreen } from "@point_of_sale/app/screens/payment_screen/payment_screen";
import { patch } from "@web/core/utils/patch";
import { AlertDialog } from "@web/core/confirmation_dialog/confirmation_dialog";
import { _t } from "@web/core/l10n/translation";
import { HoneiValidationPopup } from "./honei_validation_popup";

patch(PaymentScreen.prototype, {
    setup() {
        super.setup(...arguments);
        this.honei_terminal = this.pos.config.baseData[this.pos.config.id].honei_terminal_data || [];
    },

    async addNewPaymentLine(paymentMethod) {
        const isHonei = paymentMethod.is_honei_payment;

        if (!isHonei) {
            return await super.addNewPaymentLine(paymentMethod);
        }

        if (this.honei_terminal.length === 0) {
            this.dialog.add(AlertDialog, {
                title: _t("Error de configuración"),
                body: _t("No se han encontrado configuraciones de pago Honei válidas."),
            });
            return;
        }

        const order = this.currentOrder || this.pos.get_order();
        const amount = order.get_due();
        const currency = this.pos.currency?.name || "EUR";

        const apiBaseUrl = paymentMethod.is_staging
            ? "https://staging.api.honei.app/v1"
            : "https://api.honei.app/v1";

        return new Promise((resolve) => {
            this.dialog.add(HoneiValidationPopup, {
                title: _t("Selecciona una opción de pago Honei"),
                paymentMethodName: paymentMethod.name,
                honeiConfigs: this.honei_terminal,
                venueApiKey: paymentMethod.venue_api_key || "",
                integrationSecret: paymentMethod.odoo_integration_secret || "",
                apiBaseUrl: apiBaseUrl,
                amount: amount,
                currency: currency,
                onConfirm: async (selectedHoneiConfig, apiResponse) => {
                    if (!apiResponse || apiResponse.status !== "done") {
                        this.dialog.add(AlertDialog, {
                            title: _t("Error de pago"),
                            body: _t("El pago no se ha podido procesar correctamente."),
                        });
                        resolve(null);
                        return;
                    }

                    const paymentLineAdded = await super.addNewPaymentLine(paymentMethod);
                    if (paymentLineAdded) {
                        const currentOrder = this.currentOrder || this.pos.get_order();
                        const newLine = currentOrder.get_selected_paymentline();
                        if (newLine) {
                            newLine.transaction_id = apiResponse.transactionId;
                            newLine.set_payment_status(apiResponse.status);
                            newLine.payment_ref_no = selectedHoneiConfig.code;
                            resolve(newLine);
                        } else {
                            this.dialog.add(AlertDialog, {
                                title: _t("Error de línea de pago"),
                                body: _t("No se ha podido obtener la línea de pago recién creada."),
                            });
                            resolve(null);
                        }
                    } else {
                        this.dialog.add(AlertDialog, {
                            title: _t("Error al añadir pago"),
                            body: _t("No se ha podido añadir la línea de pago. Inténtalo de nuevo."),
                        });
                        resolve(null);
                    }
                },
                onCancel: () => {
                    resolve(null);
                }
            });
        });
    }
});
