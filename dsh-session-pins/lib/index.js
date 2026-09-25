import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import z from "@deepseek-ai/schemastery";

/** Cordis plugin name; the profile patch row id stays independent of it. */
export const name = "session-pins";

/** Host services required before the diagnostics route can register. */
export const inject = ["webServer"];

/** Refuse oversized request bodies instead of buffering them. */
const MAX_BODY_BYTES = 64 * 1024;

/** State directory used only to read the retired legacy file listed in the diagnostics. */
function stateDir() {
    if (process.env.LOCALAPPDATA) return process.env.LOCALAPPDATA;
    const home = os.homedir();
    if (process.platform === "darwin" && home) return path.join(home, "Library", "Application Support");
    if (process.env.XDG_STATE_HOME) return process.env.XDG_STATE_HOME;
    if (home) return path.join(home, ".local", "state");
    return os.tmpdir();
}

/** Where the pre-native build kept its own pin document, if it is still on disk. */
function legacyPinsFile() {
    return path.join(stateDir(), "session-pins", "pins.json");
}

export const Config = z.object({
    /** Exact route the browser half posts its breadcrumbs to. Changing it also means changing lib/client.js. */
    path: z.string().default("/session-pins"),
    /** Retired: pin state lives in the shell now. Kept so an existing patch row still validates. */
    pinsPath: z.string().default(""),
    maxPins: z.number().step(1).min(1).default(50),
    maxTitleLength: z.number().step(1).min(1).default(200)
});

function messageOf(error) {
    return error instanceof Error ? error.message : String(error);
}

/** Read a request body with a hard byte ceiling. */
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
 * Diagnostics endpoint for the pinned-conversation area.
 *
 * This half holds NO pin state. Pinning is a shell capability: `uiWorkspace` owns the document
 * (`workspaces.list.pinnedSessionIds`) and the writes. A second store here would be a competing
 * source of truth that the sidebar, the row hover button and the row menu could not agree with,
 * which is exactly what an earlier revision of this plugin suffered from. What remains is the
 * breadcrumb channel the browser half reports through, so a page-side failure can be read from
 * the host without a devtools session.
 */
export function apply(ctx, config) {
    const notes = [];
    let lastError = null;

    const payload = () => ({
        /** Always empty: the shell owns pins. Kept so callers can tell this half is inert. */
        pins: [],
        /** Document the retired build wrote, reported for cleanup awareness only. */
        legacyStore: legacyPinsFile(),
        legacyStorePresent: fs.existsSync(legacyPinsFile()),
        owner: "uiWorkspace",
        maxPins: config.maxPins,
        sampledAt: new Date().toISOString(),
        error: lastError,
        notes
    });

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
            send(400, { error: "this half is diagnostics-only; pinning is owned by uiWorkspace" });
        } catch (error) {
            lastError = messageOf(error);
            send(400, { error: lastError, ...payload() });
        }
    };

    ctx.effect(() => ctx.webServer.register({ kind: "exact", path: config.path, handler }), `session-pins: ${config.path}`);
}
