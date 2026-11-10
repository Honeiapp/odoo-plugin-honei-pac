/** @odoo-module **/

import { patch } from "@web/core/utils/patch";
import { PosStore } from "@point_of_sale/app/services/pos_store";
import {
    getActiveHoneiValidationPopup,
    loadInFlightHoneiPayment,
    clearInFlightHoneiPayment,
} from "./honei_validation_popup";
import { honeiLogger } from "./honei_logger";
import * as deviceBridge from "./device_bridge_client";
import { HoneiPrinter } from "./honei_printer";

const LOCAL_PING_INTERVAL_MS = 20000;

const HONEI_DEFAULT_TERMINAL_KEY_PREFIX = "honei_default_terminal_pos_";

function readStoredHoneiTerminalId(configId) {
    try {
        const raw = localStorage.getItem(HONEI_DEFAULT_TERMINAL_KEY_PREFIX + configId);
        if (!raw) {
            return null;
        }
        const parsed = parseInt(raw, 10);
        return Number.isFinite(parsed) ? parsed : null;
    } catch {
        return null;
    }
}

function writeStoredHoneiTerminalId(configId, terminalId) {
    try {
        const key = HONEI_DEFAULT_TERMINAL_KEY_PREFIX + configId;
        if (terminalId == null) {
            localStorage.removeItem(key);
        } else {
            localStorage.setItem(key, String(terminalId));
        }
    } catch {}
}

patch(PosStore.prototype, {
    async setup() {
        await super.setup(...arguments);
        this.honeiDefaultTerminalId = readStoredHoneiTerminalId(this.config.id);
        this.honeiPaymentInProgress = false;
        this.pendingHoneiResume = null;
        // terminal id -> whether it answered the last ping over the local network.
        this.honeiLocalReachable = {};
        // Receipt printer configured by Odoo (Epson, IoT...), restored when the
        // default terminal doesn't print.
        this._honeiFallbackPrinter = this.hardwareProxy.printer;
        this.applyHoneiPrinter();
        this._maybeQueueHoneiResume();
        this._startHoneiLocalPing();
    },

    /** The terminal this register prints on: its default (or only) terminal. */
    getHoneiPrintTerminal() {
        const terminals = this.getHoneiTerminalsForCurrentConfig();
        const terminal =
            terminals.length === 1
                ? terminals[0]
                : terminals.find((t) => t.id === this.honeiDefaultTerminalId);
        return terminal?.use_integrated_printer ? terminal : null;
    },

    /**
     * Routes receipts to the default terminal's built-in printer when it has
     * one enabled, and back to Odoo's own printer otherwise.
     */
    applyHoneiPrinter() {
        const terminal = this.getHoneiPrintTerminal();
        const method = this.models["pos.payment.method"]
            ?.getAll()
            .find(
                (m) =>
                    m.is_honei_payment &&
                    m.venue_api_key?.trim() &&
                    m.odoo_integration_secret?.trim()
            );
        const current = this.hardwareProxy.printer;

        if (!terminal || !method) {
            if (terminal && !method) {
                honeiLogger.warn("integrated_printer_no_credentials", {
                    terminalId: terminal.terminal_id,
                });
            }
            if (current instanceof HoneiPrinter) {
                this.hardwareProxy.printer = this._honeiFallbackPrinter;
                honeiLogger.info("integrated_printer_disabled");
            }
            return;
        }

        if (current instanceof HoneiPrinter && current.terminalId === terminal.terminal_id) {
            return;
        }
        this.hardwareProxy.printer = new HoneiPrinter({
            terminalId: terminal.terminal_id,
            terminalName: terminal.name,
            apiBaseUrl: method.is_staging
                ? "https://staging.api.honei.app/v1"
                : "https://api.honei.app/v1",
            venueApiKey: method.venue_api_key.trim(),
            integrationSecret: method.odoo_integration_secret.trim(),
        });
        honeiLogger.info("integrated_printer_enabled", { terminalId: terminal.terminal_id });
    },

    /** Keeps the local terminals awake and their reachability up to date. */
    _startHoneiLocalPing() {
        const usesLocal = this.models["pos.payment.method"]
            ?.getAll()
            .some((m) => m.is_honei_payment && m.honei_integration_mode === "local");
        if (!usesLocal) {
            return;
        }
        const pingAll = async () => {
            for (const terminal of this.getHoneiTerminalsForCurrentConfig()) {
                if (terminal.local_host) {
                    this.setHoneiLocalReachable(
                        terminal.id,
                        await deviceBridge.ping(terminal.local_host)
                    );
                }
            }
        };
        pingAll();
        setInterval(pingAll, LOCAL_PING_INTERVAL_MS);
    },

    setHoneiLocalReachable(terminalId, reachable) {
        if (this.honeiLocalReachable[terminalId] !== reachable) {
            honeiLogger.info("local_reachability_changed", { terminalId, reachable });
        }
        this.honeiLocalReachable[terminalId] = reachable;
    },

    _maybeQueueHoneiResume() {
        const state = loadInFlightHoneiPayment(this.config.id);
        if (!state) {
            return;
        }
        const order = this.models["pos.order"]?.find(
            (o) => o.uuid === state.orderUuid
        );
        if (!order) {
            honeiLogger.warn("inflight_resume_order_missing", {
                orderUuid: state.orderUuid,
                mode: state.mode,
            });
            clearInFlightHoneiPayment(this.config.id);
            return;
        }
        honeiLogger.info("inflight_resume_queued", {
            orderUuid: state.orderUuid,
            mode: state.mode,
            transactionId: state.transactionId,
        });
        this.pendingHoneiResume = state;
        this.honeiPaymentInProgress = true;
        this.setOrder(order);
        this.navigate("PaymentScreen", { orderUuid: order.uuid });
    },

    tryReserveHoneiPayment() {
        if (this.honeiPaymentInProgress) {
            return false;
        }
        this.honeiPaymentInProgress = true;
        return true;
    },

    releaseHoneiPayment() {
        this.honeiPaymentInProgress = false;
    },

    setHoneiDefaultTerminalId(terminalId) {
        this.honeiDefaultTerminalId = terminalId;
        writeStoredHoneiTerminalId(this.config.id, terminalId);
        this.applyHoneiPrinter();
    },

    getHoneiTerminalsForCurrentConfig() {
        const terminalModel = this.models["pos.config.honei_terminal"];
        const configId = this.config.id;
        return (terminalModel?.getAll() || []).filter(
            (terminal) => terminal.pos_config_id?.id === configId
        );
    },

    async syncHoneiTerminals() {
        const terminalModel = this.models["pos.config.honei_terminal"];
        const configId = this.config.id;
        const localIds = (terminalModel?.getAll() || [])
            .filter((terminal) => terminal.pos_config_id?.id === configId)
            .map((terminal) => terminal.id);

        const syncResult = await this.data.call(
            "pos.config",
            "sync_honei_terminals_pos_data",
            [[configId], localIds]
        );

        if (syncResult) {
            for (const terminalId of syncResult.remove_ids || []) {
                const record = terminalModel?.get(terminalId);
                if (record) {
                    record.delete({ silent: true });
                }
            }

            if (syncResult.records?.length) {
                this.models.connectNewData({
                    "pos.config.honei_terminal": syncResult.records,
                });
            }
        }

        const terminals = this.getHoneiTerminalsForCurrentConfig();
        const validIds = new Set(terminals.map((t) => t.id));
        if (
            this.honeiDefaultTerminalId != null &&
            !validIds.has(this.honeiDefaultTerminalId)
        ) {
            this.setHoneiDefaultTerminalId(null);
        }
        // The print flag may have changed in the backend.
        this.applyHoneiPrinter();

        return terminals;
    },

    async onClickBackButton() {
        if (getActiveHoneiValidationPopup()) {
            return;
        }
        return super.onClickBackButton(...arguments);
    },
});
