/** @odoo-module **/

import { PaymentScreen } from "@point_of_sale/app/screens/payment_screen/payment_screen";
import { patch } from "@web/core/utils/patch";
import { AlertDialog } from "@web/core/confirmation_dialog/confirmation_dialog";
import { _t } from "@web/core/l10n/translation";
import { HoneiValidationPopup } from "./honei_validation_popup";

let _lastHoneiTerminalId = null;

patch(PaymentScreen.prototype, {
    setup() {
        super.setup(...arguments);
        const allTerminals = this.pos.models["pos.config.honei_terminal"]?.getAll() || [];
        this.honei_terminal = allTerminals
            .filter((t) => t.pos_config_id?.id === this.pos.config.id)
            .map((t) => ({ id: t.id, name: t.name, code: t.terminal_id }));
    },

    async addNewPaymentLine(paymentMethod) {
        const isHonei = paymentMethod.is_honei_payment;

        if (!isHonei) {
            return await super.addNewPaymentLine(paymentMethod);
        }

        if (this.honei_terminal.length === 0) {
            this.dialog.add(AlertDialog, {
                title: _t("Error de configuración"),
                body: _t("No se han encontrado configuraciones de pago honei válidas."),
            });
            return false;
        }

        const order = this.currentOrder;
        const amount = order.remainingDue;
        const currency = this.pos.currency?.name || "EUR";

        const apiBaseUrl = paymentMethod.is_staging
            ? "https://staging.api.honei.app/v1"
            : "https://api.honei.app/v1";

        return new Promise((resolve) => {
            this.dialog.add(HoneiValidationPopup, {
                title: _t("Selecciona un terminal de cobro"),
                paymentMethodName: paymentMethod.name,
                honeiConfigs: this.honei_terminal,
                defaultTerminalId: _lastHoneiTerminalId,
                onTerminalSelected: (terminalId) => {
                    _lastHoneiTerminalId = terminalId;
                },
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
                        resolve(false);
                        return;
                    }

                    const result = this.currentOrder.addPaymentline(paymentMethod);
                    if (result.status) {
                        const newLine = this.paymentLines.at(-1);
                        if (newLine) {
                            newLine.transaction_id = apiResponse.transactionId;
                            newLine.payment_status = apiResponse.status;
                            newLine.payment_ref_no = selectedHoneiConfig.code;
                            resolve(true);
                            await this.validateOrder(false);
                        } else {
                            this.dialog.add(AlertDialog, {
                                title: _t("Error de línea de pago"),
                                body: _t("No se ha podido obtener la línea de pago recién creada."),
                            });
                            resolve(false);
                        }
                    } else {
                        this.dialog.add(AlertDialog, {
                            title: _t("Error al añadir pago"),
                            body: result.data,
                        });
                        resolve(false);
                    }
                },
                onCancel: () => {
                    resolve(false);
                }
            });
        });
    }
});
