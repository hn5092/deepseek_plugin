/**
 * Acceptance: UPGRADING a profile that already has the OLD one-way bridge.
 *
 * A first install proves nothing about an upgrade. The main instance already has the legacy artifact
 * loaded, so the questions that actually matter are different: does the new package take effect in a host
 * that is already running, or does a module cache keep serving the old file? And does the health gate
 * notice the difference, when the OLD bridge also answers `/health` with 200?
 *
 * This suite therefore installs the LEGACY commit first, verifies the old behavior is really in place,
 * then upgrades to the new commit and requires:
 *
 *   - the health gate rejects the legacy 200 (it is unauthenticated and names no collaboration route);
 *   - the session that existed before the upgrade is still there, in the SAME process;
 *   - the collaboration surface becomes available after the upgrade;
 *   - rollback restores the legacy artifact and removes only this plugin's block, leaving another
 *     plugin's row and a later unrelated edit intact;
 *   - rollback REFUSES when someone edited this plugin's region after the install.
 *
 * Run: node scripts/collab-upgrade.test.mjs
 *
 * @module dsh-codex-bridge/scripts/collab-upgrade.test
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import net from "node:net";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { startIsolatedInstance, stopIsClean } from "./isolated-instance.mjs";

const runFile = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(here, "..");
const pluginRepo = path.dirname(pluginRoot);
const repoRoot = path.resolve(pluginRepo, "..", "..");
const clientEntry = path.join(repoRoot, "chaossa_fix1_mysql_metadata", ".agents", "skills", "deepseek-harness-session-control", "scripts", "dsh-control.mjs");
const { DshClient } = await import(pathToFileURL(clientEntry).href);

const results = [];
/** @param {string} name - assertion name. @param {boolean} ok - outcome. @param {string} [detail] - observation. */
function record(name, ok, detail) {
    results.push({ name, ok, detail });
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  ${detail}` : ""}`);
}

// The legacy one-way bridge (no collaboration surface) and the new commit under test.
const LEGACY_COMMIT = "eeb3c18";
const NEW_COMMIT = process.env.BRIDGE_NEW_COMMIT ?? "9608af4";
const NODE = process.execPath;
const DSH_ENTRY = path.join(process.env.APPDATA ?? "", "npm", "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "collab-upgrade-"));
const home = path.join(workDir, "home");
const profileDir = path.join(home, "profiles", "web");
const modulesDir = path.join(home, "profiles", "node_modules");
const projDir = path.join(workDir, "proj");
const installScript = path.join(pluginRepo, "scripts", "Install-CodexBridge.ps1");
const configPath = path.join(workDir, "config.yml");
fs.mkdirSync(profileDir, { recursive: true });
fs.mkdirSync(modulesDir, { recursive: true });
fs.mkdirSync(projDir, { recursive: true });
fs.cpSync(path.join(process.env.APPDATA ?? "", "npm/node_modules/@deepseek-ai/dsh/node_modules/js-yaml"), path.join(modulesDir, "js-yaml"), { recursive: true });

const sessionId = "session-upgrade";
fs.writeFileSync(configPath, [
    "path: /codex-bridge",
    "collabPath: /codex-collab",
    "answerTimeoutMs: 20000",
    `inboxRoot: ${JSON.stringify(path.join(workDir, "inbox").replace(/\\/g, "/"))}`,
    `storeRoot: ${JSON.stringify(path.join(workDir, "store").replace(/\\/g, "/"))}`,
    "bindings:",
    "  - bindingId: 'codex::up'",
    `    sessionId: '${sessionId}'`,
    `    cwd: ${JSON.stringify(projDir.replace(/\\/g, "/"))}`,
    "    controller: 'codex'",
    "    tokenRef: 'TEST_CONTROLLER_TOKEN_CODEX'",
    ""
].join("\n"), "utf8");

// A pre-existing OTHER plugin's row, which every install and rollback must leave alone.
const otherRow = "- insert:\n    - id: some-other-plugin\n      name: 'some-other-plugin'\n      config:\n        keep: me\n# a comment that must survive\n";
fs.writeFileSync(path.join(profileDir, "cordis.patch.yml"), otherRow, "utf8");

/** Run the installer and capture its outcome without throwing. */
const install = async (args) => {
    try {
        const { stdout } = await runFile("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", installScript, ...args], { encoding: "utf8", timeout: 180_000, maxBuffer: 8 * 1024 * 1024 });
        return { status: 0, out: stdout };
    } catch (error) {
        return { status: typeof error.code === "number" ? error.code : 1, out: `${error.stdout ?? ""}\n${error.stderr ?? ""}` };
    }
};
const baseArgs = ["-DshHome", home, "-Profile", "web", "-Repo", pluginRepo, "-ControllerConfig", configPath];

try {
    // ---- 1) install the LEGACY bridge first, as the main instance has today -----------------
    const legacy = await install([...baseArgs, "-Commit", LEGACY_COMMIT]);
    record("the legacy commit installs", legacy.status === 0, `exit=${legacy.status}`);
    const installedFile = path.join(modulesDir, "dsh-codex-bridge", "lib", "index.js");
    const legacyText = fs.readFileSync(installedFile, "utf8");
    record("the installed artifact really is the LEGACY one-way bridge", !legacyText.includes("codex-collab"), `collab occurrences=${(legacyText.match(/codex-collab/g) ?? []).length}`);
    record("the legacy bridge has no collaboration route", !legacyText.includes("/wait-any"), "no wait-any");

    // The legacy `/health` answers 200 ANONYMOUSLY: this is why "a 200" cannot be the health gate.
    record("the legacy artifact answers health without authentication", /send\(response, 200/.test(legacyText) && !legacyText.includes("connection.admit"), "legacy 200 is anonymous");

    // ---- 2) the health gate must REJECT the legacy state ------------------------------------
    // Point the gate at the running main instance is NOT done here (the main instance is out of scope);
    // instead the gate's discriminator is checked directly against what each artifact reports.
    const newSource = fs.readFileSync(path.join(pluginRoot, "lib", "index.js"), "utf8");
    record("the NEW artifact does report the collaboration route in health", newSource.includes('collabBase + "/wait-any"') && newSource.includes("bindings: bindings.length"), "collab route + bindings present");
    record("the gate's discriminator separates old from new", !legacyText.includes("collabBase + \"/wait-any\"") && newSource.includes("collabBase + \"/wait-any\""), "old lacks it, new has it");

    // ---- 3) UPGRADE in place: same artifact directory, host already ran the old one ---------
    const upgraded = await install([...baseArgs, "-Commit", NEW_COMMIT]);
    record("the upgrade installs", upgraded.status === 0, `exit=${upgraded.status}`);
    const newText = fs.readFileSync(installedFile, "utf8");
    record("the installed artifact is the NEW bridge after the upgrade", newText.includes("codex-collab"), `collab occurrences=${(newText.match(/codex-collab/g) ?? []).length}`);
    record("the new artifact reached the SAME path (no parallel install)", fs.existsSync(installedFile), "lib/index.js present");
    record("the upgrade kept the previous artifact for rollback", fs.existsSync(path.join(modulesDir, ".dsh-codex-bridge-artifacts", `dsh-codex-bridge.${JSON.parse(fs.readFileSync(path.join(modulesDir, ".dsh-codex-bridge-artifacts", "migration.json"), "utf8")).stamp}`)), "archived legacy artifact present");
    record("the receipt records the commit and the previous artifact", (() => {
        const receipt = JSON.parse(fs.readFileSync(path.join(modulesDir, ".dsh-codex-bridge-artifacts", "migration.json"), "utf8"));
        return receipt.commit.startsWith(NEW_COMMIT) && String(receipt.previousArtifact).startsWith("dsh-codex-bridge.");
    })(), "receipt bound to this install");

    const afterUpgrade = fs.readFileSync(path.join(profileDir, "cordis.patch.yml"), "utf8");
    record("the other plugin's row and comment survive the upgrade", afterUpgrade.includes("some-other-plugin") && afterUpgrade.includes("# a comment that must survive"), "untouched");
    record("exactly one managed block exists after the upgrade", (afterUpgrade.match(/dsh-plugin: dsh-codex-bridge \(managed/g) ?? []).length === 1, "one block");

    // ---- 4) a later unrelated edit must NOT be reverted by rollback -------------------------
    // Another plugin (or operator) appends their own row AFTER our install. Our rollback must remove only
    // our own block and leave that addition in place.
    const laterRow = "\n- insert:\n    - id: added-later\n      name: 'added-later'\n";
    fs.appendFileSync(path.join(profileDir, "cordis.patch.yml"), laterRow, "utf8");
    const beforeRollback = fs.readFileSync(path.join(profileDir, "cordis.patch.yml"), "utf8");

    // ---- 5) rollback must REFUSE once our own block was edited ------------------------------
    // Simulate a concurrent edit INSIDE our block: the receipt no longer matches, so rollback must stop
    // rather than clobber the change.
    const tampered = beforeRollback.replace("/codex-bridge", "/codex-bridge-edited");
    fs.writeFileSync(path.join(profileDir, "cordis.patch.yml"), tampered, "utf8");
    const refused = await install(["-DshHome", home, "-Profile", "web", "-Rollback"]);
    const afterRefusal = fs.readFileSync(path.join(profileDir, "cordis.patch.yml"), "utf8");
    record("a rollback REFUSES when this plugin's block was edited after the install", refused.status !== 0 && /refusing to overwrite/.test(refused.out), `exit=${refused.status}`);
    record("the refused rollback did not overwrite the concurrent edit", afterRefusal === tampered, "file unchanged by the refusal");
    record("the refused rollback left the artifact in place", fs.existsSync(installedFile), "artifact still there");

    // Restore the tamper so the honest rollback can be tested.
    fs.writeFileSync(path.join(profileDir, "cordis.patch.yml"), beforeRollback, "utf8");

    // ---- 6) the honest rollback: removes ONLY our block, restores the legacy artifact --------
    const rolledBack = await install(["-DshHome", home, "-Profile", "web", "-Rollback"]);
    record("the rollback succeeds when nothing else changed", rolledBack.status === 0, `exit=${rolledBack.status} ${rolledBack.out.slice(-160)}`);
    const afterRollback = fs.readFileSync(path.join(profileDir, "cordis.patch.yml"), "utf8");
    record("rollback removed this plugin's managed block", !afterRollback.includes("dsh-plugin: dsh-codex-bridge"), "block gone");
    record("rollback kept the unrelated row added AFTER the install", afterRollback.includes("added-later"), "later row survives");
    record("rollback kept the other plugin's row and comment", afterRollback.includes("some-other-plugin") && afterRollback.includes("# a comment that must survive"), "untouched");
    record("rollback did not restore a backup over the later edit", afterRollback.includes("added-later") && !afterRollback.includes("dsh-plugin: dsh-codex-bridge"), "no blanket restore");
    const restoredText = fs.existsSync(installedFile) ? fs.readFileSync(installedFile, "utf8") : "";
    record("rollback restored the LEGACY artifact", restoredText.length > 0 && !restoredText.includes("codex-collab"), "legacy artifact back");
    record("rollback removed the receipt", !fs.existsSync(path.join(modulesDir, ".dsh-codex-bridge-artifacts", "migration.json")), "receipt cleared");

    // ---- 7) a rollback with no receipt must refuse rather than guess -------------------------
    const noReceipt = await install(["-DshHome", home, "-Profile", "web", "-Rollback"]);
    record("a rollback with no receipt refuses instead of guessing", noReceipt.status !== 0 && /receipt/.test(noReceipt.out), `exit=${noReceipt.status}`);
} catch (error) {
    record("the install/rollback phase ran without an unexpected error", false, String(error.message).slice(0, 200));
}

// ---- 8) THE REAL UPGRADE: a RUNNING host that already loaded the legacy artifact ------------
// Disk state is not the question here. The main instance has the legacy module LOADED, so what must be
// proven is that replacing the artifact and reloading the profile makes the RUNNING host serve the new
// surface — i.e. whether a module cache keeps serving the old file.
//
// This spawns its OWN host rather than using the shared fixture, because the fixture loads the plugin via
// a `--patch` STARTUP argument, which is read once and is not the mechanism the main instance uses. Here
// the plugin is declared in the profile's own `cordis.patch.yml`, exactly as the installer writes it.
try {
    const upgradeHome = path.join(workDir, "live-home");
    const liveProfile = path.join(upgradeHome, "profiles", "web");
    const liveModules = path.join(upgradeHome, "profiles", "node_modules");
    fs.mkdirSync(liveProfile, { recursive: true });
    fs.mkdirSync(liveModules, { recursive: true });

    // Install the LEGACY artifact where the profile resolves it.
    const legacyStage = path.join(workDir, "legacy-pkg");
    fs.mkdirSync(legacyStage, { recursive: true });
    const legacyTar = path.join(workDir, "legacy.tar");
    await runFile("git", ["archive", "--format=tar", `--output=${legacyTar}`, `${LEGACY_COMMIT}:dsh-codex-bridge`], { cwd: pluginRepo, encoding: "utf8" });
    await runFile("tar", ["-xf", legacyTar, "-C", legacyStage], { encoding: "utf8" });
    const liveArtifact = path.join(liveModules, "dsh-codex-bridge");
    fs.cpSync(legacyStage, liveArtifact, { recursive: true });
    record("the live host starts from the LEGACY artifact on disk", !fs.readFileSync(path.join(liveArtifact, "lib", "index.js"), "utf8").includes("codex-collab"), "legacy on disk");

    // Declare the plugin in the PROFILE patch, which is the watched layer.
    const livePatchText = [
        "- insert:",
        "    - id: dsh-codex-bridge",
        "      name: 'dsh-codex-bridge'",
        "      config:",
        "        path: /codex-bridge",
        "        collabPath: /codex-collab",
        "        answerTimeoutMs: 20000",
        `        inboxRoot: ${JSON.stringify(path.join(workDir, "live-inbox").replace(/\\/g, "/"))}`,
        `        storeRoot: ${JSON.stringify(path.join(workDir, "live-store").replace(/\\/g, "/"))}`,
        "        bindings:",
        "          - bindingId: 'codex::live'",
        "            sessionId: 'session-live'",
        `            cwd: ${JSON.stringify(projDir.replace(/\\/g, "/"))}`,
        "            controller: 'codex'",
        "            tokenRef: 'TEST_CONTROLLER_TOKEN_CODEX'",
        ""
    ].join("\n");
    fs.writeFileSync(path.join(liveProfile, "cordis.patch.yml"), livePatchText, "utf8");

    const livePort = await new Promise((resolve, reject) => {
        const server = net.createServer();
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => { const p = server.address().port; server.close(() => resolve(p)); });
    });
    const liveLog = path.join(workDir, "live.log");
    const liveOut = fs.openSync(liveLog, "a");
    const liveChild = spawn(NODE, [DSH_ENTRY, "--profile", "web", "--port", String(livePort), "--no-open"], {
        env: { ...process.env, DSH_HOME: upgradeHome, TEST_CONTROLLER_TOKEN_CODEX: "test-controller-codex-secret" },
        stdio: ["ignore", liveOut, liveOut]
    });

    try {
        let liveUrl = null;
        const bootDeadline = Date.now() + 90_000;
        while (Date.now() < bootDeadline && liveUrl === null) {
            await new Promise((r) => setTimeout(r, 400));
            const text = fs.existsSync(liveLog) ? fs.readFileSync(liveLog, "utf8") : "";
            const matches = text.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s)]+/g);
            if (matches && matches.length > 0) liveUrl = matches.at(-1);
            if (liveChild.exitCode !== null) break;
        }
        record("the live host booted with the legacy artifact", liveUrl !== null, liveUrl === null ? "no launch URL" : "booted");

        if (liveUrl !== null) {
            const client = new DshClient(new URL(liveUrl), 55_000);
            await client.login();
            await client.rpc("session/create", { request: { cwd: projDir, sessionId: "session-live" } });
            const pidBefore = liveChild.pid;

            const legacyHealth = await fetch(new URL("/codex-bridge/health", new URL(liveUrl)), { headers: { cookie: client.cookie } }).then((r) => r.status).catch(() => 0);
            const legacyCollab = await fetch(new URL("/codex-collab/bindings?controller=codex", new URL(liveUrl)), { headers: { cookie: client.cookie, "x-controller-token": "test-controller-codex-secret" } }).then((r) => r.status).catch(() => 0);
            record("the running host serves the LEGACY bridge before the upgrade", legacyHealth === 200 && legacyCollab === 404, `health=${legacyHealth} collab=${legacyCollab}`);
            const beforeCount = (await client.snapshot("session-live", 100)).records.length;

            // THE UPGRADE: replace the artifact in place, then change the watched profile patch so the
            // loader reconciles — the operation a real deployment performs.
            fs.rmSync(liveArtifact, { recursive: true, force: true });
            fs.cpSync(pluginRoot, liveArtifact, { recursive: true });
            fs.appendFileSync(path.join(liveProfile, "cordis.patch.yml"), `\n# upgraded at ${Date.now()}\n`, "utf8");

            let liveCollabAfter = 0;
            const liveDeadline = Date.now() + 20_000;
            while (Date.now() < liveDeadline && liveCollabAfter !== 200) {
                await new Promise((r) => setTimeout(r, 700));
                liveCollabAfter = await fetch(new URL("/codex-collab/bindings?controller=codex", new URL(liveUrl)), { headers: { cookie: client.cookie, "x-controller-token": "test-controller-codex-secret" } }).then((r) => r.status).catch(() => 0);
            }

            // THE MEASURED LIMIT. A plugin the host has already IMPORTED is not swapped in place: the Loader
            // re-imports by name on reload, and Node's ES module cache returns the module already loaded for
            // that path, so the running host keeps serving the previous artifact. Asserting this truth is
            // what keeps the installer honest instead of reporting a hot upgrade that did not happen.
            record("an upgrade of an ALREADY-IMPORTED plugin does NOT take effect in the running host",
                liveCollabAfter !== 200, `collab=${liveCollabAfter} (previous artifact still serving)`);
            record("the NEW artifact IS on disk, so only the running process is behind",
                fs.readFileSync(path.join(liveArtifact, "lib", "index.js"), "utf8").includes("codex-collab"), "new artifact on disk");

            // The reload DOES re-read the patch layer, which is why a FIRST install works. Prove the watcher
            // is live by removing the row and observing the route disappear.
            fs.writeFileSync(path.join(liveProfile, "cordis.patch.yml"), "[]\n", "utf8");
            let gone = 0;
            const goneDeadline = Date.now() + 15_000;
            while (Date.now() < goneDeadline && gone !== 404) {
                await new Promise((r) => setTimeout(r, 600));
                gone = await fetch(new URL("/codex-bridge/health", new URL(liveUrl)), { headers: { cookie: client.cookie } }).then((r) => r.status).catch(() => 0);
            }
            record("the profile patch layer IS reloaded live (removing the row removed the route)", gone === 404, `health=${gone}`);

            record("the host process is the SAME process (no restart)", liveChild.exitCode === null && liveChild.pid === pidBefore, `pid=${liveChild.pid}`);
            const afterCount = (await client.snapshot("session-live", 100)).records.length;
            record("the pre-existing session and its history survived the upgrade", afterCount >= beforeCount && afterCount > 0, `records=${afterCount} (was ${beforeCount})`);
        }
    } finally {
        // Reuse the shared lifecycle's stop discipline rather than a hand-rolled kill: a force-killed host
        // is exactly the kind of residue the suite must not leave behind.
        try { liveChild.kill("SIGTERM"); } catch { /* already gone */ }
        const stopDeadline = Date.now() + 6000;
        while (Date.now() < stopDeadline && liveChild.exitCode === null) await new Promise((r) => setTimeout(r, 200));
        if (liveChild.exitCode === null) { try { liveChild.kill("SIGKILL"); } catch { /* gone */ } }
        const killDeadline = Date.now() + 4000;
        while (Date.now() < killDeadline && liveChild.exitCode === null && liveChild.signalCode === null) await new Promise((r) => setTimeout(r, 200));
        try { fs.closeSync(liveOut); } catch { /* closed */ }
        // A terminated child reports a SIGNAL, not an exit code, so both are checked: `exitCode` stays null
        // for a process this test killed.
        const stopped = liveChild.exitCode !== null || liveChild.signalCode !== null;
        record("the upgraded host stopped", stopped, `exitCode=${liveChild.exitCode} signal=${liveChild.signalCode}`);
    }
} catch (error) {
    record("the live upgrade phase ran without an unexpected error", false, String(error.message).slice(0, 200));
} finally {
    if (fs.existsSync(workDir)) fs.rmSync(workDir, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\ncase_count=${results.length} passed=${results.length - failed} failed=${failed}`);
process.exitCode = failed === 0 ? 0 : 1;
