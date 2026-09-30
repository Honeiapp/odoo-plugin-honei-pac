/** @odoo-module **/

/**
 * Browser client for the honei Terminal Local API (device-bridge).
 * https://integration.terminal.honei.app/api-reference/pay-at-counter-and-apk/local-api
 *
 * Requests carry a strictly increasing `counter` and an `hmac` (HMAC-SHA256
 * over every other field, sorted by name and joined as `k=v` with `&`, keyed
 * with the secret's raw UTF-8 bytes). Values are stringified like Dart's
 * `toString()` on the terminal.
 *
 * The terminal is linked with the plain-HTTP transport: a browser can't
 * accept its self-signed certificate. Chrome lets pages call private IPs over
 * HTTP (Local Network Access); the HMAC authenticates every message.
 *
 * SHA-256 is implemented here instead of using `crypto.subtle`, which only
 * exists in secure contexts and an on-premise Odoo is often served over plain
 * http on the LAN.
 */

const DEFAULT_PORT = 8743;
const REQUEST_TIMEOUT_MS = 10000;
const COUNTER_STORAGE_PREFIX = "honei_device_bridge_counter_";

// ---------------------------------------------------------------------------
// HMAC-SHA256
// ---------------------------------------------------------------------------

const K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function sha256(bytes) {
    const length = bytes.length;
    const padded = new Uint8Array(((length + 9 + 63) >> 6) << 6);
    padded.set(bytes);
    padded[length] = 0x80;
    const view = new DataView(padded.buffer);
    view.setUint32(padded.length - 8, Math.floor((length * 8) / 0x100000000));
    view.setUint32(padded.length - 4, (length * 8) >>> 0);

    const h = new Uint32Array([
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
    ]);
    const w = new Uint32Array(64);
    const rotr = (x, n) => (x >>> n) | (x << (32 - n));
    for (let offset = 0; offset < padded.length; offset += 64) {
        for (let i = 0; i < 16; i++) {
            w[i] = view.getUint32(offset + i * 4);
        }
        for (let i = 16; i < 64; i++) {
            const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
            const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
            w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
        }
        let [a, b, c, d, e, f, g, hh] = h;
        for (let i = 0; i < 64; i++) {
            const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
            const t1 = (hh + s1 + ((e & f) ^ (~e & g)) + K[i] + w[i]) >>> 0;
            const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
            const t2 = (s0 + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
            hh = g;
            g = f;
            f = e;
            e = (d + t1) >>> 0;
            d = c;
            c = b;
            b = a;
            a = (t1 + t2) >>> 0;
        }
        h[0] += a;
        h[1] += b;
        h[2] += c;
        h[3] += d;
        h[4] += e;
        h[5] += f;
        h[6] += g;
        h[7] += hh;
    }
    const out = new Uint8Array(32);
    const outView = new DataView(out.buffer);
    h.forEach((word, i) => outView.setUint32(i * 4, word));
    return out;
}

function hmacSha256Hex(key, message) {
    const encoder = new TextEncoder();
    let keyBytes = encoder.encode(key);
    if (keyBytes.length > 64) {
        keyBytes = sha256(keyBytes);
    }
    const block = new Uint8Array(64);
    block.set(keyBytes);
    const inner = new Uint8Array(64);
    const outer = new Uint8Array(64);
    for (let i = 0; i < 64; i++) {
        inner[i] = block[i] ^ 0x36;
        outer[i] = block[i] ^ 0x5c;
    }
    const messageBytes = encoder.encode(message);
    const innerInput = new Uint8Array(64 + messageBytes.length);
    innerInput.set(inner);
    innerInput.set(messageBytes, 64);
    const innerHash = sha256(innerInput);
    const outerInput = new Uint8Array(64 + 32);
    outerInput.set(outer);
    outerInput.set(innerHash, 64);
    return Array.from(sha256(outerInput), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

// ---------------------------------------------------------------------------
// Signing
// ---------------------------------------------------------------------------

/**
 * `rawNumbers` maps a field to its number exactly as written in the JSON the
 * terminal sent (Dart writes `0.0` where `JSON.parse` would give back `0`).
 */
export function canonicalize(fields, rawNumbers = {}) {
    return Object.keys(fields)
        .filter((key) => key !== "hmac")
        .sort()
        .map((key) => {
            const value = fields[key];
            const text =
                value === null || value === undefined
                    ? "null"
                    : typeof value === "number" && key in rawNumbers
                    ? rawNumbers[key]
                    : String(value);
            return `${key}=${text}`;
        })
        .join("&");
}

export function sign(fields, secret, rawNumbers) {
    return hmacSha256Hex(secret, canonicalize(fields, rawNumbers));
}

/** Parses a flat JSON object keeping the source text of its numbers. */
function parseResponse(text) {
    let data = {};
    try {
        data = JSON.parse(text);
    } catch {
        return { data: {}, rawNumbers: {} };
    }
    if (!data || typeof data !== "object" || Array.isArray(data)) {
        return { data: {}, rawNumbers: {} };
    }
    const rawNumbers = {};
    for (const [key, value] of Object.entries(data)) {
        if (typeof value === "number") {
            const match = text.match(
                new RegExp(`"${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"\\s*:\\s*(-?[0-9][0-9.eE+-]*)`)
            );
            if (match) {
                rawNumbers[key] = match[1];
            }
        }
    }
    return { data, rawNumbers };
}

export function verify(data, secret, rawNumbers) {
    return typeof data.hmac === "string" && data.hmac === sign(data, secret, rawNumbers);
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

export function baseUrl(host) {
    let value = (host || "").trim().replace(/^https?:\/\//, "").split("/")[0];
    if (!value.includes(":")) {
        value = `${value}:${DEFAULT_PORT}`;
    }
    return `http://${value}/device-bridge`;
}

/**
 * Strictly increasing per terminal, shared by every tab of this browser.
 * Epoch-ms based so another browser signing for the same terminal stays in
 * the same range; a request that loses that race gets `409 replayed`.
 */
function nextCounter(terminalKey) {
    const storageKey = `${COUNTER_STORAGE_PREFIX}${terminalKey}`;
    let last = 0;
    try {
        last = parseInt(localStorage.getItem(storageKey) || "0", 10) || 0;
    } catch {}
    const counter = Math.max(last + 1, Date.now());
    try {
        localStorage.setItem(storageKey, String(counter));
    } catch {}
    return counter;
}

async function fetchWithTimeout(url, options, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        // Marks it as a local-network request so Chrome exempts plain HTTP from
        // mixed-content blocking when the POS is served over HTTPS.
        return await fetch(url, {
            ...options,
            targetAddressSpace: "local",
            signal: controller.signal,
        });
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Unauthenticated liveness check, used to pick the local path before each
 * operation and as a keep-alive.
 */
export async function ping(host, timeoutMs = 1500) {
    if (!host) {
        return false;
    }
    try {
        const response = await fetchWithTimeout(`${baseUrl(host)}/health`, {}, timeoutMs);
        return response.ok;
    } catch {
        return false;
    }
}

/**
 * Signs and sends a request. Returns `{ http_status, data }`, or `{ error }`
 * when no valid response was obtained:
 *  - `not_configured`: no host or secret for this terminal.
 *  - `no_response`: network error or timeout. The terminal may or may not
 *    have received the request (the browser can't tell them apart).
 *  - `invalid_response_signature`: a 2xx response not signed with the secret.
 */
export async function request({ terminalKey, host, secret }, method, path, fields = {}) {
    if (!host || !secret) {
        return { error: "not_configured" };
    }
    const payload = { ...fields, counter: nextCounter(terminalKey) };
    payload.hmac = sign(payload, secret);

    let url = `${baseUrl(host)}${path}`;
    const options = { method };
    if (method === "GET") {
        url += `?${new URLSearchParams(
            Object.entries(payload).map(([key, value]) => [key, String(value)])
        )}`;
    } else {
        // text/plain keeps it a "simple" CORS request: the terminal parses the
        // body as JSON regardless of the content type.
        options.headers = { "Content-Type": "text/plain" };
        options.body = JSON.stringify(payload);
    }

    let response;
    let text;
    try {
        response = await fetchWithTimeout(url, options, REQUEST_TIMEOUT_MS);
        text = await response.text();
    } catch {
        return { error: "no_response" };
    }

    const { data, rawNumbers } = parseResponse(text);
    if (response.ok && !verify(data, secret, rawNumbers)) {
        return { error: "invalid_response_signature" };
    }
    delete data.hmac;
    return { http_status: response.status, data };
}
