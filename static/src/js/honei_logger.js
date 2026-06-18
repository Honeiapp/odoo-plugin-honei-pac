/** @odoo-module **/

const DB_NAME = "honei_logs_db";
const DB_VERSION = 1;
const STORE_NAME = "logs";
const MAX_BYTES = 10 * 1024 * 1024;
const TRIM_TARGET_BYTES = 8 * 1024 * 1024;
const ROTATE_CHECK_EVERY = 50;

let dbPromise = null;
let totalBytes = 0;
let initialized = false;
let insertsSinceCheck = 0;
let pendingFlush = null;
const queue = [];

const SESSION_ID =
    (typeof crypto !== "undefined" && crypto.randomUUID && crypto.randomUUID()) ||
    `s-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

function openDb() {
    if (dbPromise) {
        return dbPromise;
    }
    dbPromise = new Promise((resolve, reject) => {
        let req;
        try {
            req = indexedDB.open(DB_NAME, DB_VERSION);
        } catch (e) {
            reject(e);
            return;
        }
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                db.createObjectStore(STORE_NAME, { keyPath: "id", autoIncrement: true });
            }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
    return dbPromise;
}

function entrySize(entry) {
    try {
        return JSON.stringify(entry).length;
    } catch {
        return 200;
    }
}

async function recomputeSize() {
    try {
        const db = await openDb();
        await new Promise((resolve) => {
            const tx = db.transaction(STORE_NAME, "readonly");
            const store = tx.objectStore(STORE_NAME);
            let size = 0;
            const cursorReq = store.openCursor();
            cursorReq.onsuccess = (e) => {
                const cursor = e.target.result;
                if (cursor) {
                    size += entrySize(cursor.value);
                    cursor.continue();
                } else {
                    totalBytes = size;
                    resolve();
                }
            };
            cursorReq.onerror = () => {
                resolve();
            };
        });
    } catch {
        totalBytes = 0;
    }
}

async function trim() {
    try {
        const db = await openDb();
        await new Promise((resolve) => {
            const tx = db.transaction(STORE_NAME, "readwrite");
            const store = tx.objectStore(STORE_NAME);
            const cursorReq = store.openCursor();
            cursorReq.onsuccess = (e) => {
                const cursor = e.target.result;
                if (!cursor || totalBytes <= TRIM_TARGET_BYTES) {
                    resolve();
                    return;
                }
                totalBytes -= entrySize(cursor.value);
                cursor.delete();
                cursor.continue();
            };
            cursorReq.onerror = () => resolve();
            tx.oncomplete = () => resolve();
        });
    } catch {
        // ignore
    }
}

async function flush() {
    if (pendingFlush) {
        return pendingFlush;
    }
    pendingFlush = (async () => {
        try {
            if (!initialized) {
                await recomputeSize();
                initialized = true;
            }
            while (queue.length) {
                const batch = queue.splice(0, queue.length);
                try {
                    const db = await openDb();
                    await new Promise((resolve) => {
                        const tx = db.transaction(STORE_NAME, "readwrite");
                        const store = tx.objectStore(STORE_NAME);
                        for (const entry of batch) {
                            store.add(entry);
                            totalBytes += entrySize(entry);
                            insertsSinceCheck += 1;
                        }
                        tx.oncomplete = () => resolve();
                        tx.onerror = () => resolve();
                        tx.onabort = () => resolve();
                    });
                } catch (e) {
                    console.warn("[honei-logger] write failed", e);
                }
                if (
                    totalBytes > MAX_BYTES ||
                    insertsSinceCheck >= ROTATE_CHECK_EVERY
                ) {
                    insertsSinceCheck = 0;
                    if (totalBytes > MAX_BYTES) {
                        await trim();
                    }
                }
            }
        } finally {
            pendingFlush = null;
        }
    })();
    return pendingFlush;
}

function safeData(data) {
    if (data == null) {
        return null;
    }
    try {
        JSON.stringify(data);
        return data;
    } catch {
        return { _unserializable: String(data) };
    }
}

function log(level, event, data) {
    const entry = {
        ts: Date.now(),
        iso: new Date().toISOString(),
        session: SESSION_ID,
        level,
        event,
        data: safeData(data),
    };
    queue.push(entry);
    if (level === "error") {
        console.error("[honei]", event, data ?? "");
    } else if (level === "warn") {
        console.warn("[honei]", event, data ?? "");
    }
    flush();
}

async function getAll() {
    try {
        const db = await openDb();
        return await new Promise((resolve) => {
            const tx = db.transaction(STORE_NAME, "readonly");
            const req = tx.objectStore(STORE_NAME).getAll();
            req.onsuccess = () => resolve(req.result || []);
            req.onerror = () => resolve([]);
        });
    } catch {
        return [];
    }
}

function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
}

async function exportLogs(format = "txt") {
    await flush();
    const logs = await getAll();
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    if (format === "json") {
        const blob = new Blob([JSON.stringify(logs, null, 2)], {
            type: "application/json",
        });
        downloadBlob(blob, `honei-logs-${stamp}.json`);
        return;
    }
    const lines = logs.map((l) => {
        const dataStr = l.data ? ` ${JSON.stringify(l.data)}` : "";
        return `${l.iso} [${l.level}] ${l.event}${dataStr}`;
    });
    const blob = new Blob([lines.join("\n")], { type: "text/plain" });
    downloadBlob(blob, `honei-logs-${stamp}.txt`);
}

async function clearLogs() {
    try {
        const db = await openDb();
        await new Promise((resolve) => {
            const tx = db.transaction(STORE_NAME, "readwrite");
            tx.objectStore(STORE_NAME).clear();
            tx.oncomplete = () => resolve();
            tx.onerror = () => resolve();
        });
        totalBytes = 0;
    } catch {
        // ignore
    }
}

async function stats() {
    await flush();
    const logs = await getAll();
    return {
        count: logs.length,
        bytes: totalBytes,
        sessionId: SESSION_ID,
        maxBytes: MAX_BYTES,
    };
}

export const honeiLogger = {
    debug: (event, data) => log("debug", event, data),
    info: (event, data) => log("info", event, data),
    warn: (event, data) => log("warn", event, data),
    error: (event, data) => log("error", event, data),
    export: exportLogs,
    clear: clearLogs,
    stats,
    getAll,
    sessionId: SESSION_ID,
};

if (typeof window !== "undefined") {
    window.honeiLogger = honeiLogger;
}

honeiLogger.info("logger_boot", { sessionId: SESSION_ID });
