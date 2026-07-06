/** @odoo-module **/

import { onWillUnmount } from "@odoo/owl";
import { PaymentScreen } from "@point_of_sale/app/screens/payment_screen/payment_screen";
import { patch } from "@web/core/utils/patch";
import { AlertDialog } from "@web/core/confirmation_dialog/confirmation_dialog";
import { _t } from "@web/core/l10n/translation";
import { HoneiValidationPopup, getActiveHoneiValidationPopup } from "./honei_validation_popup";
import { honeiLogger } from "./honei_logger";

patch(PaymentScreen.prototype, {
    setup() {
        super.setup(...arguments);
        this._honeiDisposed = false;
        onWillUnmount(() => {
            this._honeiDisposed = true;
            if (this.pos?.honeiPaymentInProgress && !getActiveHoneiValidationPopup()) {
                honeiLogger.warn("payment_screen_unmount_releasing_lock");
                this.pos.releaseHoneiPayment();
            }
        });
    },

    async _syncHoneiTerminals() {
        const terminals = await this.pos.syncHoneiTerminals();
        return terminals.map((terminal) => ({
            id: terminal.id,
            name: terminal.name,
            code: terminal.terminal_id,
        }));
    },

    _getOriginalHoneiPaymentId() {
        const order = this.currentOrder;
        const refundedLines = (order.lines || []).filter((l) => l.refunded_orderline_id);
        if (refundedLines.length === 0) {
            return null;
        }

        const originalOrder = refundedLines[0].refunded_orderline_id?.order_id;
        if (!originalOrder) {
            return null;
        }

        const originalPayment = (originalOrder.payment_ids || []).find(
            (p) => p.payment_method_id?.is_honei_payment && p.transaction_id
        );
        return originalPayment?.transaction_id || null;
    },

    async _getOriginalHoneiPaymentIdRpc() {
        const order = this.currentOrder;
        if (!order.id) {
            return null;
        }
        const result = await this.pos.data.call(
            "pos.order",
            "get_honei_refund_data",
            [order.id]
        );
        return result ? result.original_payment_id : null;
    },

    async addNewPaymentLine(paymentMethod) {
        const isHonei = paymentMethod.is_honei_payment;

        if (!isHonei) {
            return await super.addNewPaymentLine(paymentMethod);
        }

        const order = this.currentOrder;
        const amount = order.remainingDue;
        const isRefund = amount < 0;

        honeiLogger.info("payment_button_clicked", {
            paymentMethodId: paymentMethod.id,
            paymentMethodName: paymentMethod.name,
            isStaging: !!paymentMethod.is_staging,
            amount,
            isRefund,
            orderId: order.id || null,
            inProgress: !!this.pos.honeiPaymentInProgress,
        });

        if (!this.pos.tryReserveHoneiPayment()) {
            honeiLogger.warn("payment_button_ignored_in_progress");
            return false;
        }
        const flowStart = performance.now();

        let originalPaymentId = null;
        if (isRefund) {
            originalPaymentId = this._getOriginalHoneiPaymentId();
            if (!originalPaymentId) {
                honeiLogger.info("refund_lookup_rpc_fallback", { orderId: order.id || null });
                originalPaymentId = await this._getOriginalHoneiPaymentIdRpc();
            }
            honeiLogger.info("refund_lookup_result", {
                originalPaymentId: originalPaymentId || null,
            });
            if (this._honeiDisposed) {
                honeiLogger.warn("payment_flow_aborted_disposed", { stage: "refund_lookup" });
                return false;
            }
            if (!originalPaymentId) {
                this.pos.releaseHoneiPayment();
                honeiLogger.error("refund_no_original_payment");
                this.dialog.add(AlertDialog, {
                    title: _t("Error de devolución"),
                    body: _t(
                        "No se ha encontrado el pago original de honei para esta devolución."
                    ),
                });
                return false;
            }
        }

        const honeiTerminals = await this._syncHoneiTerminals();
        if (this._honeiDisposed) {
            honeiLogger.warn("payment_flow_aborted_disposed", { stage: "sync_terminals" });
            return false;
        }
        honeiLogger.info("terminals_synced", { count: honeiTerminals.length });

        if (honeiTerminals.length === 0) {
            this.pos.releaseHoneiPayment();
            honeiLogger.error("no_terminals_available");
            this.dialog.add(AlertDialog, {
                title: _t("Error de configuración"),
                body: _t("No se han encontrado configuraciones de pago honei válidas."),
            });
            return false;
        }

        let selectedTerminal = null;
        if (honeiTerminals.length === 1) {
            selectedTerminal = honeiTerminals[0];
        } else if (this.pos.honeiDefaultTerminalId != null) {
            selectedTerminal =
                honeiTerminals.find((t) => t.id === this.pos.honeiDefaultTerminalId) || null;
        }

        if (!selectedTerminal) {
            this.pos.releaseHoneiPayment();
            honeiLogger.warn("no_default_terminal_selected", {
                terminalsCount: honeiTerminals.length,
                defaultId: this.pos.honeiDefaultTerminalId ?? null,
            });
            this.notification.add(
                _t("1. Abre el menú ☰   2. Pulsa honei Terminal   3. Elige un terminal"),
                {
                    title: _t("Selecciona un terminal por defecto"),
                    type: "warning",
                    sticky: false,
                }
            );
            return false;
        }

        if (getActiveHoneiValidationPopup()) {
            this.pos.releaseHoneiPayment();
            honeiLogger.warn("payment_flow_aborted_popup_already_active");
            return false;
        }

        honeiLogger.info("terminal_selected", {
            id: selectedTerminal.id,
            name: selectedTerminal.name,
            code: selectedTerminal.code,
        });

        const currency = this.pos.currency?.name || "EUR";

        const apiBaseUrl = paymentMethod.is_staging
            ? "https://staging.api.honei.app/v1"
            : "https://api.honei.app/v1";

        return new Promise((resolve) => {
            let settled = false;
            const settle = (value) => {
                if (!settled) {
                    settled = true;
                    this.pos.releaseHoneiPayment();
                    resolve(value);
                }
            };

            this.dialog.add(
                HoneiValidationPopup,
                {
                    title: isRefund
                        ? _t("Procesando devolución honei")
                        : _t("Procesando pago honei"),
                    terminal: selectedTerminal,
                    venueApiKey: paymentMethod.venue_api_key || "",
                    integrationSecret: paymentMethod.odoo_integration_secret || "",
                    apiBaseUrl: apiBaseUrl,
                    amount: amount,
                    currency: currency,
                    mode: isRefund ? "refund" : "payment",
                    originalPaymentId: originalPaymentId || "",
                    onConfirm: async (selectedHoneiConfig, apiResponse) => {
                        honeiLogger.info("popup_on_confirm", {
                            isRefund,
                            status: apiResponse?.status || null,
                            transactionId: apiResponse?.transactionId || null,
                        });
                        if (!apiResponse || apiResponse.status !== "done") {
                            honeiLogger.error("popup_on_confirm_not_done", {
                                isRefund,
                                apiResponse,
                            });
                            this.dialog.add(AlertDialog, {
                                title: isRefund
                                    ? _t("Error de devolución")
                                    : _t("Error de pago"),
                                body: isRefund
                                    ? _t(
                                          "La devolución no se ha podido procesar correctamente."
                                      )
                                    : _t(
                                          "El pago no se ha podido procesar correctamente."
                                      ),
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
                                honeiLogger.info("payment_line_added", {
                                    isRefund,
                                    transactionId: apiResponse.transactionId,
                                    terminalCode: selectedHoneiConfig.code,
                                });
                                settle(true);
                                const saveStart = performance.now();
                                try {
                                    await this.validateOrder(false);
                                    honeiLogger.info("order_validated_ok", {
                                        isRefund,
                                        save_ms: Math.round(performance.now() - saveStart),
                                        total_flow_ms: Math.round(
                                            performance.now() - flowStart
                                        ),
                                    });
                                } catch (e) {
                                    honeiLogger.error("order_validate_exception", {
                                        isRefund,
                                        save_ms: Math.round(performance.now() - saveStart),
                                        message: e?.message || String(e),
                                        stack: e?.stack || null,
                                    });
                                    throw e;
                                }
                            } else {
                                honeiLogger.error("payment_line_missing_after_add");
                                this.dialog.add(AlertDialog, {
                                    title: _t("Error de línea de pago"),
                                    body: _t(
                                        "No se ha podido obtener la línea de pago recién creada."
                                    ),
                                });
                                settle(false);
                            }
                        } else {
                            honeiLogger.error("add_payment_line_failed", {
                                isRefund,
                                data: result.data || null,
                            });
                            this.dialog.add(AlertDialog, {
                                title: isRefund
                                    ? _t("Error al añadir devolución")
                                    : _t("Error al añadir pago"),
                                body: result.data,
                            });
                            settle(false);
                        }
                    },
                    onCancel: () => {
                        honeiLogger.info("popup_on_cancel", { isRefund });
                        settle(false);
                    },
                },
                {
                    onClose: async () => {
                        const popup = getActiveHoneiValidationPopup();
                        if (popup?.isProcessing()) {
                            await popup.cancel();
                        }
                        settle(false);
                    },
                }
            );
        });
    },
});
