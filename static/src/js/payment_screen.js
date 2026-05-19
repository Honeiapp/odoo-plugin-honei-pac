/** @odoo-module **/

import { PaymentScreen } from "@point_of_sale/app/screens/payment_screen/payment_screen";
import { patch } from "@web/core/utils/patch";
import { AlertDialog } from "@web/core/confirmation_dialog/confirmation_dialog";
import { _t } from "@web/core/l10n/translation";
import { HoneiValidationPopup, getActiveHoneiValidationPopup } from "./honei_validation_popup";

let _lastHoneiTerminalId = null;

patch(PaymentScreen.prototype, {
    async _syncHoneiTerminals() {
        const terminalModel = this.pos.models["pos.config.honei_terminal"];
        const configId = this.pos.config.id;
        const localIds = (terminalModel?.getAll() || [])
            .filter((terminal) => terminal.pos_config_id?.id === configId)
            .map((terminal) => terminal.id);

        const syncResult = await this.pos.data.call(
            "pos.config",
            "sync_honei_terminals_pos_data",
            [[configId], localIds]
        );

        if (!syncResult) {
            return this._mapHoneiTerminals(terminalModel, configId);
        }

        for (const terminalId of syncResult.remove_ids || []) {
            const record = terminalModel?.get(terminalId);
            if (record) {
                record.delete({ silent: true });
            }
        }

        if (syncResult.records?.length) {
            this.pos.models.connectNewData({
                "pos.config.honei_terminal": syncResult.records,
            });
        }

        return this._mapHoneiTerminals(terminalModel, configId);
    },

    _mapHoneiTerminals(terminalModel, configId) {
        return (terminalModel?.getAll() || [])
            .filter((terminal) => terminal.pos_config_id?.id === configId)
            .map((terminal) => ({
                id: terminal.id,
                name: terminal.name,
                code: terminal.terminal_id,
            }));
    },

    async addNewPaymentLine(paymentMethod) {
        const isHonei = paymentMethod.is_honei_payment;

        if (!isHonei) {
            return await super.addNewPaymentLine(paymentMethod);
        }

        const honeiTerminals = await this._syncHoneiTerminals();

        if (honeiTerminals.length === 0) {
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
            let settled = false;
            const settle = (value) => {
                if (!settled) {
                    settled = true;
                    resolve(value);
                }
            };

            this.dialog.add(
                HoneiValidationPopup,
                {
                    title: _t("Selecciona un terminal de cobro"),
                    paymentMethodName: paymentMethod.name,
                    honeiConfigs: honeiTerminals,
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
                            settle(false);
                            return;
                        }

                        const result = this.currentOrder.addPaymentline(paymentMethod);
                        if (result.status) {
                            const newLine = this.paymentLines.at(-1);
                            if (newLine) {
                                newLine.transaction_id = apiResponse.transactionId;
                                newLine.payment_status = apiResponse.status;
                                newLine.payment_ref_no = selectedHoneiConfig.code;
                                settle(true);
                                await this.validateOrder(false);
                            } else {
                                this.dialog.add(AlertDialog, {
                                    title: _t("Error de línea de pago"),
                                    body: _t(
                                        "No se ha podido obtener la línea de pago recién creada."
                                    ),
                                });
                                settle(false);
                            }
                        } else {
                            this.dialog.add(AlertDialog, {
                                title: _t("Error al añadir pago"),
                                body: result.data,
                            });
                            settle(false);
                        }
                    },
                    onCancel: () => {
                        settle(false);
                    },
                },
                {
                    onClose: async () => {
                        const popup = getActiveHoneiValidationPopup();
                        if (popup?.isProcessing()) {
                            await popup.cancel(true);
                            settle(false);
                        }
                    },
                }
            );
        });
    },
});
