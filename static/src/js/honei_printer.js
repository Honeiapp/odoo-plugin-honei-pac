/** @odoo-module **/

import { _t } from "@web/core/l10n/translation";
import { BasePrinter } from "@point_of_sale/app/utils/printer/base_printer";
import { honeiLogger } from "./honei_logger";

/**
 * Receipt printer backed by the thermal printer built into the honei terminal
 * (Castles S1F2 / PAX A920 Pro), through the cloud API:
 * `POST /terminals/{id}/print-ticket`.
 *
 * Odoo renders its own receipt (the same one it would send to an Epson or IoT
 * printer, with every localisation's content: simplified invoice number, tax
 * breakdown, VERI*FACTU QR...) to an image, and we send that image as the only
 * block of the ticket. honei rasterises it at the terminal's 58 mm width.
 */

// The backend lays the ticket out at 384 px (58 mm at 203 dpi) with 4 px side
// padding, so an image this wide prints at 1 px per dot, without rescaling.
const RECEIPT_WIDTH_CLASS = "honei-receipt-58mm";
const REQUEST_TIMEOUT_MS = 20000;

export class HoneiPrinter extends BasePrinter {
    setup({ terminalId, terminalName, apiBaseUrl, venueApiKey, integrationSecret }) {
        super.setup(...arguments);
        this.terminalId = terminalId;
        this.terminalName = terminalName;
        this.apiBaseUrl = apiBaseUrl;
        this.venueApiKey = venueApiKey;
        this.integrationSecret = integrationSecret;
    }

    async printReceipt(receipt) {
        receipt?.classList?.add(RECEIPT_WIDTH_CLASS);
        return super.printReceipt(receipt);
    }

    /** PNG instead of Odoo's JPEG: no compression artefacts on a thermal head. */
    processCanvas(canvas) {
        return canvas.toDataURL("image/png");
    }

    async sendPrintingJob(imageDataUrl) {
        const url = `${this.apiBaseUrl}/terminals/${this.terminalId}/print-ticket`;
        const t0 = performance.now();
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
        let response;
        try {
            response = await fetch(url, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${this.integrationSecret}`,
                    "venue-api-key": this.venueApiKey,
                },
                body: JSON.stringify({
                    ticket: {
                        root: {
                            type: "column",
                            children: [{ type: "image", src: imageDataUrl }],
                        },
                    },
                }),
                signal: controller.signal,
            });
        } catch (e) {
            honeiLogger.error("print_ticket_network_error", {
                terminalId: this.terminalId,
                duration_ms: Math.round(performance.now() - t0),
                message: e?.message || String(e),
            });
            throw e;
        } finally {
            clearTimeout(timer);
        }

        const duration_ms = Math.round(performance.now() - t0);
        if (!response.ok) {
            const error = await response.json().catch(() => ({}));
            honeiLogger.error("print_ticket_http_error", {
                terminalId: this.terminalId,
                status: response.status,
                duration_ms,
                error,
            });
            return {
                result: false,
                status: response.status,
                message: error.message || error.reason || `Error ${response.status}`,
            };
        }

        honeiLogger.info("print_ticket_sent", {
            terminalId: this.terminalId,
            duration_ms,
            bytes: imageDataUrl.length,
        });
        return { result: true };
    }

    openCashbox() {
        // The terminal has no cash drawer.
    }

    getActionError() {
        return {
            successful: false,
            canRetry: true,
            message: {
                title: _t("No se ha podido contactar con honei"),
                body: _t(
                    "Comprueba la conexión a Internet de la caja y vuelve a intentarlo."
                ),
            },
        };
    }

    getResultsError(printResult) {
        return {
            successful: false,
            canRetry: true,
            message: {
                title: _t("El terminal %s no ha podido imprimir", this.terminalName),
                body: _t(
                    "Comprueba que el terminal está encendido, con la app honei Terminal abierta y conectado a Internet. (%s)",
                    printResult?.message || _t("sin respuesta")
                ),
            },
        };
    }
}
