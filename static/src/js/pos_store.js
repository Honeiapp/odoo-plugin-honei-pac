/** @odoo-module **/

import { patch } from "@web/core/utils/patch";
import { PosStore } from "@point_of_sale/app/services/pos_store";
import { getActiveHoneiValidationPopup } from "./honei_validation_popup";

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
    },

    setHoneiDefaultTerminalId(terminalId) {
        this.honeiDefaultTerminalId = terminalId;
        writeStoredHoneiTerminalId(this.config.id, terminalId);
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

        return terminals;
    },

    async onClickBackButton() {
        const honeiPopup = getActiveHoneiValidationPopup();
        if (honeiPopup) {
            await honeiPopup.cancel();
            return;
        }
        return super.onClickBackButton(...arguments);
    },
});
