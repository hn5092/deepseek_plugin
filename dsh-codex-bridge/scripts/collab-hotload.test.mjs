/**
 * Acceptance: can a plugin be loaded into a LIVE instance without restarting the host?
 *
 * The answer decides how the bridge is deployed, so it is measured rather than assumed. The mechanism
 * found in the harness source is that a profile's `cordis.patch.yml` is watched, and a change triggers
 * `reconcileProfilePatches` -> Loader activation, which is what makes the patch layer "hot-reloaded on
 * long-lived surfaces".
 *
 * What this suite does, all on a THROWAWAY instance:
 *
 *   1. boot an instance whose overlay declares NO bridge, and confirm the bridge is genuinely absent;
 *   2. create a session and send it a message, so the session is live and has history;
 *   3. rewrite the SAME overlay file to declare the bridge, touching nothing else — no restart, no new
 *      process;
 *   4. confirm, in the SAME process, that the bridge's routes now answer, that the pre-existing session
 *      is still there with its history, and that the tool and control surface work.
 *
 * The instance is disposable, so nothing here touches the shared home or the running host.
 *
 * Run: node scripts/collab-hotload.test.mjs
 *
 * @module dsh-codex-bridge/scripts/collab-hotload.test
 */
import fs from "node:fs";
import os from "node:os";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(here, "..");
const repoRoot = path.resolve(here, "..", "..", "..", "..");
const clientEntry = path.join(repoRoot, "chaossa_fix1_mysql_metadata", ".agents", "skills", "deepseek-harness-session-control", "scripts", "dsh-control.mjs");
const { DshClient } = await import(pathToFileURL(clientEntry).href);

const results = [];
/** @param {string} name - assertion name. @param {boolean} ok - outcome. @param {string} [detail] - observation. */
function record(name, ok, detail) {
    results.push({ name, ok, detail });
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  ${detail}` : ""}`);
}

const NODE = "C:\\Program Files\\nodejs\\node.exe";
const DSH_ENTRY = path.join(process.env.APPDATA ?? "", "npm", "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "collab-hotload-"));
const home = path.join(workDir, "home");
const profileModules = path.join(home, "profiles", "node_modules");
const projDir = path.join(workDir, "proj");
const logFile = path.join(workDir, "instance.log");
const TOKEN = "test-controller-codex-secret";
const REF = "TEST_CONTROLLER_TOKEN_CODEX";
const sessionId = "session-hotload";
fs.mkdirSync(profileModules, { recursive: true });
fs.mkdirSync(projDir, { recursive: true });
fs.cpSync(pluginRoot, path.join(profileModules, "dsh-codex-bridge"), { recursive: true });

const port = await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { const p = server.address().port; server.close(() => resolve(p)); });
});

// The overlay starts with NO bridge row: the plugin is genuinely absent at boot.
//
// The file that is actually WATCHED is the profile's OWN `cordis.patch.yml`, not a `--patch` overlay:
// the boot code registers a watcher on `<profile>/cordis.patch.yml` and on `<home>/cordis.patch.yml`
// and reconciles the loader when either changes. A `--patch` file is read once at boot, so rewriting it
// proves nothing. This suite therefore writes the profile patch file directly, which is also what the
// install script patches on a real deployment.
const overlayPath = path.join(home, "profiles", "web", "cordis.patch.yml");
fs.mkdirSync(path.dirname(overlayPath), { recursive: true });
const bridgeRows = [
    "    - id: codex-bridge",
    "      name: 'dsh-codex-bridge'",
    "      config:",
    "        path: /codex-bridge",
    "        collabPath: /codex-collab",
    "        answerTimeoutMs: 20000",
    "        inboxRoot: " + JSON.stringify(path.join(workDir, "inbox").replace(/\\/g, "/")),
    "        storeRoot: " + JSON.stringify(path.join(workDir, "store").replace(/\\/g, "/")),
    "        bindings:",
    "          - bindingId: 'codex::hot'",
    `            sessionId: '${sessionId}'`,
    "            cwd: " + JSON.stringify(projDir.replace(/\\/g, "/")),
    "            controller: 'codex'",
    `            tokenRef: '${REF}'`
];
/** Write the profile patch with or without the bridge row, leaving every other line identical. */
const writeOverlay = (withBridge) => {
    const text = [
        "# Test profile patch: declares whether the bridge is loaded.",
        "- insert:",
        ...(withBridge ? bridgeRows : []),
        ""
    ].join("\n");
    fs.writeFileSync(overlayPath, text, "utf8");
};
writeOverlay(false);

const out = fs.openSync(logFile, "a");
// No `--patch`: the profile's own patch file is the hot-reloaded layer, and adding a flag overlay would
// only prove that the flag file is read once.
const child = spawn(NODE, [DSH_ENTRY, "--profile", "web", "--port", String(port), "--no-open"], {
    env: { ...process.env, DSH_HOME: home, [REF]: TOKEN },
    stdio: ["ignore", out, out]
});

/** Wait for the instance to publish its launch URL. */
const bootDeadline = Date.now() + 90_000;
let url = null;
while (Date.now() < bootDeadline) {
    await new Promise((r) => setTimeout(r, 400));
    const text = fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8") : "";
    const match = text.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s)]+/g);
    if (match && match.length > 0) { url = match.at(-1); break; }
    if (child.exitCode !== null) break;
}

try {
    record("the instance booted with the bridge ABSENT", url !== null, url === null ? "no launch URL" : "booted");
    if (url === null) throw new Error("instance did not boot");

    const client = new DshClient(new URL(url), 55_000);
    await client.login();
    const cookie = client.cookie;
    await client.rpc("session/create", { request: { cwd: projDir, sessionId } });
    await client.rpc("session/prompt", {
        request: {
            sessionId,
            requestId: crypto.randomUUID(),
            mode: "queue",
            content: [{ type: "text", text: "history before the plugin was loaded" }],
            clientTimeZone: "Asia/Shanghai"
        }
    }).catch(() => { /* the point is that the session exists, not that a model answered */ });

    // The bridge must be absent: its route does not exist.
    const absent = await fetch(new URL("/codex-bridge/health", new URL(url)), { headers: { cookie } }).then((r) => r.status).catch(() => 0);
    record("the bridge route is absent before the patch change", absent === 404, `status=${absent}`);

    const beforeCount = (await client.snapshot(sessionId, 100)).records.length;
    record("the session has history before the plugin is loaded", beforeCount > 0, `records=${beforeCount}`);
    const pidBefore = child.pid;
    const exitBefore = child.exitCode;

    // ---- the only change: rewrite the SAME overlay to declare the bridge ----------------
    writeOverlay(true);

    // Wait for the loader to pick it up. No restart is performed, and the process must not change.
    let loaded = false;
    const loadDeadline = Date.now() + 30_000;
    while (Date.now() < loadDeadline && !loaded) {
        await new Promise((r) => setTimeout(r, 500));
        const status = await fetch(new URL("/codex-bridge/health", new URL(url)), { headers: { cookie } }).then((r) => r.status).catch(() => 0);
        if (status === 200) loaded = true;
    }
    record("the bridge becomes available after the patch change, with NO restart", loaded, loaded ? "health 200" : "health never became 200");
    record("the host process is the SAME process (no restart occurred)", child.pid === pidBefore && child.exitCode === exitBefore, `pid=${child.pid} exitCode=${child.exitCode}`);

    if (loaded) {
        const health = await fetch(new URL("/codex-bridge/health", new URL(url)), { headers: { cookie } }).then((r) => r.json());
        record("the bridge reports its collaboration routes", Array.isArray(health.routes) && health.routes.some((r) => r.includes("/codex-collab")), `bindings=${health.bindings}`);

        // The pre-existing session must still be there, with its history intact.
        const afterSnapshot = await client.snapshot(sessionId, 200);
        record("the pre-existing session still exists after loading the plugin", afterSnapshot.records.length >= beforeCount, `records=${afterSnapshot.records.length} (was ${beforeCount})`);

        // The control surface must be fully usable against it.
        const call = (route, init = {}) => fetch(new URL(`/codex-collab${route}`, new URL(url)), {
            ...init,
            headers: { cookie, "content-type": "application/json", "x-controller-token": TOKEN, ...(init.headers ?? {}) }
        }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));

        const bindings = await call("/bindings?controller=codex");
        record("the loaded bridge reads its binding for the pre-existing session", bindings.status === 200 && (bindings.body.bindings ?? []).some((b) => b.sessionId === sessionId), `status=${bindings.status}`);

        const notify = await call("/notify", { method: "POST", body: JSON.stringify({ sessionId, controller: "codex", kind: "delivery", text: "loaded live" }) });
        record("the loaded bridge accepts a notification for that session", notify.status === 200, `status=${notify.status}`);
        const signals = await call("/signals?controller=codex");
        record("the notification is readable through the loaded bridge", (signals.body.signals ?? []).length >= 1, `count=${(signals.body.signals ?? []).length}`);

        const asked = await call(`/wait?sessionId=${sessionId}&controller=codex&waitMs=300`);
        record("the question channel answers on the loaded bridge", asked.status === 200, `status=${asked.status}`);
    }
} finally {
    try { child.kill("SIGTERM"); } catch { /* already gone */ }
    await new Promise((resolve) => {
        const timer = setTimeout(resolve, 6000);
        child.once("exit", () => { clearTimeout(timer); resolve(); });
    });
    if (child.exitCode === null) { try { child.kill("SIGKILL"); } catch { /* gone */ } }
    try { fs.closeSync(out); } catch { /* closed */ }
    if (fs.existsSync(workDir)) fs.rmSync(workDir, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\ncase_count=${results.length} passed=${results.length - failed} failed=${failed}`);
process.exitCode = failed === 0 ? 0 : 1;
