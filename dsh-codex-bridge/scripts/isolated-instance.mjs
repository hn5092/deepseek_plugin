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
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const NODE = "C:\\Program Files\\nodejs\\node.exe";
/** The shell used to inspect and end this run's own leftover processes on Windows. */
const POWERSHELL = "powershell.exe";
const DSH_ENTRY = path.join(process.env.APPDATA ?? "", "npm", "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
/** How long a polite stop is given before the process is forced. Bounds, not waits for their own sake. */
const STOP_GRACE_MS = 6000;
/** How long a forced kill is given to be observed. */
const STOP_FORCE_MS = 4000;
/** How long a launch may take before the instance is declared unstartable. */
const START_TIMEOUT_MS = 90_000;
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
 * @param {string|null} [options.storeRoot] - durable store root; defaults to the inbox root.
 * @param {string} [options.evidenceDir] - caller-owned directory to preserve a raw failure log into.
 * @param {object} [options.extraConfig] - extra bridge config lines, so a suite can exercise invalid values.
 * @returns {Promise<object>} the instance handle.
 */
export async function startIsolatedInstance({ pluginRoot, bindings = [], answerTimeoutMs = 20_000, timeoutMs = START_TIMEOUT_MS, scripted = null, inboxRoot = null, controllerTokens = [], home: reuseHome = undefined, storeRoot = null, evidenceDir = null, extraConfig = null }) {
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
        ...(scripted.toolName === undefined ? ["        toolName: ask_codex"] : [`        toolName: ${JSON.stringify(scripted.toolName)}`]),
        ...(scripted.question === undefined ? [] : [`        toolQuestion: ${JSON.stringify(scripted.question)}`]),
        ...(scripted.toolArguments === undefined ? [] : [`        toolArguments: ${JSON.stringify(scripted.toolArguments)}`]),        "",
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
        ...(storeRoot === null ? [] : [`        storeRoot: ${JSON.stringify(String(storeRoot).replace(/\\/g, "/"))}`]),
        // Extra config is emitted verbatim, so a suite can pass a value the bridge must refuse.
        ...(extraConfig === null ? [] : Object.entries(extraConfig).map(([key, value]) => `        ${key}: ${JSON.stringify(value)}`)),
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
    // than blaming the launch URL or waiting out the full deadline. The fd, the log and this run's own
    // scratch directory are cleaned up here too, because leaving them behind is exactly the residue the
    // rest of this fixture works to avoid.
    if (child.exitCode !== null) {
        const raw = fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8") : "(no log)";
        const preserved = typeof evidenceDir === "string" && evidenceDir.length > 0
            ? preserveEvidence(evidenceDir, "isolated-instance-exit.log", raw)
            : null;
        try { fs.closeSync(out); } catch { /* already closed */ }
        // Any helper this failed launch may have started is reaped too, then the scratch directory is
        // removed and its absence VERIFIED: a failed start must not leave residue behind while reporting
        // only that the start failed.
        const reapFail = await reapOwnProcessesDetailed([workDir, home], 4000);
        const leftoverProcesses = reapFail.remaining;
        let scratchRemoved = false;
        try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* verified next */ }
        scratchRemoved = !fs.existsSync(workDir);
        throw new Error(
            `instance exited immediately (code ${child.exitCode}) on port ${port}; scratchRemoved=${scratchRemoved}`
            + `; leftoverProcesses=${leftoverProcesses.length}; reapQueryFailed=${reapFail.queryFailed}`
            + `${preserved === null ? "" : `; raw log preserved at ${preserved}`}\nLog:\n${raw.slice(-2500)}`
        );
    }

    /**
     * Stop THIS instance's child and leave nothing behind.
     *
     * The previous version waited 8 seconds WITHOUT asking the child to stop, then force-killed it and
     * discarded whether it had exited, and finally reported `stopped: true` unconditionally. That is a
     * false receipt: it could report a clean stop for a process still running.
     *
     * This version asks the child to terminate, waits for the real exit, force-kills only if it did not
     * go within the bound, RE-CHECKS that it is gone, and reports what actually happened. Directory
     * removal is verified rather than assumed, and only directories this run created are touched.
     *
     * @param {object} [options] - stop options.
     * @param {boolean} [options.keepLog] - keep this run's scratch directory (for diagnosing a failure).
     * @returns {Promise<{stopped: boolean, exitCode: number|null, forced: boolean, dirRemoved: boolean, residue: ReadonlyArray<string>, preservedHome: string|null, leaked: ReadonlyArray<number>}>} the real outcome.
     */
    async function stop({ keepLog = false } = {}) {
        // 1) Ask this child to stop. `alreadyGone` covers a child that exited on its own.
        let gone = child.exitCode !== null || child.signalCode !== null;
        let forced = false;
        if (!gone) {
            try { child.kill("SIGTERM"); } catch { /* it may have exited between the check and the kill */ }
            gone = await waitForExit(child, STOP_GRACE_MS);
        }
        // 2) Force only if it really did not go, still bounded.
        if (!gone) {
            forced = true;
            try { child.kill("SIGKILL"); } catch { /* ditto */ }
            gone = await waitForExit(child, STOP_FORCE_MS);
        }
        // 2b) The harness starts its OWN child processes (for example a subprocess-local worker). Ending
        //     the process this fixture spawned does not necessarily end those grandchildren, and leaving
        //     one running is a real leak that a passing suite would otherwise hide. Processes whose
        //     command line names THIS run's scratch directory or home are reaped, and only those, so no
        //     unrelated process can be affected.
        const reap = await reapOwnProcessesDetailed([workDir, home], 6000);
        const leaked = reap.remaining;
        // A reap whose CHECK failed must not read as "nothing was left".
        const reapQueryFailed = reap.queryFailed;
        try { fs.closeSync(out); } catch { /* already closed */ }

        // 3) A process that did not exit must NOT be reported as stopped.
        if (!gone) {
            return { stopped: false, exitCode: child.exitCode, forced, dirRemoved: false, residue: [workDir], preservedHome: null, leaked, reapQueryFailed };
        }
        if (keepLog) return { stopped: true, exitCode: child.exitCode, forced, dirRemoved: false, residue: [], preservedHome: null, leaked, reapQueryFailed };

        // 4) Remove this run's scratch directory. A caller-owned home lives OUTSIDE it, so preserving the
        // home and cleaning the scratch are independent and neither is reported as the other's residue.
        const residue = [];
        const ownsHome = typeof reuseHome !== "string" || reuseHome.length === 0;
        const safeToRemove = path.dirname(workDir) === os.tmpdir() && path.basename(workDir).startsWith("collab-instance-");
        if (!safeToRemove) {
            residue.push(workDir);
            return { stopped: true, exitCode: child.exitCode, forced, dirRemoved: false, residue, preservedHome: null, leaked, reapQueryFailed };
        }
        try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* verified below */ }
        if (fs.existsSync(workDir)) residue.push(workDir);
        // The caller's home is reported as PRESERVED, not as residue: the caller owns it and decides when
        // it is finished with. Conflating the two would make a clean run look leaky and hide a real leak.
        const preservedHome = ownsHome ? null : home;
        return { stopped: true, exitCode: child.exitCode, forced, dirRemoved: !fs.existsSync(workDir), residue, preservedHome, leaked, reapQueryFailed };
    }

    if (url === null) {
        // Preserve the raw log into the caller's evidence location BEFORE the scratch home is removed, so
        // a failed launch is diagnosable without leaving a temporary home (which may hold credentials)
        // lying around.
        const tail = fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8").slice(-4000) : "(no log)";
        const preserved = typeof evidenceDir === "string" && evidenceDir.length > 0
            ? preserveEvidence(evidenceDir, "isolated-instance-launch-failure.log", fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8") : "(no log)")
            : null;
        const outcome = await stop();
        throw new Error(
            `instance did not publish a launch URL on port ${port} (stopped=${outcome.stopped}, residue=${outcome.residue.length})`
            + `${preserved === null ? "" : `; raw log preserved at ${preserved}`}\nLog tail:\n${tail}`
        );
    }

    return { port, url, home, workDir, logFile, patchFile, stop, pluginLoaded: true, child };
}

/**
 * Copy a log file to a caller-owned evidence location.
 *
 * Used so a failure leaves its original output behind in a place the caller names, instead of only in a
 * temporary home that is about to be deleted.
 *
 * @param {string} dir - the evidence directory (created if needed).
 * @param {string} name - the file name to write.
 * @param {string} content - the raw content.
 * @returns {string|null} the written path, or null when it could not be written.
 */
function preserveEvidence(dir, name, content) {
    try {
        fs.mkdirSync(dir, { recursive: true });
        const target = path.join(dir, name);
        fs.writeFileSync(target, content, "utf8");
        return target;
    } catch {
        return null;
    }
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

/**
 * End any process still running that belongs to THIS isolated run.
 *
 * The harness spawns its own helper processes, so ending the process this fixture started is not by
 * itself enough to guarantee nothing survives. Rather than trust that, the running process table is
 * consulted and every process whose command line names one of this run's own paths is ended — the
 * match is on paths this run created, so unrelated processes are never candidates.
 *
 * @param {ReadonlyArray<string>} ownedPaths - absolute paths that identify this run.
 * @param {number} timeoutMs - how long to wait for them to disappear.
 * @returns {Promise<{remaining: ReadonlyArray<number>, queryFailed: boolean}>} leftover PIDs and whether the check itself worked.
 */
async function reapOwnProcessesDetailed(ownedPaths, timeoutMs) {
    if (process.platform !== "win32") return { remaining: [], queryFailed: false };
    const markers = ownedPaths.filter((p) => typeof p === "string" && p.length > 0).map((p) => p.toLowerCase());
    if (markers.length === 0) return { remaining: [], queryFailed: false };
    /**
     * Snapshot the PIDs whose command line names one of this run's paths.
     *
     * A query that FAILS is reported as `failed` rather than as an empty list: an empty list means "nothing
     * is left", and returning that when the process table could not be read would turn a blind spot into a
     * false clean receipt.
     *
     * @returns {{pids: ReadonlyArray<number>, failed: boolean}} the owned PIDs and whether the query worked.
     */
    const findOwned = () => {
        const script = "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | "
            + "Where-Object { $_.CommandLine -ne $null } | "
            + "Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress";
        const result = spawnSync(POWERSHELL, ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", timeout: 20_000 });
        if (result.error !== undefined && result.error !== null) return { pids: [], failed: true };
        if (result.status !== 0) return { pids: [], failed: true };
        if (typeof result.stdout !== "string") return { pids: [], failed: true };
        // No output is a legitimate "no matching processes" only when the command itself succeeded.
        if (result.stdout.trim().length === 0) return { pids: [], failed: false };
        let rows;
        try { rows = JSON.parse(result.stdout); } catch { return { pids: [], failed: true }; }
        const list = Array.isArray(rows) ? rows : [rows];
        const pids = list
            .filter((row) => row && typeof row.CommandLine === "string")
            .filter((row) => markers.some((marker) => row.CommandLine.toLowerCase().includes(marker)))
            .map((row) => Number(row.ProcessId))
            .filter((pid) => Number.isSafeInteger(pid) && pid > 0);
        return { pids, failed: false };
    };
    /** @returns {boolean} whether the kill command itself ran. */
    const kill = (pids) => {
        if (pids.length === 0) return true;
        const script = pids.map((pid) => `Stop-Process -Id ${pid} -Force -ErrorAction SilentlyContinue`).join("; ");
        const result = spawnSync(POWERSHELL, ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", timeout: 20_000 });
        return !(result.error !== undefined && result.error !== null) && result.status === 0;
    };

    const first = findOwned();
    if (first.failed) return { remaining: [], queryFailed: true };
    if (first.pids.length === 0) return { remaining: [], queryFailed: false };
    const killed = kill(first.pids);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 250));
        const next = findOwned();
        if (next.failed) return { remaining: [], queryFailed: true };
        if (next.pids.length === 0) return { remaining: [], queryFailed: !killed };
    }
    return { remaining: first.pids, queryFailed: !killed };
}

/**
 * End any process still running that belongs to THIS isolated run.
 * @param {ReadonlyArray<string>} ownedPaths - absolute paths that identify this run.
 * @param {number} timeoutMs - how long to wait for them to disappear.
 * @returns {Promise<ReadonlyArray<number>>} the PIDs still running.
 */
async function reapOwnProcesses(ownedPaths, timeoutMs) {
    const result = await reapOwnProcessesDetailed(ownedPaths, timeoutMs);
    return result.remaining;
}

/**
 * Whether a stop receipt shows a genuinely clean stop.
 *
 * Lives here, next to the receipt it judges, so every suite asserts the SAME conditions instead of each
 * inventing a weaker check. A stop counts as clean only when the child really exited, no scratch
 * directory was left, no process of this run survived, and the leak CHECK itself worked — the last one
 * matters because a failed process query used to look identical to "nothing was left".
 *
 * @param {object} receipt - the value `stop()` returned.
 * @returns {{clean: boolean, problems: ReadonlyArray<string>}} the judgment and why.
 */
export function stopIsClean(receipt) {
    const problems = [];
    if (receipt === null || typeof receipt !== "object") return { clean: false, problems: ["no stop receipt"] };
    if (receipt.stopped !== true) problems.push(`child did not exit (exitCode=${receipt.exitCode})`);
    if ((receipt.residue ?? []).length > 0) problems.push(`residue: ${receipt.residue.join(", ")}`);
    if ((receipt.leaked ?? []).length > 0) problems.push(`leaked PIDs: ${receipt.leaked.join(", ")}`);
    if (receipt.reapQueryFailed === true) problems.push("the process check itself failed, so leaks cannot be ruled out");
    return { clean: problems.length === 0, problems };
}
