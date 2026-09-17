import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
    /**
     * Also look for `<autoRefPrefix><n>` for n = 1..autoRefMax and report every one that
     * resolves, so a key added to the credential store shows up without editing this list.
     * Set autoRefMax to 0 to sample `refs` only.
     */
    autoRefPrefix: z.string().default("OPENCODE_API_KEY_"),
    autoRefMax: z.number().step(1).min(0).default(8),
    /** Exact route the browser half reads. Changing it also means changing lib/client.js. */
    path: z.string().default("/opencode-go-usage"),
    endpoint: z.string().default("https://opencode.ai/zen/go/v1/usage"),
    /**
     * CommandCode accounts. Its upstream shape is nothing like OpenCode's, so it gets its own
     * reader: credits and the rolling windows come from /alpha/billing/credits, the plan and
     * period from /alpha/billing/subscriptions, and the period spend from /alpha/usage/summary.
     * Explicit refs are always listed; the prefix additionally discovers `<prefix>` and
     * `<prefix>_<n>` for n = 1..commandcodeRefMax once their key resolves.
     */
    commandcodeRefs: z.array(z.string()).default([]),
    commandcodeRefPrefix: z.string().default("COMMANDCODE_API_KEY"),
    commandcodeRefMax: z.number().step(1).min(0).default(4),
    commandcodeBaseUrl: z.string().default("https://api.commandcode.ai"),
    /** In-process sampling interval; 0 disables it. Default: every 30 minutes. */
    sampleEveryMs: z.number().step(1).min(0).default(1800000),
    /** Bounded history kept for the trend column and for trend questions. */
    historyMax: z.number().step(1).min(0).default(96),
    /** JSONL history file; empty uses the per-user state directory (see stateDir). */
    historyPath: z.string().default(""),
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
/**
 * Writable state directory for the history log: %LOCALAPPDATA% on Windows,
 * ~/Library/Application Support on macOS, $XDG_STATE_HOME (else ~/.local/state) elsewhere.
 * The temp directory is only the last resort - the OS clears it, which would silently drop
 * the trend the Δ column is computed from.
 */
function stateDir() {
    if (process.env.LOCALAPPDATA) return process.env.LOCALAPPDATA;
    const home = os.homedir();
    if (process.platform === "darwin" && home) return path.join(home, "Library", "Application Support");
    if (process.env.XDG_STATE_HOME) return process.env.XDG_STATE_HOME;
    if (home) return path.join(home, ".local", "state");
    return os.tmpdir();
}

/** Resolved history file: configured path, else the per-user state directory. */
function historyFile(config) {
    if (config.historyPath) return config.historyPath;
    return path.join(stateDir(), "opencode-go-usage", "history.jsonl");
}

/** One compact history line: the windows only, no credentials, no key material. */
function historyLine(payload) {
    return JSON.stringify({
        at: payload.sampledAt,
        accounts: payload.accounts.map((row) => ({
            account: row.account,
            route: row.route,
            rolling: row.rolling ? row.rolling.percent : null,
            weekly: row.weekly ? row.weekly.percent : null,
            monthly: row.monthly ? row.monthly.percent : null,
            error: row.error
        }))
    });
}

/** Append one sample, rotating the file once it grows past 2 MiB. */
function appendHistory(file, payload) {
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        try {
            if (fs.statSync(file).size > 2 * 1024 * 1024) fs.renameSync(file, file + ".1");
        } catch {
            // Missing file is the normal first-sample path.
        }
        fs.appendFileSync(file, historyLine(payload) + "\n");
    } catch {
        // A read-only machine must not break the usage panel.
    }
}

/** Last `max` samples, oldest first; absent or unreadable history yields an empty array. */
function readHistory(file, max) {
    if (max <= 0) return [];
    try {
        const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
        return lines.slice(-max).map((line) => {
            try {
                return JSON.parse(line);
            } catch {
                return null;
            }
        }).filter(Boolean);
    } catch {
        return [];
    }
}
/** Trailing number of a reference, else its position; used to name the matching route. */
function routeNumber(ref, index) {
    const match = /(\d+)\s*$/.exec(ref);
    return match ? match[1] : String(index + 1);
}

/**
 * Configured references plus every `<autoRefPrefix><n>` that currently resolves, so adding a
 * key to the credential store is enough for it to appear. Configured entries keep their order
 * and stay listed even when their key is missing.
 */
async function collectRefs(ctx, config) {
    const refs = [...config.refs];
    const seen = new Set(refs);
    const max = config.autoRefMax ?? 0;
    if (!config.autoRefPrefix || max <= 0) return refs;
    for (let index = 1; index <= max; index++) {
        const ref = config.autoRefPrefix + index;
        if (seen.has(ref)) continue;
        try {
            const hit = await ctx.credentials.resolve(credentialRef(ref));
            if (hit && typeof hit.value === "string" && hit.value.length > 0) {
                refs.push(ref);
                seen.add(ref);
            }
        } catch {
            // An unresolvable probe is simply not an account.
        }
    }
    return refs;
}
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

/**
 * Monthly credit allowance for a CommandCode plan id, mirroring the CLI's own table. Used only
 * when the upstream sends a hard cap without a plan id; otherwise the API is authoritative.
 */
const COMMANDCODE_PLAN_CREDITS = {
    "individual-go": 10,
    "individual-goat": 70,
    "individual-pro": 30,
    "individual-pro-v1": 80,
    "individual-provider": 15,
    "individual-max": 150,
    "individual-ultra": 300,
    "teams-pro": 40
};

/** Percent used/total, clamped to 0..100; a non-positive total reports 0 rather than Infinity. */
function percentOf(used, total) {
    if (typeof used !== "number" || typeof total !== "number" || total <= 0) return null;
    return Math.round(Math.min(used / total, 1) * 1000) / 10;
}

/** ISO string from an epoch-millis field, or null when the upstream omits it. */
function isoFromMs(value) {
    return typeof value === "number" && Number.isFinite(value) ? new Date(value).toISOString() : null;
}

/**
 * One CommandCode account, read from three endpoints whose shapes are unrelated to OpenCode's.
 * `credits` is the authoritative source for both the allowance and the rolling windows; the
 * subscription supplies the plan id and billing period; the summary supplies tokens and spend.
 * Every failure lands on the row so one broken key never blanks the panel.
 */
async function readCommandCodeAccount(ctx, ref, config, route) {
    const row = {
        account: ref,
        route: route ?? null,
        source: "commandcode",
        key: null,
        planId: null,
        rolling: null,
        weekly: null,
        monthly: null,
        tokensIn: null,
        tokensOut: null,
        requests: null,
        spend: null,
        error: null
    };
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

    const base = String(config.commandcodeBaseUrl || "").replace(/\/+$/, "");
    const get = async (path) => {
        const response = await fetch(base + path, {
            headers: {
                authorization: "Bearer " + key,
                accept: "application/json",
                "user-agent": "dsh-ui-opencode-usage/0.1"
            },
            signal: AbortSignal.timeout(config.timeoutMs)
        });
        if (!response.ok) throw new Error("HTTP " + response.status + " " + path);
        return response.json();
    };

    try {
        // The subscription carries the plan and the billing period the summary is scoped to.
        let periodStart = null;
        try {
            const subscription = await get("/alpha/billing/subscriptions");
            const data = subscription && subscription.data ? subscription.data : null;
            if (data) {
                row.planId = typeof data.planId === "string" ? data.planId : null;
                periodStart = typeof data.currentPeriodStart === "string" ? data.currentPeriodStart : null;
            }
        } catch {
            // A missing subscription still leaves credits usable; the row just has no plan.
        }

        const credits = await get("/alpha/billing/credits");
        const wallet = credits && credits.credits ? credits.credits : {};
        const limits = credits && credits.windowLimits ? credits.windowLimits : null;

        // monthlyCredits is what is left, and the plan table gives the allowance, so used is the
        // difference. When the plan is unknown, fall back to the reported value as the total.
        const remaining = typeof wallet.monthlyCredits === "number" ? wallet.monthlyCredits : null;
        const allowance = row.planId ? COMMANDCODE_PLAN_CREDITS[row.planId] ?? null : null;
        const monthlyUsed = allowance !== null && remaining !== null ? allowance - remaining : null;
        const monthlyTotal = allowance !== null ? allowance : remaining;
        const monthlyPercent = percentOf(monthlyUsed, monthlyTotal);

        if (limits) {
            if (limits.fiveHour) {
                row.rolling = {
                    percent: percentOf(limits.fiveHour.used, limits.fiveHour.cap),
                    status: limits.fiveHour.exceeded ? "exceeded" : "ok",
                    resetsAt: isoFromMs(limits.fiveHour.resetAt),
                    used: limits.fiveHour.used,
                    cap: limits.fiveHour.cap
                };
            }
            if (limits.weekly) {
                row.weekly = {
                    percent: percentOf(limits.weekly.used, limits.weekly.cap),
                    status: limits.weekly.exceeded ? "exceeded" : "ok",
                    resetsAt: isoFromMs(limits.weekly.resetAt),
                    used: limits.weekly.used,
                    cap: limits.weekly.cap
                };
            }
        }
        row.monthly = {
            percent: monthlyPercent,
            status: "ok",
            // No monthly reset timestamp is published; the billing period is the equivalent.
            resetsAt: periodStart,
            used: monthlyUsed,
            cap: monthlyTotal,
            remaining
        };

        try {
            const query = periodStart ? "?since=" + encodeURIComponent(periodStart) : "";
            const summary = await get("/alpha/usage/summary" + query);
            if (summary && typeof summary === "object") {
                row.tokensIn = typeof summary.totalTokensIn === "number" ? summary.totalTokensIn : null;
                row.tokensOut = typeof summary.totalTokensOut === "number" ? summary.totalTokensOut : null;
                row.requests = typeof summary.totalCount === "number" ? summary.totalCount : null;
                row.spend = typeof summary.totalCredits === "number" ? summary.totalCredits : null;
            }
        } catch {
            // Spend detail is decoration; the window percentages above are the point.
        }
    } catch (error) {
        row.error = messageOf(error);
    }
    return row;
}

/**
 * Provider route a CommandCode account belongs to. The DSH route name is fixed by the installer
 * (provider/commandcode in the settings.yaml), so the browser half can match it against the
 * session's selected provider exactly like the numbered OpenCode routes.
 */
    function readCommandCodeRoute(ref) {
        // One route per account, numbered like the OpenCode routes: COMMANDCODE_API_KEY_2 is
        // served by commandcode-2. The first account keeps the unsuffixed id so an existing
        // single-route install keeps working.
        const match = /(\d+)\s*$/.exec(ref ?? "");
        return match && match[1] !== "1" ? "commandcode-" + match[1] : "commandcode";
    }

/** CommandCode references: the configured list plus discoverable `<prefix>` / `<prefix>_<n>`. */
async function collectCommandCodeRefs(ctx, config) {
    const refs = [...(config.commandcodeRefs ?? [])];
    const seen = new Set(refs);
    const prefix = config.commandcodeRefPrefix;
    const max = config.commandcodeRefMax ?? 0;
    if (!prefix || max <= 0) return refs;
    // "<PREFIX>" itself first (the common single-account case), then "<PREFIX>_<n>".
    for (const candidate of [prefix, ...Array.from({ length: max }, (_, i) => prefix + "_" + (i + 1))]) {
        if (seen.has(candidate)) continue;
        try {
            const hit = await ctx.credentials.resolve(credentialRef(candidate));
            if (hit && typeof hit.value === "string" && hit.value.length > 0) {
                refs.push(candidate);
                seen.add(candidate);
            }
        } catch {
            // An unresolvable probe is simply not an account.
        }
    }
    return refs;
}

/** Register the browser-readable usage route on the Web server. */
export function apply(ctx, config) {
    let cache = { at: 0, payload: null };

    const snapshot = async () => {
        if (cache.payload !== null && Date.now() - cache.at < config.cacheMs) return cache.payload;
        const refs = await collectRefs(ctx, config);
        const routes = refs.map((ref, index) => config.routes[index]
            ?? (config.routePrefix ? `${config.routePrefix}-${routeNumber(ref, index)}` : null));
        const accounts = await Promise.all(refs.map((ref, index) => readAccount(ctx, ref, config, routes[index])));
        // CommandCode accounts ride along in the same array; `source` tells the browser half
        // which columns apply, so one panel can show both providers without a second route.
        const commandcodeRefs = await collectCommandCodeRefs(ctx, config);
        const commandcodeAccounts = await Promise.all(commandcodeRefs.map((ref) =>
            readCommandCodeAccount(ctx, ref, config, readCommandCodeRoute(ref))));
        const payload = {
            sampledAt: new Date().toISOString(),
            accounts: [...accounts, ...commandcodeAccounts]
        };
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
            const payload = await snapshot();
            body = JSON.stringify({ ...payload, history: readHistory(file, Math.min(config.historyMax, 24)) });
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

    // Sampling runs inside this process: no scheduled task, no shell, no window. The first
    // sample lands immediately so the history starts with the plugin, not a tick later.
    const file = historyFile(config);
    if (config.sampleEveryMs > 0) {
        ctx.effect(() => {
            let stopped = false;
            const take = async () => {
                if (stopped) return;
                try {
                    appendHistory(file, await snapshot());
                } catch {
                    // Sampling is advisory; the route still serves the live value.
                }
            };
            void take();
            const timer = setInterval(() => { void take(); }, config.sampleEveryMs);
            return () => {
                stopped = true;
                clearInterval(timer);
            };
        }, "opencode-go-usage: sampler");
    }
}
