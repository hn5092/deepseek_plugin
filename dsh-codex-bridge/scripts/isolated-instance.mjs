/**
 * Boot a THROWAWAY DSH instance carrying the bridge under test.
 *
 * The loop that matters here — a real `ask_codex` tool call pausing until a controller answers — needs
 * a real instance, a real session and a real tool dispatcher. It must not, however, disturb the shared
 * installation, the shared DSH home, or the running production instance, so this harness:
 *
 *  - creates a temporary DSH home, so profile, databases and session logs are disposable;
 *  - copies the plugin under test into that home's profile `node_modules`, which is the directory the
 *    loader resolves a profile plugin from (a custom package name is NOT one of the junctions into the
 *    global install, unlike `@deepseek-ai/*`);
 *  - loads it through a `--patch` overlay, so no profile's committed plugin set is modified;
 *  - reads the instance's OWN launch URL back from its log, so the suite always authenticates against
 *    the process it started.
 *
 * @module dsh-codex-collab-bridge/scripts/isolated-instance
 */
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const NODE = "C:\\Program Files\\nodejs\\node.exe";
const DSH_ENTRY = path.join(process.env.APPDATA ?? "", "npm", "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
/** This file's own directory, so the scripted provider is found without a caller-supplied path. */
const scriptsDir = path.dirname(fileURLToPath(import.meta.url));

/** @returns {Promise<number>} a free loopback port. */
async function freePort() {
    return await new Promise((resolve, reject) => {
        const server = net.createServer();
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
            const { port } = server.address();
            server.close(() => resolve(port));
        });
    });
}

/**
 * Start one isolated instance with the bridge loaded.
 *
 * @param {object} options - start options.
 * @param {string} options.pluginRoot - the bridge package directory to load.
 * @param {ReadonlyArray<{sessionId: string, cwd: string, controller: string}>} [options.bindings] - collaboration bindings.
 * @param {number} [options.answerTimeoutMs] - bound for an ask.
 * @param {number} [options.timeoutMs] - how long to wait for the launch URL.
 * @param {{question?: string}|null} [options.scripted] - when set, also load the scripted provider plugin.
 * @param {string|null} [options.inboxRoot] - file-signal inbox root; null leaves it unconfigured.
 * @param {ReadonlyArray<{controller: string, tokenRef: string, token: string}>} [options.controllerTokens] - test controller credentials.
 * @param {string} [options.home] - reuse an existing DSH home so a restart shares durable state.
 * @returns {Promise<object>} the instance handle.
 */
export async function startIsolatedInstance({ pluginRoot, bindings = [], answerTimeoutMs = 20_000, timeoutMs = 90_000, scripted = null, inboxRoot = null, controllerTokens = [], home: reuseHome = undefined }) {
    const port = await freePort();
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "collab-instance-"));
    // A restart keeps the CALLER-provided home so durable sessions live across both processes, while the
    // per-run scratch directory (plugin copy, overlay, log) stays disposable.
    const home = typeof reuseHome === "string" && reuseHome.length > 0 ? reuseHome : path.join(workDir, "home");
    const profileModules = path.join(home, "profiles", "node_modules");
    const logFile = path.join(workDir, "instance.log");
    fs.mkdirSync(profileModules, { recursive: true });

    // A custom package name resolves from the profile's own node_modules; only `@deepseek-ai/*` entries
    // are junctions into the global install, so this copy is genuinely the loaded one.
    fs.cpSync(pluginRoot, path.join(profileModules, "dsh-codex-bridge"), { recursive: true });
    if (scripted !== null) {
        // A disposable home has no credentials, so a scripted provider is what lets a real model call
        // reach the tool under test.
        fs.cpSync(path.join(scriptsDir, "scripted-model"), path.join(profileModules, "dsh-codex-collab-scripted-model"), { recursive: true });
    }

    const patchFile = path.join(workDir, "collab.patch.yml");
    const bindingLines = [];
    for (const binding of bindings) {
        bindingLines.push("          - bindingId: '" + binding.bindingId + "'");
        bindingLines.push("            sessionId: '" + binding.sessionId + "'");
        bindingLines.push("            cwd: '" + binding.cwd.replace(/\\/g, "/") + "'");
        bindingLines.push("            controller: '" + binding.controller + "'");
        bindingLines.push("            tokenRef: '" + binding.tokenRef + "'");
        if (binding.current === false) bindingLines.push("            current: false");
    }
    const scriptedLines = scripted === null ? [] : [
        "",
        "    - id: scripted-model",
        "      name: 'dsh-codex-collab-scripted-model'",
        "      config:",
        "        provider: scripted",
        "        model: deepseek-v4.1-flash",
        "        toolName: ask_codex",
        ...(scripted.question === undefined ? [] : [`        toolQuestion: ${JSON.stringify(scripted.question)}`]),
        "",
        // Without this a disposable home falls back to a real provider that has no credentials, so the
        // turn would fail before any tool call. Pointing the default at the scripted route is what lets
        // a REAL model call reach the tool under test.
        "    - id: agent-default-model",
        "      name: '@deepseek-ai/dsh-agent-default-model'",
        "      config:",
        "        provider: scripted",
        "        model: deepseek-v4.1-flash"
    ];
    const patch = [
        "# Test-only overlay: load the bridge under test into a disposable home.",
        "- insert:",
        "    - id: codex-bridge",
        "      name: 'dsh-codex-bridge'",
        "      config:",
        "        path: /codex-bridge",
        "        collabPath: /codex-collab",
        `        answerTimeoutMs: ${answerTimeoutMs}`,
        ...(inboxRoot === null ? [] : [`        inboxRoot: ${JSON.stringify(inboxRoot.replace(/\\/g, "/"))}`]),
        "        bindings:",
        ...(bindingLines.length > 0 ? bindingLines : ["          []"]),
        ...scriptedLines,
        ""
    ].join("\n");
    fs.writeFileSync(patchFile, patch, "utf8");

    const out = fs.openSync(logFile, "a");
    // Controller credentials resolve from the launch environment, so the fixture supplies its own
    // throwaway tokens here. They are test-only values for a disposable home and are never written to
    // the profile, the session, or the repository.
    const credentialEnv = {};
    for (const entry of controllerTokens) {
        if (typeof entry.tokenRef === "string" && typeof entry.token === "string") credentialEnv[entry.tokenRef] = entry.token;
    }
    // Usage is `dsh [--profile] <name> [options]`: the profile is the first positional.
    const child = spawn(NODE, [DSH_ENTRY, "--profile", "web", "--patch", patchFile, "--port", String(port), "--no-open"], {
        env: { ...process.env, DSH_HOME: home, ...credentialEnv },
        stdio: ["ignore", out, out]
    });

    const deadline = Date.now() + timeoutMs;
    let url = null;
    while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 400));
        const text = fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8") : "";
        const match = text.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s)]+/g);
        if (match && match.length > 0) { url = match.at(-1); break; }
        if (child.exitCode !== null) break;
    }

    // A child that exits immediately means the instance never started; report THAT, with its log, rather
    // than blaming the launch URL or waiting out the full deadline.
    if (child.exitCode !== null) {
        const text = fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8").slice(-2500) : "(no log)";
        try { fs.closeSync(out); } catch { /* already closed */ }
        throw new Error(`instance exited immediately (code ${child.exitCode}) on port ${port}. Log:\n${text}`);
    }

    /**
     * Stop the instance and leave nothing behind.
     *
     * Bounded and verified rather than best-effort: the child is asked to terminate, its exit is awaited
     * up to a deadline, the process is force-killed only if it did not go, and then this run's own
     * temporary directory is removed and its absence confirmed. Failing to clean up is reported, so a
     * leaked process or directory cannot be mistaken for a tidy run. Only paths inside this run's own
     * temp directory are ever touched.
     *
     * @param {object} [options] - stop options.
     * @param {boolean} [options.keepLog] - keep the temp directory (for diagnosing a failure).
     * @returns {Promise<{stopped: boolean, dirRemoved: boolean, residue: ReadonlyArray<string>}>} what actually happened.
     */
    async function stop({ keepLog = false } = {}) {
        const exited = await waitForExit(child, 8000);
        if (!exited) {
            try { child.kill("SIGKILL"); } catch { /* already gone */ }
            await waitForExit(child, 4000);
        }
        try { fs.closeSync(out); } catch { /* already closed */ }
        if (keepLog) return { stopped: true, dirRemoved: false, residue: [] };
        // Guard: only ever delete a directory this run created, identified by the mkdtemp prefix.
        const residue = [];
        if (path.dirname(workDir) !== os.tmpdir() || !path.basename(workDir).startsWith("collab-instance-")) {
            residue.push(workDir);
            return { stopped: true, dirRemoved: false, residue };
        }
        try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* verified below */ }
        if (fs.existsSync(workDir)) residue.push(workDir);
        return { stopped: true, dirRemoved: !fs.existsSync(workDir), residue };
    }

    if (url === null) {
        const text = fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8").slice(-2500) : "(no log)";
        await stop({ keepLog: true });
        throw new Error(`instance did not publish a launch URL on port ${port}. Log tail:\n${text}`);
    }

    return { port, url, home, workDir, logFile, patchFile, stop, pluginLoaded: true, child };
}

/**
 * Wait, within a bound, for a child process to exit.
 * @param {import("node:child_process").ChildProcess} child - the process.
 * @param {number} timeoutMs - how long to wait.
 * @returns {Promise<boolean>} whether it had exited.
 */
async function waitForExit(child, timeoutMs) {
    if (child.exitCode !== null || child.signalCode !== null) return true;
    return await new Promise((resolve) => {
        let done = false;
        const finish = (value) => { if (!done) { done = true; clearTimeout(timer); child.removeListener("exit", onExit); resolve(value); } };
        const onExit = () => finish(true);
        const timer = setTimeout(() => finish(false), timeoutMs);
        child.once("exit", onExit);
    });
}
