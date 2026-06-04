/** @odoo-module **/

import { _t } from "@web/core/l10n/translation";
import { Component, onMounted, onWillDestroy, useState } from "@odoo/owl";
import { Dialog } from "@web/core/dialog/dialog";

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
        const response = await fetch(url, {
            method: "POST",
            headers: this._getHeaders(),
            body: JSON.stringify({ amount, currency }),
        });

        if (!response.ok) {
            const error = await response.json().catch(() => ({}));
            throw new Error(error.message || error.reason || `Error ${response.status}`);
        }

        return await response.json();
    }

    async _initRefund(terminalId, paymentId, amount) {
        const url = `${this.props.apiBaseUrl || ""}/terminals/${terminalId}/payments/${paymentId}/init-refund`;
        const response = await fetch(url, {
            method: "POST",
            headers: this._getHeaders(),
            body: JSON.stringify({ amount }),
        });

        if (!response.ok) {
            const error = await response.json().catch(() => ({}));
            throw new Error(error.message || error.reason || `Error ${response.status}`);
        }

        return await response.json();
    }

    async _pollPaymentStatus(statusUrl) {
        this._polling = true;

        while (this._polling) {
            const response = await fetch(statusUrl, {
                method: "GET",
                headers: this._getHeaders(),
            });

            if (!response.ok) {
                const error = await response.json().catch(() => ({}));
                throw new Error(error.reason || error.message || `Error ${response.status}`);
            }

            const data = await response.json();

            if (data.status !== "processing") {
                this._polling = false;
                return data;
            }

            await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
        }

        return { status: "cancelled" };
    }

    async confirm() {
        if (!this.props.venueApiKey?.trim()) {
            this.state.errorMessage = this._t("Venue API Key no configurada.");
            this.state.status = "error";
            return;
        }
        if (!this.props.integrationSecret?.trim()) {
            this.state.errorMessage = this._t("Odoo Integration Secret no configurado.");
            this.state.status = "error";
            return;
        }

        const terminalId = this.props.terminal.code;
        const amount = Math.abs(this.props.amount);
        const currency = this.props.currency;

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
                }
            }
        } catch (error) {
            if (!this._closed) {
                this.state.status = "error";
                this.state.errorMessage =
                    error.message || this._t("Error de conexión con el servidor honei.");
                this._clearDismissHandler();
            }
        }
    }

    async _abortPayment(abortUrl) {
        const response = await fetch(abortUrl, {
            method: "DELETE",
            headers: this._getHeaders(),
        });

        if (!response.ok) {
            const error = await response.json().catch(() => ({}));
            throw new Error(error.reason || error.message || `Error ${response.status}`);
        }
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
            try {
                await this._abortPayment(this.state.abortUrl);
            } catch {
                // If abort fails, let polling continue and show the result.
            }
            // Don't stop polling or close: the ongoing GET will pick up the error status.
            return;
        }

        this._polling = false;
        this.props.onCancel();
        this._close();
    }
}
