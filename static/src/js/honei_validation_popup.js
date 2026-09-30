/** @odoo-module **/

import { _t } from "@web/core/l10n/translation";
import { Component, onMounted, onWillDestroy, useExternalListener, useState } from "@odoo/owl";
import { Dialog } from "@web/core/dialog/dialog";
import { ConfirmationDialog } from "@web/core/confirmation_dialog/confirmation_dialog";
import { useService } from "@web/core/utils/hooks";
import * as deviceBridge from "./device_bridge_client";
import { honeiLogger } from "./honei_logger";

const POLL_INTERVAL_MS = 1000;
// The terminal may have received the request but its response was lost.
const UNKNOWN_OUTCOME_ERRORS = ["no_response", "invalid_response_signature"];
// `replayed` means two requests crossed on the counter: retried silently.
const MAX_REPLAYED_RETRIES = 3;
const EXIT_BUTTON_AFTER_MS = 2 * 60 * 1000;

function generateLocalRef(prefix) {
    // Only [A-Za-z0-9-]: it travels in the Local API URL path.
    const random = Math.random().toString(36).slice(2, 10);
    return `odoo-${prefix}-${Date.now().toString(36)}-${random}`;
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
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
        integrationMode: { type: String, optional: true },
        localHost: { type: String, optional: true },
        localSecret: { type: String, optional: true },
    };

    static defaultProps = {
        title: _t("Procesando pago honei"),
        cancelText: _t("Cancelar"),
        currency: "EUR",
        onConfirm: () => {},
        onCancel: () => {},
        mode: "payment",
        originalPaymentId: "",
        integrationMode: "cloud",
    };

    setup() {
        this.state = useState({
            status: "idle",
            errorMessage: "",
            statusMessage: "",
            cancelling: false,
            abortUrl: null,
            localAbortable: false,
            showExit: false,
        });
        this._exitTimer = null;

        this._t = _t;
        this.dialogService = useService("dialog");
        this._pendingLocalRef = null;
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
            clearTimeout(this._exitTimer);
            if (activeHoneiValidationPopup === this) {
                activeHoneiValidationPopup = null;
            }
        });
    }

    get isRefund() {
        return this.props.mode === "refund";
    }

    get isLocal() {
        return this.props.integrationMode === "local";
    }

    _persistInFlight({ transactionId, statusUrl, abortUrl, localRef = null }) {
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
            integrationMode: this.props.integrationMode || "cloud",
            localRef,
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

    _armExitTimer() {
        clearTimeout(this._exitTimer);
        this.state.showExit = false;
        this._exitTimer = setTimeout(() => {
            if (this._polling && !this._closed) {
                honeiLogger.warn("exit_button_shown", { mode: this.props.mode });
                this.state.showExit = true;
            }
        }, EXIT_BUTTON_AFTER_MS);
    }

    exitWithoutWaiting() {
        this.dialogService.add(ConfirmationDialog, {
            title: this.isRefund
                ? this._t("¿Salir sin esperar la devolución?")
                : this._t("¿Salir sin esperar el pago?"),
            body: this.isRefund
                ? this._t(
                      "La devolución puede seguir en curso en el terminal. Si sales ahora, Odoo no registrará su resultado aunque se complete. Comprueba en el terminal que no se ha realizado antes de salir."
                  )
                : this._t(
                      "El cobro puede seguir en curso en el terminal. Si sales ahora, Odoo no registrará el pago aunque se complete. Comprueba en el terminal que no se ha cobrado antes de salir."
                  ),
            confirmLabel: this._t("Salir"),
            cancelLabel: this._t("Seguir esperando"),
            confirm: () => {
                honeiLogger.warn("user_exit_without_waiting", {
                    mode: this.props.mode,
                    integration: this.props.integrationMode,
                    ref: this._pendingLocalRef,
                });
                this._pendingLocalRef = null;
                this._polling = false;
                this.props.onCancel();
                this._close();
            },
            cancel: () => {},
        });
    }

    async _pollPaymentStatus(statusUrl) {
        this._polling = true;
        this._armExitTimer();
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

    _localErrorMessage(result) {
        const errors = {
            not_configured: this._t(
                "El terminal no tiene IP local o no está vinculado. Revisa la configuración del punto de venta."
            ),
            no_response: this._t("No se ha podido conectar con el terminal en la red local."),
            invalid_response_signature: this._t(
                "La respuesta del terminal no tiene una firma válida."
            ),
        };
        if (result?.error) {
            return errors[result.error] || result.error;
        }
        const reasons = {
            busy: this._t("El terminal está ocupado con otra operación."),
            invalid_signature: this._t(
                "El terminal ha rechazado la firma. Vuelve a vincular el terminal."
            ),
            not_provisioned: this._t(
                "El terminal no tiene clave de integración local. Vincúlalo desde la configuración."
            ),
            replayed: this._t("El terminal ha rechazado la petición (contador). Reinténtalo."),
            invalid_amount: this._t("Importe no válido."),
            invalid_request: this._t("Petición no válida."),
            not_found: this._t("El terminal no conoce esta operación."),
        };
        const reason = result?.data?.reason;
        return (
            reasons[reason] ||
            result?.data?.errorMessage ||
            reason ||
            `Error ${result?.http_status ?? ""}`.trim()
        );
    }

    async _localCall(method, args) {
        const t0 = performance.now();
        const terminal = {
            terminalKey: this.props.terminal.id,
            host: this.props.localHost,
            secret: this.props.localSecret,
        };
        const [ref, ...rest] = args;
        let result;
        switch (method) {
            case "init_payment":
                result = await deviceBridge.request(terminal, "POST", "/init-payment", {
                    ref,
                    amount: rest[0],
                });
                break;
            case "init_refund":
                result = await deviceBridge.request(terminal, "POST", `/payments/${ref}/refund`, {
                    paymentId: rest[0],
                    amount: rest[1],
                });
                break;
            case "abort":
                result = await deviceBridge.request(terminal, "POST", `/payments/${ref}/abort`);
                break;
            default:
                result = await deviceBridge.request(terminal, "GET", `/payments/${ref}/status`);
        }
        honeiLogger.debug("local_call", {
            method,
            duration_ms: Math.round(performance.now() - t0),
            http_status: result?.http_status ?? null,
            error: result?.error || null,
            status: result?.data?.status || null,
            reason: result?.data?.reason || null,
        });
        return result;
    }

    /**
     * Returns the data when the terminal accepted the operation. Otherwise throws,
     * flagged `honeiDefinitive` when nothing was started; unflagged when the
     * outcome is unknown and "Reintentar" must poll the same ref.
     */
    async _localInit(ref, amount) {
        honeiLogger.info(this.isRefund ? "local_init_refund_request" : "local_init_payment_request", {
            ref,
            amount,
            terminalId: this.props.terminal.code,
            originalPaymentId: this.props.originalPaymentId || null,
        });
        amount = Math.round(Math.abs(amount) * 100) / 100;
        let result;
        for (let attempt = 0; attempt <= MAX_REPLAYED_RETRIES; attempt++) {
            result = this.isRefund
                ? await this._localCall("init_refund", [ref, this.props.originalPaymentId, amount])
                : await this._localCall("init_payment", [ref, amount]);
            // Another till signed for this terminal in between: nothing was
            // started, resend with a fresh counter.
            if (!(result?.http_status === 409 && result?.data?.reason === "replayed")) {
                break;
            }
            honeiLogger.warn("local_init_replayed_retrying", { ref, attempt });
        }
        const status = result?.http_status;
        if (status === 202 || status === 200) {
            honeiLogger.info("local_init_accepted", { ref, http_status: status, data: result.data });
            this.state.localAbortable = !!result.data?.abortable;
            return result.data;
        }
        if (UNKNOWN_OUTCOME_ERRORS.includes(result?.error)) {
            honeiLogger.warn("local_init_no_response", { ref, error: result.error });
            throw this._unknownOutcomeError(this._localErrorMessage(result));
        }
        honeiLogger.error("local_init_failed", { ref, result });
        const error = new Error(this._localErrorMessage(result));
        error.honeiDefinitive = true;
        throw error;
    }

    _unknownOutcomeError(message) {
        return new Error(
            `${message} ${
                this.isRefund
                    ? this._t(
                          "Comprueba en el terminal si la devolución se ha completado y pulsa Reintentar para consultarla."
                      )
                    : this._t(
                          "Comprueba en el terminal si el cobro se ha completado y pulsa Reintentar para consultarlo."
                      )
            }`
        );
    }

    async _pollLocalStatus(ref, amount) {
        this._polling = true;
        this._armExitTimer();
        const pollStart = performance.now();
        let iteration = 0;
        let reinitTried = false;
        let replayedRetries = 0;

        while (this._polling) {
            iteration += 1;
            const result = await this._localCall("status", [ref]);

            if (
                result?.http_status === 409 &&
                result?.data?.reason === "replayed" &&
                replayedRetries < MAX_REPLAYED_RETRIES
            ) {
                replayedRetries += 1;
                honeiLogger.warn("local_poll_replayed_retrying", { iteration });
                await sleep(POLL_INTERVAL_MS);
                continue;
            }

            if (result?.error || result?.http_status >= 500) {
                // The operation was already started: keep the ref pending so
                // "Reintentar" polls it again.
                honeiLogger.warn("local_poll_terminal_error", { iteration, result });
                throw this._unknownOutcomeError(this._localErrorMessage(result));
            }

            if (result?.http_status === 404 && !reinitTried) {
                // The init never reached the terminal. Refs are idempotent, so
                // resending it can't cause a second charge.
                reinitTried = true;
                honeiLogger.warn("local_poll_not_found_reinit", { ref });
                const initData = await this._localInit(ref, amount);
                if (initData && initData.status && initData.status !== "processing") {
                    this._polling = false;
                    return initData;
                }
                continue;
            }

            if (result?.http_status !== 200) {
                throw new Error(this._localErrorMessage(result));
            }

            const data = result.data || {};
            this.state.localAbortable = data.status === "processing" && !!data.abortable;
            if (data.status !== "processing") {
                this._polling = false;
                honeiLogger.info("local_poll_finished", {
                    iterations: iteration,
                    final_status: data.status,
                    elapsed_ms: Math.round(performance.now() - pollStart),
                });
                return data;
            }
            if (!this.state.cancelling) {
                this.state.statusMessage = this.isRefund
                    ? this._t("Esperando confirmación de devolución en el terminal...")
                    : this._t("Esperando confirmación en el terminal...");
            }
            await sleep(POLL_INTERVAL_MS);
        }

        honeiLogger.info("local_poll_aborted", { iterations: iteration });
        return { status: "cancelled" };
    }

    async _confirmLocal(amount) {
        if (this.props.resumeState && !this._resumeConsumed) {
            this._pendingLocalRef = this.props.resumeState.localRef || null;
            honeiLogger.info("popup_resumed", {
                mode: this.props.mode,
                integration: "local",
                ref: this._pendingLocalRef,
            });
        }
        this._resumeConsumed = true;

        // Never start a new operation while a previous one may still be
        // running on the terminal: poll its ref instead.
        let ref = this._pendingLocalRef;
        if (!ref) {
            ref = generateLocalRef(this.isRefund ? "r" : "p");
            this._pendingLocalRef = ref;
            // Persisted before the init so a reload resumes this same ref.
            this._persistInFlight({
                transactionId: null,
                statusUrl: null,
                abortUrl: null,
                localRef: ref,
            });
            this.state.status = "loading";
            this.state.statusMessage = this.isRefund
                ? this._t("Iniciando devolución...")
                : this._t("Iniciando pago...");
            let initData;
            try {
                initData = await this._localInit(ref, amount);
            } catch (e) {
                if (e.honeiDefinitive) {
                    this._pendingLocalRef = null;
                    this._clearInFlight();
                }
                throw e;
            }
            if (initData?.status === "declined") {
                // Refund not allowed: declined before reaching the card reader.
                this._pendingLocalRef = null;
                this._clearInFlight();
                this.state.status = "error";
                this.state.errorMessage =
                    initData.reason || this._t("La devolución ha sido rechazada.");
                return;
            }
        }

        this.state.status = "processing";
        this.state.statusMessage = this.isRefund
            ? this._t("Esperando confirmación de devolución en el terminal...")
            : this._t("Esperando confirmación en el terminal...");

        const statusResult = await this._pollLocalStatus(ref, amount);
        if (this._closed) {
            return;
        }
        this._pendingLocalRef = null;

        if (statusResult.status === "completed") {
            this.state.status = "completed";
            const transactionId = this.isRefund
                ? statusResult.refundId || ref
                : statusResult.paymentId || ref;
            if (!this.isRefund && !statusResult.paymentId) {
                honeiLogger.warn("local_payment_without_payment_id", { ref });
            }
            const apiResponse = {
                transactionId,
                status: "done",
                tip: statusResult.tip || 0,
            };
            honeiLogger.info(this.isRefund ? "refund_completed" : "payment_completed", {
                integration: "local",
                ref,
                transactionId,
                tip: statusResult.tip || 0,
                total_ms: Math.round(performance.now() - this._confirmStart),
            });
            this.props.onConfirm(this.props.terminal, apiResponse);
            this._close();
            return;
        }

        this._clearInFlight();
        const messages = this.isRefund
            ? {
                  declined: this._t("La devolución ha sido rechazada."),
                  cancelled: this._t("La devolución ha sido cancelada."),
                  timed_out: this._t("La devolución ha excedido el tiempo de espera."),
                  not_completed: this._t("La devolución no se ha completado."),
              }
            : {
                  declined: this._t("El pago ha sido rechazado."),
                  cancelled: this._t("El pago ha sido cancelado."),
                  timed_out: this._t("El pago ha excedido el tiempo de espera."),
                  not_completed: this._t("El pago no se ha completado."),
              };
        this.state.status = "error";
        this.state.errorMessage =
            messages[statusResult.status] ||
            statusResult.reason ||
            (this.isRefund
                ? this._t("Error desconocido en la devolución.")
                : this._t("Error desconocido en el pago."));
        honeiLogger.warn(this.isRefund ? "refund_not_completed" : "payment_not_completed", {
            integration: "local",
            ref,
            status: statusResult.status,
            errorMessage: statusResult.errorMessage || null,
        });
    }

    async confirm() {
        if (this.isLocal) {
            this._confirmStart = performance.now();
            const amount = Math.abs(this.props.amount);
            honeiLogger.info("popup_confirm_start", {
                mode: this.props.mode,
                integration: "local",
                terminalId: this.props.terminal.code,
                terminalName: this.props.terminal.name,
                amount,
                originalPaymentId: this.props.originalPaymentId || null,
            });
            this.state.errorMessage = "";
            this.state.cancelling = false;
            this.state.abortUrl = null;
            this.state.localAbortable = false;
            try {
                await this._confirmLocal(amount);
            } catch (error) {
                if (!this._closed) {
                    this.state.status = "error";
                    this.state.errorMessage =
                        error?.data?.message ||
                        error?.message ||
                        this._t("Error de conexión con el terminal.");
                }
                honeiLogger.error("popup_confirm_exception", {
                    mode: this.props.mode,
                    integration: "local",
                    message: error?.message || String(error),
                    stack: error?.stack || null,
                    closed: this._closed,
                });
            }
            return;
        }

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

    async _abortLocal() {
        if (this.state.cancelling) {
            honeiLogger.debug("cancel_ignored_already_cancelling");
            return;
        }
        const ref = this._pendingLocalRef;
        this.state.cancelling = true;
        this.state.statusMessage = this.isRefund
            ? this._t("Cancelando devolución...")
            : this._t("Cancelando pago...");
        honeiLogger.info("user_cancel_requested", { mode: this.props.mode, integration: "local", ref });
        let result;
        try {
            result = await this._localCall("abort", [ref]);
        } catch (e) {
            result = { error: e?.message || String(e) };
        }
        if (result?.http_status === 202) {
            // The operation settles as cancelled/declined; polling picks it up.
            honeiLogger.info("abort_response_ok", { ref });
            return;
        }
        honeiLogger.warn("abort_failed_continue_polling", { ref, result });
        this.state.cancelling = false;
        this.state.statusMessage = this._t(
            "No se ha podido cancelar desde Odoo. Cancela la operación desde el terminal."
        );
    }

    async cancel() {
        if (
            this.isLocal &&
            this.state.localAbortable &&
            this._pendingLocalRef &&
            this.state.status === "processing"
        ) {
            await this._abortLocal();
            return;
        }
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

        if (this.isLocal && this._pendingLocalRef) {
            // Unknown outcome: the charge may still complete on the terminal.
            honeiLogger.warn("user_cancel_pending_unknown_outcome", {
                ref: this._pendingLocalRef,
            });
            this.dialogService.add(ConfirmationDialog, {
                title: this.isRefund
                    ? this._t("¿Descartar la devolución?")
                    : this._t("¿Descartar el cobro?"),
                body: this.isRefund
                    ? this._t(
                          "No se sabe si la devolución se ha completado. Comprueba en el terminal que NO se ha hecho antes de descartarla; si se hizo, Odoo no la registrará."
                      )
                    : this._t(
                          "No se sabe si el cobro se ha completado. Comprueba en el terminal que NO se ha cobrado antes de descartarlo; si se cobró, Odoo no lo registrará."
                      ),
                confirmLabel: this._t("Descartar"),
                cancelLabel: this._t("Volver"),
                confirm: () => {
                    honeiLogger.warn("user_cancel_pending_confirmed", {
                        ref: this._pendingLocalRef,
                    });
                    this._pendingLocalRef = null;
                    this._polling = false;
                    this.props.onCancel();
                    this._close();
                },
                cancel: () => {},
            });
            return;
        }

        honeiLogger.info("user_cancel_idle", { status: this.state.status });
        this._polling = false;
        this.props.onCancel();
        this._close();
    }
}
