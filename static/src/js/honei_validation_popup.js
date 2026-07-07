/** @odoo-module **/

import { _t } from "@web/core/l10n/translation";
import { Component, onMounted, onWillDestroy, useExternalListener, useState } from "@odoo/owl";
import { Dialog } from "@web/core/dialog/dialog";
import { honeiLogger } from "./honei_logger";

const POLL_INTERVAL_MS = 1000;
const IN_FLIGHT_STORAGE_PREFIX = "honei_in_flight_payment_pos_";
const IN_FLIGHT_TTL_MS = 24 * 60 * 60 * 1000;

let activeHoneiValidationPopup = null;

export function getActiveHoneiValidationPopup() {
    return activeHoneiValidationPopup;
}

function inFlightKey(posConfigId) {
    return `${IN_FLIGHT_STORAGE_PREFIX}${posConfigId}`;
}

export function saveInFlightHoneiPayment(posConfigId, state) {
    if (posConfigId == null) {
        return;
    }
    try {
        localStorage.setItem(inFlightKey(posConfigId), JSON.stringify(state));
    } catch (e) {
        honeiLogger.warn("inflight_save_failed", { message: e?.message || String(e) });
    }
}

export function loadInFlightHoneiPayment(posConfigId) {
    if (posConfigId == null) {
        return null;
    }
    try {
        const raw = localStorage.getItem(inFlightKey(posConfigId));
        if (!raw) {
            return null;
        }
        const state = JSON.parse(raw);
        if (!state || typeof state !== "object") {
            return null;
        }
        if (state.startedAt && Date.now() - state.startedAt > IN_FLIGHT_TTL_MS) {
            clearInFlightHoneiPayment(posConfigId);
            return null;
        }
        return state;
    } catch (e) {
        honeiLogger.warn("inflight_load_failed", { message: e?.message || String(e) });
        return null;
    }
}

export function clearInFlightHoneiPayment(posConfigId) {
    if (posConfigId == null) {
        return;
    }
    try {
        localStorage.removeItem(inFlightKey(posConfigId));
    } catch {}
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
        posConfigId: { type: Number, optional: true },
        orderUuid: { type: String, optional: true },
        paymentMethodId: { type: Number, optional: true },
        resumeState: { type: Object, optional: true },
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
        this._resumeConsumed = false;

        useExternalListener(
            window,
            "keydown",
            (ev) => {
                if (ev.key === "Escape") {
                    ev.preventDefault();
                    ev.stopPropagation();
                    ev.stopImmediatePropagation();
                }
            },
            { capture: true }
        );

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
            this.confirm();
        });

        onWillDestroy(() => {
            if (activeHoneiValidationPopup === this) {
                activeHoneiValidationPopup = null;
            }
        });
    }

    get isRefund() {
        return this.props.mode === "refund";
    }

    _persistInFlight({ transactionId, statusUrl, abortUrl }) {
        if (this.props.posConfigId == null || !this.props.orderUuid) {
            return;
        }
        saveInFlightHoneiPayment(this.props.posConfigId, {
            startedAt: Date.now(),
            mode: this.props.mode,
            transactionId,
            statusUrl,
            abortUrl,
            terminal: this.props.terminal,
            venueApiKey: this.props.venueApiKey || "",
            integrationSecret: this.props.integrationSecret || "",
            apiBaseUrl: this.props.apiBaseUrl || "",
            amount: this.props.amount,
            currency: this.props.currency,
            originalPaymentId: this.props.originalPaymentId || "",
            orderUuid: this.props.orderUuid,
            paymentMethodId: this.props.paymentMethodId ?? null,
        });
    }

    _clearInFlight() {
        if (this.props.posConfigId != null) {
            clearInFlightHoneiPayment(this.props.posConfigId);
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
                honeiLogger.warn("poll_network_error_retrying", {
                    iteration,
                    duration_ms: Math.round(performance.now() - reqStart),
                    elapsed_ms: Math.round(performance.now() - pollStart),
                    message: e?.message || String(e),
                });
                await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
                continue;
            }

            const reqDuration = Math.round(performance.now() - reqStart);

            if (!response.ok) {
                const isTransient = response.status >= 500 || response.status === 429;
                if (isTransient) {
                    honeiLogger.warn("poll_http_error_retrying", {
                        iteration,
                        status: response.status,
                        duration_ms: reqDuration,
                        elapsed_ms: Math.round(performance.now() - pollStart),
                    });
                    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
                    continue;
                }
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
            this.state.errorMessage = "";
            this.state.cancelling = false;
            this.state.abortUrl = null;

            const useResume = this.props.resumeState && !this._resumeConsumed;
            this._resumeConsumed = true;

            if (this.isRefund) {
                let initResult;
                if (useResume) {
                    initResult = {
                        refundId: this.props.resumeState.transactionId,
                        refundStatusUrl: this.props.resumeState.statusUrl,
                        refundAbortUrl: this.props.resumeState.abortUrl,
                    };
                    this.state.abortUrl = initResult.refundAbortUrl || null;
                    honeiLogger.info("popup_resumed", {
                        mode: "refund",
                        refundId: initResult.refundId,
                    });
                } else {
                    this.state.status = "loading";
                    this.state.statusMessage = this._t("Iniciando devolución...");
                    initResult = await this._initRefund(
                        terminalId,
                        this.props.originalPaymentId,
                        amount
                    );
                    this.state.abortUrl = initResult.refundAbortUrl || null;
                    this._persistInFlight({
                        transactionId: initResult.refundId,
                        statusUrl: initResult.refundStatusUrl,
                        abortUrl: initResult.refundAbortUrl || null,
                    });
                }

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
                    honeiLogger.warn("refund_not_completed", {
                        status: statusResult.status,
                        total_ms: Math.round(performance.now() - this._confirmStart),
                    });
                }
            } else {
                let initResult;
                if (useResume) {
                    initResult = {
                        paymentId: this.props.resumeState.transactionId,
                        paymentStatusUrl: this.props.resumeState.statusUrl,
                        paymentAbortUrl: this.props.resumeState.abortUrl,
                    };
                    this.state.abortUrl = initResult.paymentAbortUrl || null;
                    honeiLogger.info("popup_resumed", {
                        mode: "payment",
                        paymentId: initResult.paymentId,
                    });
                } else {
                    this.state.status = "loading";
                    this.state.statusMessage = this._t("Iniciando pago...");
                    initResult = await this._initPayment(terminalId, amount, currency);
                    this.state.abortUrl = initResult.paymentAbortUrl || null;
                    this._persistInFlight({
                        transactionId: initResult.paymentId,
                        statusUrl: initResult.paymentStatusUrl,
                        abortUrl: initResult.paymentAbortUrl || null,
                    });
                }

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
        this._clearInFlight();
        this.props.close();
    }

    async cancel() {
        if (
            this.state.abortUrl &&
            (this.state.status === "processing" || this.state.status === "loading")
        ) {
            if (this.state.cancelling) {
                honeiLogger.debug("cancel_ignored_already_cancelling");
                return;
            }
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
