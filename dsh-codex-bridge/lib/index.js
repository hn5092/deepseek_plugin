import { randomUUID } from "node:crypto";
import z from "@deepseek-ai/schemastery";

/** Cordis plugin name; the profile patch row id stays independent of it. */
export const name = "codex-bridge";

/** Host services required before the bridge route can register. */
export const inject = ["webServer", "sessionController", "agents"];

/** Refuse oversized request bodies instead of buffering them. */
const MAX_BODY_BYTES = 256 * 1024;
/** Longest accepted message. A bridge is for instructions, not for shipping files. */
const MAX_TEXT_CHARS = 100_000;
/** Bound on one admission, so a wedged session cannot hang the caller's curl. */
const DELIVERY_TIMEOUT_MS = 30_000;
/** Only a loopback caller may drive a session: the harness has no auth on this route. */
const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

export const Config = z.object({
    /** Route prefix. Changing it means changing the caller's URL too. */
    path: z.string().default("/codex-bridge"),
    /**
     * Delivery mode while the addressed Session is busy. Matches the composer's
     * `ui-conversation.busyEnter` preference: `queue` waits for the running turn, `steer`
     * interrupts it. Keep this equal to that setting so a bridged message behaves exactly
     * like the same message typed into the composer.
     */
    busyMode: z.union([z.const("queue"), z.const("steer")]).default("steer"),
    /** Label recorded as the message source, so a bridged turn is distinguishable in the transcript. */
    sourceLabel: z.string().default("codex-bridge"),
    /** Refuse to deliver into a Session whose id is not currently known. */
    requireKnownSession: z.boolean().default(true)
});

function send(response, status, body) {
    const text = JSON.stringify(body, null, 2);
    response.writeHead(status, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        "content-length": Buffer.byteLength(text)
    });
    response.end(text);
}

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

/**
 * Loopback-only guard. The bridge can drive an agent, so a non-loopback peer is refused even
 * when it is same-origin: nothing here carries a credential.
 */
function isLoopback(request) {
    const address = request.socket && request.socket.remoteAddress;
    return typeof address === "string" && LOOPBACK.has(address);
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
 * Local HTTP bridge for an external agent (Codex) to post a message into a DSH Session.
 *
 * Delivery deliberately reuses the shell's own admission path — `sessionController.prompt` — so a
 * bridged message is indistinguishable from one typed into the composer: same user-message
 * construction, same busy/idle handling, same queue semantics. The mode is chosen here by the
 * same rule the composer applies (`resolveSubmitMode` in dsh-client-ui-conversation): idle
 * delivers as `queue`, busy delivers as the configured `busyMode`.
 *
 * The bridge owns no state. The transcript stays the only record of what was said.
 */
export function apply(ctx, config) {
    const base = config.path.replace(/\/+$/, "");

    /** Sessions the shell currently knows about, used to reject typos instead of queueing into the void. */
    const knownSessions = async () => {
        try {
            const result = await ctx.sessionController.list({});
            const records = (result && (result.sessions || result.items)) || [];
            return records.map((record) => record.sessionId || record.id).filter((id) => typeof id === "string");
        } catch {
            return null;
        }
    };

    /**
     * Whether the addressed Session currently reports a running turn.
     *
     * The Agent exposes its own authoritative `status` getter (`"idle"` or `"running"`), derived
     * from its phase — the same value the composer's busy state reads. `agents.get(id)` returns the
     * Agent itself, and a Session this process has never opened has no live Agent at all: that is a
     * cold Session, which always queues. Nothing here re-derives busy-ness from other fields.
     */
    const agentIsRunning = (sessionId) => {
        try {
            const agent = ctx.agents && typeof ctx.agents.get === "function" ? ctx.agents.get(sessionId) : null;
            if (!agent) return { known: false, running: false };
            const status = typeof agent.status === "string" ? agent.status : null;
            if (status !== null) return { known: true, running: status === "running" };
            if (typeof agent.running === "boolean") return { known: true, running: agent.running };
            if (typeof agent.isRunning === "function") return { known: true, running: Boolean(agent.isRunning()) };
            if (agent.phase && typeof agent.phase.kind === "string") {
                const kind = agent.phase.kind;
                return { known: true, running: kind !== "idle" && kind !== "maintenance" };
            }
            return { known: true, running: false };
        } catch {
            return { known: false, running: false };
        }
    };

    /**
     * The composer's own rule, reused verbatim: outside a steer-capable busy state, deliver as a
     * queue item; while busy, deliver the configured preference.
     */
    const resolveMode = (running) => (running ? config.busyMode : "queue");

    const deliver = async (sessionId, text) => {
        const requestId = `codex-bridge-${randomUUID()}`;
        const state = agentIsRunning(sessionId);
        const mode = resolveMode(state.running);
        // `prompt` takes its cancellation as a second argument; the client half passes its own
        // signal there. Bound the bridge's wait so a wedged admission cannot hang the caller.
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(new Error("codex-bridge delivery timed out")), DELIVERY_TIMEOUT_MS);
        try {
            const value = await ctx.sessionController.prompt({
                requestId,
                sessionId,
                mode,
                content: [{ type: "text", text }],
                clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone
            }, controller.signal);
            return { requestId, mode, agentKnown: state.known, wasRunning: state.running, accepted: Boolean(value && value.accepted) };
        } finally {
            clearTimeout(timer);
        }
    };

    const handler = async (request, response) => {
        if (!isLoopback(request)) {
            send(response, 403, { error: "the bridge only accepts loopback callers" });
            return;
        }
        if (!sameOrigin(request)) {
            send(response, 403, { error: "cross-origin request refused" });
            return;
        }

        const url = new URL(request.url, "http://127.0.0.1");
        const route = url.pathname.slice(base.length) || "/";

        try {
            if ((request.method === "GET" || request.method === "HEAD") && route === "/health") {
                send(response, 200, {
                    ok: true,
                    bridge: "codex-bridge",
                    base,
                    busyMode: config.busyMode,
                    routes: ["GET " + base + "/health", "GET " + base + "/sessions", "POST " + base + "/send"]
                });
                return;
            }

            if ((request.method === "GET" || request.method === "HEAD") && route === "/sessions") {
                const ids = await knownSessions();
                send(response, 200, { sessions: ids === null ? [] : ids, available: ids !== null });
                return;
            }

            if (request.method === "POST" && route === "/send") {
                const raw = await readBody(request);
                let body;
                try {
                    body = raw.length > 0 ? JSON.parse(raw) : {};
                } catch {
                    send(response, 400, { error: "body is not JSON" });
                    return;
                }
                const sessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : "";
                const text = typeof body.text === "string" ? body.text : "";
                if (!sessionId) {
                    send(response, 400, { error: "sessionId is required" });
                    return;
                }
                if (text.trim().length === 0) {
                    send(response, 400, { error: "text must contain non-whitespace" });
                    return;
                }
                if (text.length > MAX_TEXT_CHARS) {
                    send(response, 413, { error: `text exceeds ${MAX_TEXT_CHARS} characters` });
                    return;
                }
                if (config.requireKnownSession) {
                    const ids = await knownSessions();
                    if (ids !== null && !ids.includes(sessionId)) {
                        send(response, 404, { error: `unknown session "${sessionId}"`, hint: "GET " + base + "/sessions lists the ids this shell can reach" });
                        return;
                    }
                }
                const result = await deliver(sessionId, text);
                send(response, 200, { ok: true, sessionId, ...result });
                return;
            }

            send(response, 404, { error: `no route for ${request.method} ${route}` });
        } catch (error) {
            send(response, 500, { error: messageOf(error) });
        }
    };

    ctx.effect(() => ctx.webServer.register({ kind: "prefix", path: base, handler }), `codex-bridge: ${base}`);
    ctx.logger.info("codex-bridge listening on %s (busyMode=%s)", base, config.busyMode);
}
