/** @odoo-module **/

import { Navbar } from "@point_of_sale/app/components/navbar/navbar";
import { patch } from "@web/core/utils/patch";

patch(Navbar.prototype, {
    get honeiTerminals() {
        return this.pos
            .getHoneiTerminalsForCurrentConfig()
            .slice()
            .sort((a, b) => (a.name || "").localeCompare(b.name || ""));
    },

    get showHoneiTerminalMenu() {
        return this.honeiTerminals.length > 1;
    },

    isHoneiTerminalSelected(terminal) {
        return this.pos.honeiDefaultTerminalId === terminal.id;
    },

    selectHoneiTerminal(terminal) {
        const next = this.isHoneiTerminalSelected(terminal) ? null : terminal.id;
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
});
