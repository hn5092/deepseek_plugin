import { credentialRef } from "@deepseek-ai/dsh-credentials";
import z from "@deepseek-ai/schemastery";

/** Cordis plugin name; the profile patch row id stays independent of it. */
export const name = "opencode-go-usage";

/** Host services required before the usage route can register. */
export const inject = ["webServer", "credentials"];

/** Windows reported by https://opencode.ai/zen/go/v1/usage, in display order. */
const WINDOWS = ["rolling", "weekly", "monthly"];

export const Config = z.object({
    /** Credential references to sample; one entry = one account row. */
    refs: z.array(z.string()).default([
        "OPENCODE_API_KEY_1",
        "OPENCODE_API_KEY_2",
        "OPENCODE_API_KEY_3",
        "OPENCODE_API_KEY_4"
    ]),
    /**
     * Provider route names aligned with `refs`, so the browser half can match the account a
     * session has selected (pi-ai routes live in llm-pi-ai.providers). Omitted entries fall
     * back to `<routePrefix>-<index>`; set routePrefix empty to disable route matching.
     */
    routes: z.array(z.string()).default([]),
    routePrefix: z.string().default("opencode-go"),
    /** Exact route the browser half reads. Changing it also means changing lib/client.js. */
    path: z.string().default("/opencode-go-usage"),
    endpoint: z.string().default("https://opencode.ai/zen/go/v1/usage"),
    /** Reuse one upstream snapshot for this long; the browser polls every 30s. */
    cacheMs: z.number().step(1).min(0).default(30000),
    timeoutMs: z.number().step(1).min(1000).default(15000)
});

function messageOf(error) {
    return error instanceof Error ? error.message : String(error);
}

/** Reference name plus a four-character suffix; never the key itself. */
function maskKey(key) {
    return key.length < 8 ? "****" : "****" + key.slice(-4);
}

function windowOf(value) {
    if (!value || typeof value !== "object") return null;
    return {
        percent: typeof value.percent === "number" ? value.percent : null,
        status: typeof value.status === "string" ? value.status : "unknown",
        resetsAt: typeof value.resetsAt === "string" ? value.resetsAt : null
    };
}

/**
 * Resolve one credential reference and read its usage windows. Failures stay on the
 * row so one bad key never blanks the panel.
 */
async function readAccount(ctx, ref, config, route) {
    const row = { account: ref, route: route ?? null, key: null, rolling: null, weekly: null, monthly: null, error: null };
    let key;
    try {
        const hit = await ctx.credentials.resolve(credentialRef(ref));
        key = hit && typeof hit.value === "string" ? hit.value : void 0;
    } catch (error) {
        row.error = "credential: " + messageOf(error);
        return row;
    }
    if (!key) {
        row.error = "missing credential";
        return row;
    }
    row.key = maskKey(key);
    try {
        const response = await fetch(config.endpoint, {
            headers: {
                authorization: "Bearer " + key,
                "user-agent": "dsh-ui-opencode-usage/0.1"
            },
            signal: AbortSignal.timeout(config.timeoutMs)
        });
        if (!response.ok) {
            row.error = "HTTP " + response.status;
            return row;
        }
        const body = await response.json();
        const usage = body && typeof body === "object" ? body.usage : null;
        for (const window of WINDOWS) row[window] = windowOf(usage ? usage[window] : null);
    } catch (error) {
        row.error = messageOf(error);
    }
    return row;
}

/** Register the browser-readable usage route on the Web server. */
export function apply(ctx, config) {
    let cache = { at: 0, payload: null };

    const snapshot = async () => {
        if (cache.payload !== null && Date.now() - cache.at < config.cacheMs) return cache.payload;
        const routes = config.refs.map((_, index) => config.routes[index] ?? (config.routePrefix ? `${config.routePrefix}-${index + 1}` : null));
        const accounts = await Promise.all(config.refs.map((ref, index) => readAccount(ctx, ref, config, routes[index])));
        const payload = { sampledAt: new Date().toISOString(), accounts };
        cache = { at: Date.now(), payload };
        return payload;
    };

    const handler = async (request, response) => {
        if (request.method !== "GET" && request.method !== "HEAD") {
            response.writeHead(405, { "content-type": "text/plain; charset=utf-8" });
            response.end("method not allowed");
            return;
        }
        let body;
        let status = 200;
        try {
            body = JSON.stringify(await snapshot());
        } catch (error) {
            status = 500;
            body = JSON.stringify({ error: messageOf(error) });
        }
        response.writeHead(status, {
            "content-type": "application/json; charset=utf-8",
            "cache-control": "no-store",
            "content-length": Buffer.byteLength(body)
        });
        response.end(request.method === "HEAD" ? void 0 : body);
    };

    ctx.effect(() => ctx.webServer.register({ kind: "exact", path: config.path, handler }), "opencode-go-usage: " + config.path);
}