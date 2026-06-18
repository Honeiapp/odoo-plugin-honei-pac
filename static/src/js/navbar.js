/** @odoo-module **/

import { Navbar } from "@point_of_sale/app/components/navbar/navbar";
import { patch } from "@web/core/utils/patch";
import { honeiLogger } from "./honei_logger";

patch(Navbar.prototype, {
    get honeiTerminals() {
        return this.pos
            .getHoneiTerminalsForCurrentConfig()
            .slice()
            .sort((a, b) => (a.name || "").localeCompare(b.name || ""));
    },

    get showHoneiTerminalMenu() {
        return this.honeiTerminals.length >= 1;
    },

    isHoneiTerminalSelected(terminal) {
        if (this.honeiTerminals.length === 1) {
            return true;
        }
        return this.pos.honeiDefaultTerminalId === terminal.id;
    },

    selectHoneiTerminal(terminal) {
        if (this.honeiTerminals.length === 1) {
            return;
        }
        const next = this.pos.honeiDefaultTerminalId === terminal.id ? null : terminal.id;
        this.pos.setHoneiDefaultTerminalId(next);
    },

    async refreshHoneiTerminals() {
        if (this.pos.getHoneiTerminalsForCurrentConfig().length === 0) {
            return;
        }
        try {
            await this.pos.syncHoneiTerminals();
        } catch {}
    },

    async downloadHoneiLogs() {
        try {
            await honeiLogger.export("txt");
        } catch (e) {
            console.error("[honei] download logs failed", e);
        }
    },
});
