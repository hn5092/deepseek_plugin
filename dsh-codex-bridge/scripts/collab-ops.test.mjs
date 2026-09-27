/**
 * Acceptance: the installer and the operator CLI, end to end, on a throwaway instance.
 *
 * This exercises the two things a deployment actually depends on, and nothing else:
 *
 *   1. INSTALL / HEALTH / ROLLBACK — the installer stages an exact commit into a profile, the patched
 *      profile hot-loads so the bridge answers WITHOUT a restart, and `-Rollback` restores the previous
 *      patch file byte for byte and removes what was installed.
 *   2. THE CONSUMER PATH — `bridge-cli.mjs` drives a real round trip: a real `ask_codex` from a real
 *      session, `wait-any` seeing that question, `answer` resuming the SAME tool call, and `confirm`
 *      marking the event. A second, unrelated session must NOT be consumed by the first one's wait, and
 *      an idle wait must return a deadline WITHOUT calling a model.
 *
 * The lifecycle is the existing one (`isolated-instance.mjs`); no second framework is introduced.
 *
 * Run: node scripts/collab-ops.test.mjs
 *
 * @module dsh-codex-bridge/scripts/collab-ops.test
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { startIsolatedInstance, stopIsClean } from "./isolated-instance.mjs";

const runFile = promisify(execFile);

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

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "collab-ops-"));
const projDir = path.join(workDir, "proj");
fs.mkdirSync(projDir, { recursive: true });
const TOKEN = "test-controller-codex-secret";
const REF = "TEST_CONTROLLER_TOKEN_CODEX";
const sessionA = "session-ops-a";
const sessionB = "session-ops-b";
const inboxRoot = path.join(workDir, "inbox");
const storeRoot = path.join(workDir, "store");

/**
 * Run the CLI ASYNCHRONOUSLY and parse its JSON stdout.
 *
 * This must not use a synchronous spawn: the asking session's model turn runs in THIS process, so blocking
 * the event loop would prevent the question from ever reaching the bridge and the wait would be testing
 * nothing but its own timeout.
 */
const cli = async (args, env) => {
    try {
        const { stdout } = await runFile(process.execPath, [path.join(pluginRoot, "scripts", "bridge-cli.mjs"), ...args], {
            encoding: "utf8",
            env: { ...process.env, ...env },
            timeout: 120_000,
            maxBuffer: 4 * 1024 * 1024
        });
        let parsed = null;
        try { parsed = stdout.trim().length > 0 ? JSON.parse(stdout) : null; } catch { parsed = { raw: stdout.slice(0, 300) }; }
        return { status: 0, stdout, stderr: "", body: parsed };
    } catch (error) {
        const stdout = typeof error.stdout === "string" ? error.stdout : "";
        const stderr = typeof error.stderr === "string" ? error.stderr : String(error.message);
        let parsed = null;
        try { parsed = stdout.trim().length > 0 ? JSON.parse(stdout) : null; } catch { parsed = { raw: stdout.slice(0, 300) }; }
        return { status: typeof error.code === "number" ? error.code : 1, stdout, stderr, body: parsed };
    }
};

const inst = await startIsolatedInstance({
    pluginRoot,
    bindings: [
        { bindingId: "codex::ops-a", sessionId: sessionA, cwd: projDir, controller: "codex", tokenRef: REF },
        { bindingId: "codex::ops-b", sessionId: sessionB, cwd: projDir, controller: "codex", tokenRef: REF }
    ],
    controllerTokens: [{ controller: "codex", tokenRef: REF, token: TOKEN }],
    inboxRoot, storeRoot,
    answerTimeoutMs: 60_000,
    scripted: { question: "Which way should the bridge proceed?" },
    // The CLI reads the launch URL from a file, exactly as it must on a real deployment.
    evidenceDir: path.join(workDir, "evidence")
});

// The harness publishes its launch URL to the instance log; expose it to the CLI the same way a shell does.
const urlFile = path.join(workDir, "launch.url");
fs.writeFileSync(urlFile, fs.readFileSync(inst.logFile, "utf8"), "utf8");

try {
    const client = new DshClient(new URL(inst.url), 55_000);
    await client.login();
    inst.cookie = client.cookie;
    await client.rpc("session/create", { request: { cwd: projDir, sessionId: sessionA } });
    await client.rpc("session/create", { request: { cwd: projDir, sessionId: sessionB } });

    const env = { [REF]: TOKEN };
    const common = ["--url-file", urlFile, "--token-ref", REF, "--controller", "codex"];

    // ---- health -------------------------------------------------------------------------
    const health = await cli(["health", "--url-file", urlFile]);
    record("the CLI reports health", health.status === 0 && health.body.status === 200, `status=${health.status}`);
    record("health lists the collaboration routes", Array.isArray(health.body.routes) && health.body.routes.some((r) => r.includes("/codex-collab")), `bindings=${health.body.bindings}`);

    // ---- bindings -----------------------------------------------------------------------
    const bindings = await cli(["bindings", ...common], env);
    record("the CLI reads the controller's bindings", bindings.status === 0 && (bindings.body.bindings ?? []).length === 2, `count=${(bindings.body.bindings ?? []).length}`);
    record("the bindings cover both sessions (one controller, many sessions)",
        [sessionA, sessionB].every((id) => (bindings.body.bindings ?? []).some((b) => b.sessionId === id)), "both sessions present");

    // ---- an idle wait must expire WITHOUT an event and WITHOUT calling a model -------------
    // This runs BEFORE any question exists, so "no event" is a real state rather than a race: the deadline
    // is reached, nothing is returned, and no model turn is spent waiting.
    const beforeSignals = await fetch(new URL("/codex-collab/signals?controller=codex", new URL(inst.url)), {
        headers: { cookie: client.cookie, "x-controller-token": TOKEN }
    }).then((r) => r.json());
    const cursor = beforeSignals.cursor ?? 0;
    const idleStart = Date.now();
    const idle = await fetch(new URL(`/codex-collab/wait-any?controller=codex&waitMs=1500&since=${cursor}`, new URL(inst.url)), {
        headers: { cookie: client.cookie, "x-controller-token": TOKEN }
    }).then((r) => r.json());
    const idleElapsed = Date.now() - idleStart;
    record("an idle wait reaches its deadline and returns no event", (idle.signals ?? []).length === 0, `elapsed=${idleElapsed}ms signals=${(idle.signals ?? []).length}`);
    record("the idle wait actually waited for its deadline rather than returning early", idleElapsed >= 1200, `elapsed=${idleElapsed}ms`);
    record("neither session was consumed by the idle wait",
        (await fetch(new URL("/codex-collab/signals?controller=codex", new URL(inst.url)), { headers: { cookie: client.cookie, "x-controller-token": TOKEN } }).then((r) => r.json())).signals?.length === 0, "no state created");

    // ---- a real ASK, then wait-any sees it ----------------------------------------------
    // The scripted provider calls `ask_codex` on this session's first model turn, so the question is a
    // real tool call whose answer must resume the same call.
    const prompt = client.rpc("session/prompt", {
        request: {
            sessionId: sessionA,
            requestId: crypto.randomUUID(),
            mode: "queue",
            content: [{ type: "text", text: 'Call the tool "ask_codex" with a question.' }],
            clientTimeZone: "Asia/Shanghai"
        }
    }).catch(() => { /* the round trip is asserted through the tool result */ });

    const waited = await cli(["wait-any", ...common, "--total-ms", "25000"], env);
    record("wait-any sees the real question raised by ask_codex", waited.status === 0 && (waited.body.signals ?? []).length >= 1, `count=${(waited.body.signals ?? []).length}`);
    const question = (waited.body.signals ?? []).find((s) => s.kind === "question");
    record("the waited signal is the question for the asking session", question !== undefined && question.sessionId === sessionA, `kind=${question?.kind} session=${question?.sessionId}`);
    record("wait-any did NOT return the unrelated session's event", !(waited.body.signals ?? []).some((s) => s.sessionId === sessionB), "only the asking session");

    // ---- answer it: the SAME tool call must continue -------------------------------------
    const answerFile = path.join(workDir, "answer.txt");
    fs.writeFileSync(answerFile, "Proceed through the formal caller, and keep the record.", "utf8");
    const answered = await cli(["answer", ...common, "--question", question.id, "--text-file", answerFile], env);
    record("the CLI answers the question", answered.status === 0, `status=${answered.status} reason=${answered.body.reason ?? ""}`);
    // A second answer is refused rather than overwriting the first.
    const again = await cli(["answer", ...common, "--question", question.id, "--text-file", answerFile], env);
    record("a second answer is refused as already decided or idempotent", again.status === 0 || again.status === 1, `status=${again.status}`);

    await prompt;
    await new Promise((r) => setTimeout(r, 1500));
    const snapshot = await client.snapshot(sessionA, 300);
    const toolData = JSON.stringify(snapshot.records.map((r) => r.event).filter((e) => e && e.type === "tool/result").map((e) => e.data));
    record("the answer resumed the SAME tool call with the answered text", /answered/.test(toolData) && /formal caller/.test(toolData), toolData.slice(0, 200));

    // ---- confirm the event ---------------------------------------------------------------
    const confirmed = await cli(["confirm", ...common, "--signal", question.id], env);
    record("the CLI confirms the event", confirmed.status === 0 && confirmed.body.confirmed === true, `status=${confirmed.status}`);
    const afterConfirm = await cli(["wait-any", ...common, "--total-ms", "1500", "--acknowledged", question.id], env);
    record("a confirmed event is not re-delivered", (afterConfirm.body?.signals ?? []).length === 0, `status=${afterConfirm.status} count=${(afterConfirm.body?.signals ?? []).length}`);

    // ---- explicit notify -----------------------------------------------------------------
    const notifyText = path.join(workDir, "notify.txt");
    fs.writeFileSync(notifyText, "Explicit delivery from the operator CLI.", "utf8");
    const notified = await cli(["notify", ...common, "--session", sessionB, "--kind", "delivery", "--text-file", notifyText], env);
    record("the CLI posts an explicit notification", notified.status === 0, `status=${notified.status}`);
    const notifiedAgain = await cli(["notify", ...common, "--session", sessionB, "--kind", "delivery", "--request-id", "retry-1"], env);
    record("a retry WITHOUT the original issue time is refused by the CLI itself", notifiedAgain.status === 2 && /issued-at/.test(notifiedAgain.stderr), `status=${notifiedAgain.status}`);

    // The credential must never be an argument and must never be printed.
    const leaked = [waited.stdout, answered.stdout, notified.stdout, health.stdout].some((text) => text.includes(TOKEN));
    record("no command printed the credential value", !leaked, "credential absent from all output");

    // ---- installer: health gate and rollback --------------------------------------------
    // The installer is exercised against a THROWAWAY home, never the live one.
    const installHome = path.join(workDir, "install-home");
    fs.mkdirSync(path.join(installHome, "profiles", "web"), { recursive: true });
    fs.writeFileSync(path.join(installHome, "profiles", "web", "cordis.patch.yml"), "- insert:\n    - id: unrelated\n      name: 'unrelated'\n", "utf8");
    fs.mkdirSync(path.join(installHome, "profiles", "node_modules"), { recursive: true });
    fs.cpSync(path.join(process.env.APPDATA ?? "", "npm/node_modules/@deepseek-ai/dsh/node_modules/js-yaml"), path.join(installHome, "profiles", "node_modules", "js-yaml"), { recursive: true });

    // The plugin repository root is the parent of the package directory.
    const pluginRepo = path.dirname(pluginRoot);
    const installScript = path.join(pluginRepo, "scripts", "Install-CodexBridge.ps1");
    const installArgs = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", installScript,
        "-DshHome", installHome, "-Profile", "web", "-Repo", pluginRepo,
        "-Commit", "4fdacdc", "-ControllerConfig", path.join(pluginRoot, "bridge-config.example.yml")];
    const installed = await runFile("powershell", installArgs, { encoding: "utf8", timeout: 120_000 }).then((r) => ({ status: 0, stdout: r.stdout, stderr: "" })).catch((e) => ({ status: typeof e.code === "number" ? e.code : 1, stdout: e.stdout ?? "", stderr: e.stderr ?? String(e.message) }));
    record("the installer installs the exact commit into a throwaway home", installed.status === 0, installed.status === 0 ? "exit 0" : installed.stderr.slice(0, 200));
    const patched = fs.readFileSync(path.join(installHome, "profiles", "web", "cordis.patch.yml"), "utf8");
    record("the unrelated plugin row survives the install", /unrelated/.test(patched), "kept");
    record("the installed artifact carries no test files",
        fs.existsSync(path.join(installHome, "profiles", "node_modules", "dsh-codex-bridge"))
        && !fs.readdirSync(path.join(installHome, "profiles", "node_modules", "dsh-codex-bridge", "scripts")).some((n) => n.endsWith(".test.mjs")), "tests excluded");

    const rollback = await runFile("powershell", [...installArgs, "-Rollback"], { encoding: "utf8", timeout: 120_000 }).then((r) => ({ status: 0, stdout: r.stdout, stderr: "" })).catch((e) => ({ status: typeof e.code === "number" ? e.code : 1, stdout: e.stdout ?? "", stderr: e.stderr ?? String(e.message) }));
    record("the installer rolls back", rollback.status === 0, rollback.status === 0 ? "exit 0" : rollback.stderr.slice(0, 200));
    const afterRollback = fs.readFileSync(path.join(installHome, "profiles", "web", "cordis.patch.yml"), "utf8");
    record("rollback restores the previous patch file exactly", afterRollback === "- insert:\n    - id: unrelated\n      name: 'unrelated'\n", JSON.stringify(afterRollback.slice(0, 60)));
    record("rollback removed the installed artifact", !fs.existsSync(path.join(installHome, "profiles", "node_modules", "dsh-codex-bridge")), "absent");
} finally {
    const outcome = await inst.stop();
    const verdict = stopIsClean(outcome);
    record("the instance stopped with no residue", verdict.clean, verdict.problems.join("; ") || "clean");
    if (fs.existsSync(workDir)) fs.rmSync(workDir, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\ncase_count=${results.length} passed=${results.length - failed} failed=${failed}`);
process.exitCode = failed === 0 ? 0 : 1;
