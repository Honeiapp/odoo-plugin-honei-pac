/** @odoo-module **/

import { _t } from "@web/core/l10n/translation";
import { Component, onMounted, onWillDestroy, useState } from "@odoo/owl";
import { Dialog } from "@web/core/dialog/dialog";
import { honeiLogger } from "./honei_logger";

const POLL_INTERVAL_MS = 1000;

let activeHoneiValidationPopup = null;

export function getActiveHoneiValidationPopup() {
    return activeHoneiValidationPopup;
}

export class HoneiValidationPopup extends Component {
    static template = "honei_terminal.HoneiValidationPopup";
    static components = { Dialog };

    static props = {
        close: Function,
        title: { type: String, optional: true },
        cancelText: { type: String, optional: true },
        terminal: {
            type: Object,
            shape: {
                id: Number,
                name: String,
                code: String,
            },
        },
        venueApiKey: { type: String, optional: true },
        integrationSecret: { type: String, optional: true },
        apiBaseUrl: { type: String, optional: true },
        amount: { type: Number, optional: false },
        currency: { type: String, optional: true },
        onConfirm: { type: Function, optional: true },
        onCancel: { type: Function, optional: true },
        mode: { type: String, optional: true },
        originalPaymentId: { type: String, optional: true },
    };

    static defaultProps = {
        title: _t("Procesando pago honei"),
        cancelText: _t("Cancelar"),
        currency: "EUR",
        onConfirm: () => {},
        onCancel: () => {},
        mode: "payment",
        originalPaymentId: "",
    };

    setup() {
        this.state = useState({
            status: "idle",
            errorMessage: "",
            statusMessage: "",
            cancelling: false,
            abortUrl: null,
        });

        this._t = _t;
        this._polling = false;
        this._closed = false;

        onMounted(() => {
            if (activeHoneiValidationPopup && activeHoneiValidationPopup !== this) {
                honeiLogger.warn("duplicate_popup_prevented", {
                    mode: this.props.mode,
                    amount: this.props.amount,
                });
                this._closed = true;
                this.props.close();
                return;
            }
            activeHoneiValidationPopup = this;
            this._bindDismissHandler();
            this.confirm();
        });

        onWillDestroy(() => {
            if (activeHoneiValidationPopup === this) {
                activeHoneiValidationPopup = null;
            }
            this._clearDismissHandler();
        });
    }

    get isRefund() {
        return this.props.mode === "refund";
    }

    isProcessing() {
        return this.state.status === "loading" || this.state.status === "processing";
    }

    _bindDismissHandler() {
        if (!this.env.dialogData) {
            return;
        }
        this.env.dialogData.dismiss = async () => {
            if (this.isProcessing()) {
                await this.cancel();
            }
        };
    }

    _clearDismissHandler() {
        if (this.env.dialogData?.dismiss) {
            delete this.env.dialogData.dismiss;
        }
    }

    _getHeaders() {
        return {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.props.integrationSecret || ""}`,
            "venue-api-key": this.props.venueApiKey || "",
        };
    }

    async _initPayment(terminalId, amount, currency) {
        const url = `${this.props.apiBaseUrl || ""}/terminals/${terminalId}/init-payment`;
        const t0 = performance.now();
        honeiLogger.info("init_payment_request", { terminalId, amount, currency, url });
        let response;
        try {
            response = await fetch(url, {
                method: "POST",
                headers: this._getHeaders(),
                body: JSON.stringify({ amount, currency }),
            });
        } catch (e) {
            honeiLogger.error("init_payment_network_error", {
                terminalId,
                duration_ms: Math.round(performance.now() - t0),
                message: e?.message || String(e),
            });
            throw e;
        }

        const duration_ms = Math.round(performance.now() - t0);

        if (!response.ok) {
            const error = await response.json().catch(() => ({}));
            honeiLogger.error("init_payment_http_error", {
                terminalId,
                status: response.status,
                duration_ms,
                error,
            });
            throw new Error(error.message || error.reason || `Error ${response.status}`);
        }

        const data = await response.json();
        honeiLogger.info("init_payment_response", {
            terminalId,
            duration_ms,
            paymentId: data.paymentId,
            hasStatusUrl: !!data.paymentStatusUrl,
            hasAbortUrl: !!data.paymentAbortUrl,
        });
        return data;
    }

    async _initRefund(terminalId, paymentId, amount) {
        const url = `${this.props.apiBaseUrl || ""}/terminals/${terminalId}/payments/${paymentId}/init-refund`;
        const t0 = performance.now();
        honeiLogger.info("init_refund_request", { terminalId, paymentId, amount, url });
        let response;
        try {
            response = await fetch(url, {
                method: "POST",
                headers: this._getHeaders(),
                body: JSON.stringify({ amount }),
            });
        } catch (e) {
            honeiLogger.error("init_refund_network_error", {
                terminalId,
                paymentId,
                duration_ms: Math.round(performance.now() - t0),
                message: e?.message || String(e),
            });
            throw e;
        }

        const duration_ms = Math.round(performance.now() - t0);

        if (!response.ok) {
            const error = await response.json().catch(() => ({}));
            honeiLogger.error("init_refund_http_error", {
                terminalId,
                paymentId,
                status: response.status,
                duration_ms,
                error,
            });
            throw new Error(error.message || error.reason || `Error ${response.status}`);
        }

        const data = await response.json();
        honeiLogger.info("init_refund_response", {
            terminalId,
            paymentId,
            duration_ms,
            refundId: data.refundId,
            hasStatusUrl: !!data.refundStatusUrl,
            hasAbortUrl: !!data.refundAbortUrl,
        });
        return data;
    }

    async _pollPaymentStatus(statusUrl) {
        this._polling = true;
        const pollStart = performance.now();
        let iteration = 0;

        while (this._polling) {
            iteration += 1;
            const reqStart = performance.now();
            let response;
            try {
                response = await fetch(statusUrl, {
                    method: "GET",
                    headers: this._getHeaders(),
                });
            } catch (e) {
                honeiLogger.error("poll_network_error", {
                    iteration,
                    duration_ms: Math.round(performance.now() - reqStart),
                    elapsed_ms: Math.round(performance.now() - pollStart),
                    message: e?.message || String(e),
                });
                throw e;
            }

            const reqDuration = Math.round(performance.now() - reqStart);

            if (!response.ok) {
                const error = await response.json().catch(() => ({}));
                honeiLogger.error("poll_http_error", {
                    iteration,
                    status: response.status,
                    duration_ms: reqDuration,
                    elapsed_ms: Math.round(performance.now() - pollStart),
                    error,
                });
                throw new Error(error.reason || error.message || `Error ${response.status}`);
            }

            const data = await response.json();
            honeiLogger.debug("poll_response", {
                iteration,
                status: data.status,
                duration_ms: reqDuration,
                elapsed_ms: Math.round(performance.now() - pollStart),
            });

            if (data.status !== "processing") {
                this._polling = false;
                honeiLogger.info("poll_finished", {
                    iterations: iteration,
                    final_status: data.status,
                    elapsed_ms: Math.round(performance.now() - pollStart),
                });
                return data;
            }

            await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
        }

        honeiLogger.info("poll_aborted", {
            iterations: iteration,
            elapsed_ms: Math.round(performance.now() - pollStart),
        });
        return { status: "cancelled" };
    }

    async confirm() {
        if (!this.props.venueApiKey?.trim()) {
            this.state.errorMessage = this._t("Venue API Key no configurada.");
            this.state.status = "error";
            honeiLogger.error("config_missing", { field: "venueApiKey" });
            return;
        }
        if (!this.props.integrationSecret?.trim()) {
            this.state.errorMessage = this._t("Odoo Integration Secret no configurado.");
            this.state.status = "error";
            honeiLogger.error("config_missing", { field: "integrationSecret" });
            return;
        }

        const terminalId = this.props.terminal.code;
        const amount = Math.abs(this.props.amount);
        const currency = this.props.currency;
        this._confirmStart = performance.now();
        honeiLogger.info("popup_confirm_start", {
            mode: this.props.mode,
            terminalId,
            terminalName: this.props.terminal.name,
            amount,
            currency,
            originalPaymentId: this.props.originalPaymentId || null,
        });

        try {
            this.state.status = "loading";
            this.state.errorMessage = "";
            this.state.cancelling = false;
            this.state.abortUrl = null;
            this._bindDismissHandler();

            if (this.isRefund) {
                this.state.statusMessage = this._t("Iniciando devolución...");
                const initResult = await this._initRefund(
                    terminalId,
                    this.props.originalPaymentId,
                    amount
                );
                this.state.abortUrl = initResult.refundAbortUrl || null;

                this.state.status = "processing";
                this.state.statusMessage = this._t(
                    "Esperando confirmación de devolución en el terminal..."
                );

                const statusResult = await this._pollPaymentStatus(initResult.refundStatusUrl);

                if (this._closed) {
                    return;
                }

                if (statusResult.status === "completed") {
                    this.state.status = "completed";
                    const apiResponse = {
                        transactionId: initResult.refundId,
                        status: "done",
                    };
                    honeiLogger.info("refund_completed", {
                        refundId: initResult.refundId,
                        total_ms: Math.round(performance.now() - this._confirmStart),
                    });
                    this.props.onConfirm(this.props.terminal, apiResponse);
                    this._close();
                } else {
                    const messages = {
                        declined: this._t("La devolución ha sido rechazada."),
                        not_completed: this._t("La devolución no se ha completado."),
                        timed_out: this._t("La devolución ha excedido el tiempo de espera."),
                        cancelled: this._t("La devolución ha sido cancelada."),
                    };
                    this.state.status = "error";
                    this.state.errorMessage =
                        messages[statusResult.status] ||
                        this._t("Error desconocido en la devolución.");
                    this._clearDismissHandler();
                    honeiLogger.warn("refund_not_completed", {
                        status: statusResult.status,
                        total_ms: Math.round(performance.now() - this._confirmStart),
                    });
                }
            } else {
                this.state.statusMessage = this._t("Iniciando pago...");
                const initResult = await this._initPayment(terminalId, amount, currency);
                this.state.abortUrl = initResult.paymentAbortUrl || null;

                this.state.status = "processing";
                this.state.statusMessage = this._t(
                    "Esperando confirmación en el terminal..."
                );

                const statusResult = await this._pollPaymentStatus(
                    initResult.paymentStatusUrl
                );

                if (this._closed) {
                    return;
                }

                if (statusResult.status === "completed") {
                    this.state.status = "completed";
                    const apiResponse = {
                        transactionId: initResult.paymentId,
                        status: "done",
                        tip: statusResult.tip || 0,
                    };
                    honeiLogger.info("payment_completed", {
                        paymentId: initResult.paymentId,
                        tip: statusResult.tip || 0,
                        total_ms: Math.round(performance.now() - this._confirmStart),
                    });
                    this.props.onConfirm(this.props.terminal, apiResponse);
                    this._close();
                } else {
                    const messages = {
                        declined: this._t("El pago ha sido rechazado."),
                        not_completed: this._t("El pago no se ha completado."),
                        timed_out: this._t("El pago ha excedido el tiempo de espera."),
                        cancelled: this._t("El pago ha sido cancelado."),
                    };
                    this.state.status = "error";
                    this.state.errorMessage =
                        messages[statusResult.status] ||
                        this._t("Error desconocido en el pago.");
                    this._clearDismissHandler();
                    honeiLogger.warn("payment_not_completed", {
                        status: statusResult.status,
                        total_ms: Math.round(performance.now() - this._confirmStart),
                    });
                }
            }
        } catch (error) {
            if (!this._closed) {
                this.state.status = "error";
                this.state.errorMessage =
                    error.message || this._t("Error de conexión con el servidor honei.");
                this._clearDismissHandler();
            }
            honeiLogger.error("popup_confirm_exception", {
                mode: this.props.mode,
                message: error?.message || String(error),
                stack: error?.stack || null,
                closed: this._closed,
                total_ms: this._confirmStart
                    ? Math.round(performance.now() - this._confirmStart)
                    : null,
            });
        }
    }

    async _abortPayment(abortUrl) {
        const t0 = performance.now();
        honeiLogger.info("abort_request", { mode: this.props.mode });
        const response = await fetch(abortUrl, {
            method: "DELETE",
            headers: this._getHeaders(),
        });
        const duration_ms = Math.round(performance.now() - t0);

        if (!response.ok) {
            const error = await response.json().catch(() => ({}));
            honeiLogger.error("abort_http_error", {
                status: response.status,
                duration_ms,
                error,
            });
            throw new Error(error.reason || error.message || `Error ${response.status}`);
        }
        honeiLogger.info("abort_response_ok", { duration_ms });
    }

    _close() {
        if (this._closed) {
            return;
        }
        this._closed = true;
        this._polling = false;
        this._clearDismissHandler();
        this.props.close();
    }

    async cancel() {
        if (
            this.state.abortUrl &&
            (this.state.status === "processing" || this.state.status === "loading")
        ) {
            this.state.cancelling = true;
            this.state.statusMessage = this.isRefund
                ? this._t("Cancelando devolución...")
                : this._t("Cancelando pago...");
            honeiLogger.info("user_cancel_requested", { mode: this.props.mode });
            try {
                await this._abortPayment(this.state.abortUrl);
            } catch (e) {
                honeiLogger.warn("abort_failed_continue_polling", {
                    message: e?.message || String(e),
                });
            }
            return;
        }

        honeiLogger.info("user_cancel_idle", { status: this.state.status });
        this._polling = false;
        this.props.onCancel();
        this._close();
    }
}
