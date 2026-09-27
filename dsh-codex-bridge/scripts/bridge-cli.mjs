#!/usr/bin/env node
/**
 * Thin operator client for the codex-bridge collaboration surface.
 *
 * This is the CONSUMER side of the interface documented in `../INTERFACE.md`. It adds no state and no
 * second message store: every command is one call to the bridge's own HTTP surface, authenticated with
 * the harness launch URL and the controller credential, and the answer is printed as JSON for a caller
 * (Codex, a script) to consume.
 *
 * Two things are deliberately NOT taken from the command line:
 *
 *   - the LAUNCH TOKEN. It is read from the harness launch URL, which the harness itself writes to a
 *     local file, because that file is the authoritative rotating source and a command line is visible to
 *     other local processes.
 *   - the CONTROLLER CREDENTIAL. Only its REFERENCE is named (`--token-ref`); the value is resolved from
 *     the harness credential store or the process environment. A credential value is never a parameter
 *     and is never printed.
 *
 * Usage:
 *   node bridge-cli.mjs health
 *   node bridge-cli.mjs bindings   --token-ref REF --controller NAME
 *   node bridge-cli.mjs wait-any   --token-ref REF --controller NAME [--wait-ms N] [--since N] [--acknowledged ID,ID]
 *   node bridge-cli.mjs answer     --token-ref REF --controller NAME --question ID --text-file FILE
 *   node bridge-cli.mjs confirm    --token-ref REF --controller NAME --signal ID
 *   node bridge-cli.mjs notify     --token-ref REF --controller NAME --session ID --kind delivery|error [--text-file FILE] [--goal-id G] [--request-id R] [--issued-at ISO]
 *
 * Exit codes: 0 the command succeeded, 1 the command was rejected or failed, 2 the invocation was wrong.
 *
 * @module dsh-codex-bridge/scripts/bridge-cli
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Default harness home, matching the CLI harness on Windows and `$HOME/.dsh` elsewhere. */
const DEFAULT_HOME = process.env.DSH_HOME && process.env.DSH_HOME.length > 0
    ? process.env.DSH_HOME
    : path.join(os.homedir(), ".dsh");

/**
 * Parse `--name value` arguments.
 *
 * @param {ReadonlyArray<string>} argv - arguments after the command.
 * @returns {Map<string, string>} the options.
 */
function parseOptions(argv) {
    const options = new Map();
    for (let i = 0; i < argv.length; i += 1) {
        const token = argv[i];
        if (!token.startsWith("--")) throw new Error(`unexpected argument: ${token}`);
        const name = token.slice(2);
        const value = argv[i + 1];
        if (value === undefined || value.startsWith("--")) throw new Error(`--${name} requires a value`);
        options.set(name, value);
        i += 1;
    }
    return options;
}

/**
 * Read the harness launch URL from a local file.
 *
 * The URL carries the rotating token that the shell uses to authenticate a client, so it is read from
 * the file the shell writes rather than accepted as an argument.
 *
 * @param {ReadonlyArray<string>} candidates - paths to try, in order.
 * @returns {{url: URL, file: string}} the launch URL and where it came from.
 */
function readLaunchUrl(candidates) {
    for (const file of candidates) {
        if (!fs.existsSync(file)) continue;
        const bytes = fs.readFileSync(file);
        const text = bytes.toString(bytes[0] === 255 && bytes[1] === 254 ? "utf16le" : "utf8");
        const matches = [...text.matchAll(/http:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d+\/\?[^\s)]+/g)];
        if (matches.length === 0) continue;
        const url = new URL(matches.at(-1)[0]);
        if (url.username || url.password || !url.searchParams.get("token")) throw new Error(`launch URL in ${file} is not usable`);
        return { url, file };
    }
    throw new Error(
        "no harness launch URL found. Pass --url-file, or ensure the shell published one to "
        + candidates.join(" or ")
    );
}

/**
 * Resolve a credential REFERENCE to its value without ever taking it from the command line.
 *
 * The harness credential store is checked first (the authoritative place for a configured secret), then
 * the process environment, which is the layering the harness itself uses.
 *
 * @param {string} ref - credential reference name.
 * @param {string} home - harness home.
 * @returns {string} the secret.
 */
function resolveCredential(ref, home) {
    const storePath = path.join(home, ".credentials.yaml");
    if (fs.existsSync(storePath)) {
        const text = fs.readFileSync(storePath, "utf8");
        // The store is a small YAML document whose `refs` section maps a reference to its value. It is
        // parsed narrowly rather than with a YAML dependency: only the one key is needed, and the value is
        // never logged.
        const section = text.split(/^refs:\s*$/m)[1];
        if (section !== undefined) {
            for (const line of section.split(/\r?\n/)) {
                const match = line.match(/^\s+([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/);
                if (match === null) continue;
                if (match[1] !== ref) continue;
                const value = match[2].trim().replace(/^["']|["']$/g, "");
                if (value.length > 0) return value;
            }
        }
    }
    const fromEnv = process.env[ref];
    if (typeof fromEnv === "string" && fromEnv.length > 0) return fromEnv;
    throw new Error(`credential reference ${ref} is not configured in ${storePath} or the environment`);
}

/**
 * Perform one bridge control request.
 *
 * @param {object} input - request input.
 * @param {URL} input.url - the launch URL.
 * @param {string} input.cookie - the authenticated session cookie.
 * @param {string} input.base - the collaboration route prefix.
 * @param {string} input.token - the controller credential.
 * @param {string} input.method - HTTP method.
 * @param {string} input.route - path and query.
 * @param {object} [input.body] - JSON body.
 * @param {number} [input.timeoutMs] - request timeout.
 * @returns {Promise<{status: number, body: object}>} the response.
 */
async function control({ url, cookie, base, token, method, route, body, timeoutMs = 30_000 }) {
    const response = await fetch(new URL(`${base}${route}`, url), {
        method,
        headers: { cookie, "x-controller-token": token, ...(body === undefined ? {} : { "content-type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(timeoutMs)
    });
    const text = await response.text();
    let parsed = {};
    try { parsed = text.length > 0 ? JSON.parse(text) : {}; } catch { parsed = { raw: text.slice(0, 400) }; }
    return { status: response.status, body: parsed };
}

/**
 * Authenticate with the harness and return its cookie.
 *
 * @param {URL} url - the launch URL carrying the token.
 * @returns {Promise<string>} the cookie.
 */
async function login(url) {
    const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(15_000) });
    if (response.status !== 302 && response.status !== 303) throw new Error(`launch authentication failed: HTTP ${response.status}`);
    const cookie = response.headers.getSetCookie().map((entry) => entry.split(";")[0]).join("; ");
    if (cookie.length === 0) throw new Error("the harness returned no session cookie");
    return cookie;
}

/** Read a text file for a body field. @returns {string} its contents. */
function readTextFile(file) {
    if (!fs.existsSync(file)) throw new Error(`text file not found: ${file}`);
    return fs.readFileSync(file, "utf8");
}

async function main() {
    const [command, ...rest] = process.argv.slice(2);
    if (command === undefined || command === "help" || command === "--help") {
        const help = fs.readFileSync(new URL(import.meta.url), "utf8").split("*/")[0].split("/**")[1];
        process.stdout.write(`${help.replace(/^\s*\* ?/gm, "").trim()}\n`);
        return 0;
    }
    const options = parseOptions(rest);
    const home = options.get("home") ?? DEFAULT_HOME;
    const base = options.get("base") ?? "/codex-collab";
    const urlFiles = options.has("url-file")
        ? [options.get("url-file")]
        : [path.join(os.tmpdir(), "dsh-web-standalone.url"), path.join(home, "web.url")];
    const { url } = readLaunchUrl(urlFiles);

    // `health` needs no credential: it is the liveness probe used before any authenticated call.
    if (command === "health") {
        const cookie = await login(url);
        const response = await fetch(new URL("/codex-bridge/health", url), { headers: { cookie } });
        const body = await response.json().catch(() => ({}));
        process.stdout.write(`${JSON.stringify({ status: response.status, ...body }, null, 2)}\n`);
        return response.ok ? 0 : 1;
    }

    const tokenRef = options.get("token-ref");
    const controller = options.get("controller");
    if (tokenRef === undefined) throw new Error("--token-ref is required (the credential REFERENCE name, never the value)");
    if (controller === undefined) throw new Error("--controller is required");
    const token = resolveCredential(tokenRef, home);
    const cookie = await login(url);

    if (command === "bindings") {
        const result = await control({ url, cookie, base, token, method: "GET", route: `/bindings?controller=${encodeURIComponent(controller)}` });
        process.stdout.write(`${JSON.stringify(result.body, null, 2)}\n`);
        return result.status === 200 ? 0 : 1;
    }

    if (command === "wait-any") {
        // A long wait is expressed as repeated BOUNDED polls of the bridge's own bounded wait, so no
        // single request is held open indefinitely and an interruption leaves nothing dangling.
        const totalMs = Math.min(Math.max(Number(options.get("total-ms") ?? 20 * 60 * 1000) || 0, 0), 20 * 60 * 1000);
        const sliceMs = Math.min(Math.max(Number(options.get("wait-ms") ?? 25_000) || 0, 0), 30_000);
        const acknowledged = options.get("acknowledged") ?? "";
        let since = options.get("since");
        const deadline = Date.now() + totalMs;
        while (Date.now() < deadline) {
            const query = new URLSearchParams({ controller, waitMs: String(Math.min(sliceMs, Math.max(deadline - Date.now(), 0))) });
            if (since !== undefined) query.set("since", since);
            if (acknowledged.length > 0) query.set("acknowledged", acknowledged);
            const result = await control({ url, cookie, base, token, method: "GET", route: `/wait-any?${query.toString()}`, timeoutMs: sliceMs + 15_000 });
            if (result.status !== 200) {
                process.stdout.write(`${JSON.stringify(result.body, null, 2)}\n`);
                return 1;
            }
            const signals = result.body.signals ?? [];
            if (signals.length > 0) {
                process.stdout.write(`${JSON.stringify({ signals, cursor: result.body.cursor, more: result.body.more === true }, null, 2)}\n`);
                return 0;
            }
            if (Number.isFinite(result.body.cursor)) since = String(result.body.cursor);
        }
        // A deadline is reported as a deadline: no event means no output and no model call, which is what
        // lets a caller loop on this without spending tokens.
        return 3;
    }

    if (command === "answer") {
        const questionId = options.get("question");
        const textFile = options.get("text-file");
        if (questionId === undefined) throw new Error("--question is required");
        if (textFile === undefined) throw new Error("--text-file is required (the answer text is read from a file, not the command line)");
        const result = await control({
            url, cookie, base, token, method: "POST", route: "/answer",
            // The source is FIXED to codex: the server also forces it, and this client does not pretend
            // to be the human.
            body: { questionId, text: readTextFile(textFile), source: "codex", controller }
        });
        process.stdout.write(`${JSON.stringify(result.body, null, 2)}\n`);
        return result.status === 200 ? 0 : 1;
    }

    if (command === "confirm") {
        const signalId = options.get("signal");
        if (signalId === undefined) throw new Error("--signal is required");
        const result = await control({ url, cookie, base, token, method: "POST", route: "/signals/confirm", body: { controller, signalId } });
        process.stdout.write(`${JSON.stringify(result.body, null, 2)}\n`);
        return result.status === 200 ? 0 : 1;
    }

    if (command === "notify") {
        const sessionId = options.get("session");
        const kind = options.get("kind");
        if (sessionId === undefined) throw new Error("--session is required");
        if (kind !== "delivery" && kind !== "error") throw new Error("--kind must be delivery or error");
        const textFile = options.get("text-file");
        // A NEW notification names no requestId, so the SERVER allocates the identity. A retry names one
        // and must also carry the original --issued-at, which the bridge refuses to guess.
        const requestId = options.get("request-id");
        const issuedAt = options.get("issued-at");
        if (requestId !== undefined && issuedAt === undefined) {
            throw new Error("--request-id is a retry and requires --issued-at with the ORIGINAL issue time");
        }
        const result = await control({
            url, cookie, base, token, method: "POST", route: "/notify",
            body: {
                sessionId, controller, kind,
                text: textFile === undefined ? "" : readTextFile(textFile),
                ...(options.has("goal-id") ? { goalId: options.get("goal-id") } : {}),
                ...(requestId === undefined ? {} : { requestId }),
                ...(issuedAt === undefined ? {} : { issuedAt })
            }
        });
        process.stdout.write(`${JSON.stringify(result.body, null, 2)}\n`);
        return result.status === 200 ? 0 : 1;
    }

    process.stderr.write(`unknown command: ${command}\n`);
    return 2;
}

main().then((code) => { process.exitCode = code; }).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
});
