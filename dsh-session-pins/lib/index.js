import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import z from "@deepseek-ai/schemastery";

/** Cordis plugin name; the profile patch row id stays independent of it. */
export const name = "session-pins";

/** Host services required before the pins route can register. */
export const inject = ["webServer"];

/** Refuse oversized request bodies instead of buffering them. */
const MAX_BODY_BYTES = 64 * 1024;
/** Session ids are short opaque strings; anything longer is junk, not a session. */
const MAX_SESSION_ID_LENGTH = 200;

/**
 * Writable state directory: %LOCALAPPDATA% on Windows, ~/Library/Application Support on
 * macOS, $XDG_STATE_HOME (else ~/.local/state) elsewhere, and only then the temp directory,
 * which the OS clears.
 */
function stateDir() {
    if (process.env.LOCALAPPDATA) return process.env.LOCALAPPDATA;
    const home = os.homedir();
    if (process.platform === "darwin" && home) return path.join(home, "Library", "Application Support");
    if (process.env.XDG_STATE_HOME) return process.env.XDG_STATE_HOME;
    if (home) return path.join(home, ".local", "state");
    return os.tmpdir();
}

/** Resolved pins file: the configured path, else the per-user state directory. */
function pinsFile(config) {
    if (config.pinsPath) return config.pinsPath;
    return path.join(stateDir(), "session-pins", "pins.json");
}

export const Config = z.object({
    /** Exact route the browser half reads and writes. Changing it also means changing lib/client.js. */
    path: z.string().default("/session-pins"),
    /** JSONL-free single document; empty uses the per-user state directory. */
    pinsPath: z.string().default(""),
    /** Upper bound on pinned conversations, so a runaway client cannot grow the file. */
    maxPins: z.number().step(1).min(1).default(50),
    /** Longest stored title; longer ones are truncated instead of rejected. */
    maxTitleLength: z.number().step(1).min(1).default(200)
});

function messageOf(error) {
    return error instanceof Error ? error.message : String(error);
}

/** One stored pin, or null when the record is unusable. */
function normalizePin(value, maxTitleLength) {
    if (!value || typeof value !== "object") return null;
    const sessionId = typeof value.sessionId === "string" ? value.sessionId.trim() : "";
    if (!sessionId || sessionId.length > MAX_SESSION_ID_LENGTH) return null;
    const title = typeof value.title === "string" ? value.title.slice(0, maxTitleLength) : "";
    const workspaceId = typeof value.workspaceId === "string" ? value.workspaceId : null;
    const pinnedAt = typeof value.pinnedAt === "string" ? value.pinnedAt : new Date().toISOString();
    return { sessionId, title, workspaceId, pinnedAt };
}

/** Read the document; an absent or unreadable file is an empty pin list, never a throw. */
function readPins(file, maxTitleLength) {
    let text;
    try {
        text = fs.readFileSync(file, "utf8");
    } catch {
        return [];
    }
    let parsed;
    try {
        parsed = JSON.parse(text);
    } catch {
        // A corrupted document must not take the sidebar down; keep the file for inspection.
        return [];
    }
    const rows = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.pins) ? parsed.pins : [];
    const pins = [];
    const seen = new Set();
    for (const row of rows) {
        const pin = normalizePin(row, maxTitleLength);
        if (pin === null || seen.has(pin.sessionId)) continue;
        seen.add(pin.sessionId);
        pins.push(pin);
    }
    return pins;
}

/** Write the document atomically (temp + rename) and read it back before trusting it. */
function writePins(file, pins) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, pins }, null, 2) + "\n", "utf8");
    fs.renameSync(tmp, file);
    const readBack = readPins(file, Number.MAX_SAFE_INTEGER);
    if (readBack.length !== pins.length) {
        throw new Error(`pins file did not read back (${readBack.length} of ${pins.length} rows)`);
    }
    return readBack;
}

/** Buffer a request body with a hard cap, or reject. */
function readBody(request) {
    return new Promise((resolve, reject) => {
        let size = 0;
        const chunks = [];
        request.on("data", (chunk) => {
            size += chunk.length;
            if (size > MAX_BODY_BYTES) {
                reject(new Error("request body too large"));
                request.destroy();
                return;
            }
            chunks.push(chunk);
        });
        request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        request.on("error", reject);
    });
}

/** Same-origin guard: a browser-supplied Origin must match the Host that served this route. */
function sameOrigin(request) {
    const origin = request.headers.origin;
    if (typeof origin !== "string" || origin.length === 0) return true;
    try {
        return new URL(origin).host === request.headers.host;
    } catch {
        return false;
    }
}

/**
 * Pinned-conversation store behind the sidebar area. The browser half owns the pixels and
 * the session titles; this half owns durability, so pins survive a reload, a restart and a
 * cleared browser profile.
 */
export function apply(ctx, config) {
    const file = pinsFile(config);
    let pins = readPins(file, config.maxTitleLength);
    let lastError = null;
    // In-memory breadcrumbs from the browser half: the only cheap way to see what the page
    // actually did when a DOM/primitive seam does not behave. Never persisted.
    const notes = [];

    const payload = () => ({
        pins,
        store: file,
        maxPins: config.maxPins,
        sampledAt: new Date().toISOString(),
        error: lastError,
        notes
    });

    const pin = (body) => {
        const sessionId = typeof body?.sessionId === "string" ? body.sessionId.trim() : "";
        if (!sessionId || sessionId.length > MAX_SESSION_ID_LENGTH) throw new Error("sessionId is required");
        const title = typeof body?.title === "string" ? body.title.slice(0, config.maxTitleLength) : "";
        const workspaceId = typeof body?.workspaceId === "string" ? body.workspaceId : null;
        const existing = pins.find((row) => row.sessionId === sessionId);
        if (existing) {
            // Re-pinning refreshes the stored metadata instead of moving the row.
            pins = pins.map((row) => (row.sessionId === sessionId ? { ...row, title: title || row.title, workspaceId: workspaceId ?? row.workspaceId } : row));
            return;
        }
        if (pins.length >= config.maxPins) throw new Error(`at most ${config.maxPins} conversations can be pinned`);
        pins = [{ sessionId, title, workspaceId, pinnedAt: new Date().toISOString() }, ...pins];
    };

    const unpin = (body) => {
        const sessionId = typeof body?.sessionId === "string" ? body.sessionId.trim() : "";
        if (!sessionId) throw new Error("sessionId is required");
        pins = pins.filter((row) => row.sessionId !== sessionId);
    };

    const handler = async (request, response) => {
        const send = (status, body) => {
            const text = JSON.stringify(body);
            response.writeHead(status, {
                "content-type": "application/json; charset=utf-8",
                "cache-control": "no-store",
                "content-length": Buffer.byteLength(text)
            });
            response.end(request.method === "HEAD" ? void 0 : text);
        };

        try {
            if (request.method === "GET" || request.method === "HEAD") {
                send(200, payload());
                return;
            }
            if (request.method !== "POST") {
                response.writeHead(405, { "content-type": "text/plain; charset=utf-8" });
                response.end("method not allowed");
                return;
            }
            if (!sameOrigin(request)) {
                send(403, { error: "cross-origin request refused" });
                return;
            }
            const raw = await readBody(request);
            let body;
            try {
                body = raw.length > 0 ? JSON.parse(raw) : {};
            } catch {
                send(400, { error: "body is not JSON" });
                return;
            }
            if (body?.action === "note") {
                const text = typeof body.note === "string" ? body.note.slice(0, 200) : "";
                if (text) {
                    notes.push({ at: new Date().toISOString(), text });
                    while (notes.length > 20) notes.shift();
                }
                send(200, { ok: true, ...payload() });
                return;
            }
            const before = pins;
            if (body?.action === "pin") pin(body);
            else if (body?.action === "unpin") unpin(body);
            else {
                send(400, { error: "action must be 'pin' or 'unpin'" });
                return;
            }
            try {
                pins = writePins(file, pins);
                lastError = null;
            } catch (error) {
                // Keep serving the previous state rather than a half-applied one.
                pins = before;
                lastError = messageOf(error);
                ctx.logger.warn("session-pins: could not persist %s: %s", file, lastError);
                send(500, { error: lastError, ...payload() });
                return;
            }
            send(200, payload());
        } catch (error) {
            send(400, { error: messageOf(error) });
        }
    };

    ctx.effect(() => ctx.webServer.register({ kind: "exact", path: config.path, handler }), `session-pins: ${config.path}`);
}
