/**
 * Acceptance: a REAL pending question survives a restart, and its signal is rebuilt with it.
 *
 * This is the case a previous round only pretended to cover. Two HTTP notifications are not a question,
 * and a question whose signal was never persisted is invisible after a restart even though its own record
 * survived — `wait-any` returns nothing and `confirm` reports an unknown event. So this suite:
 *
 *   1. drives a REAL `ask_codex` tool call in a bound session, which leaves the question PENDING;
 *   2. really stops that host and starts a NEW process against the SAME home;
 *   3. requires the pending question to still be visible, to be offered by `wait-any`, and its signal to
 *      be something `confirm` recognizes — i.e. the question and its signal recovered as one identity;
 *   4. requires the answer to be accepted and recorded, with `delivered:false` making clear that no tool
 *      from the dead process was resumed.
 *
 * Run: node scripts/collab-pending-restart.test.mjs
 *
 * @module dsh-codex-bridge/scripts/collab-pending-restart.test
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { startIsolatedInstance } from "./isolated-instance.mjs";

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

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "collab-pending-"));
const projDir = path.join(workDir, "proj");
fs.mkdirSync(projDir, { recursive: true });
const sessionId = "session-pending";
const TOKEN = "test-controller-codex-secret";
const REF = "TEST_CONTROLLER_TOKEN_CODEX";
const question = "Should the migration run in one transaction?";
const bindings = [{ bindingId: "codex::pending", sessionId, cwd: projDir, controller: "codex", tokenRef: REF }];
const controllerTokens = [{ controller: "codex", tokenRef: REF, token: TOKEN }];

/** One control request as the controller. */
const callOn = (inst, route, init = {}) => fetch(new URL(`/codex-collab${route}`, new URL(inst.url)), {
    ...init,
    headers: { cookie: inst.cookie, "content-type": "application/json", "x-controller-token": TOKEN, ...(init.headers ?? {}) }
}).then(async (response) => ({ status: response.status, body: await response.json().catch(() => ({})) }));

const first = await startIsolatedInstance({
    pluginRoot, bindings, controllerTokens,
    inboxRoot: path.join(workDir, "inbox"),
    storeRoot: path.join(workDir, "store"),
    // The home is created by THIS suite and sits outside every scratch directory, so "the scratch is
    // clean" and "the home was preserved" are two independent facts instead of one confusing number.
    home: path.join(workDir, "home"),
    // A scripted model is what lets a real model call reach the tool in a home with no credentials.
    scripted: { question },
    answerTimeoutMs: 20_000
});
const sharedHome = first.home;
/** The pending question id, captured in the first phase and asserted in the second. */
let pendingId = null;

try {
    const client = new DshClient(new URL(first.url), 55_000);
    await client.login();
    first.cookie = client.cookie;
    await client.rpc("session/create", { request: { cwd: projDir, sessionId } });

    // 1) A REAL ask leaves the question pending: the tool is waiting, nothing has answered it.
    const promptDone = client.rpc("session/prompt", {
        request: {
            sessionId,
            requestId: crypto.randomUUID(),
            mode: "queue",
            content: [{ type: "text", text: `Call the tool "ask_codex" with question "${question}".` }],
            clientTimeZone: "Asia/Shanghai"
        }
    }).catch((error) => ({ error: String(error.message) }));
    void promptDone;

    // Wait until the question is genuinely pending, observed through the public surface.
    let pending = null;
    for (let i = 0; i < 40 && pending === null; i += 1) {
        await new Promise((r) => setTimeout(r, 500));
        const listed = await callOn(first, `/questions?sessionId=${sessionId}&controller=codex`);
        pending = (listed.body.questions ?? []).find((q) => q.state && q.state.status === "pending") ?? null;
    }
    record("a real ask_codex call leaves a pending question", pending !== null, pending ? `id=${pending.id}` : "no pending question observed");

    const beforeSignals = await callOn(first, "/signals?controller=codex");
    const questionSignal = (beforeSignals.body.signals ?? []).find((s) => s.kind === "question");
    record("the pending question has a signal BEFORE the restart", Boolean(questionSignal), `kinds=${JSON.stringify((beforeSignals.body.signals ?? []).map((s) => s.kind))}`);
    pendingId = pending === null ? null : pending.id;

    // 2) Really stop this host, keeping the shared home.
    const stopped = await first.stop({ keepLog: true });
    record("the host holding the pending question really stopped", stopped.stopped === true, `stopped=${stopped.stopped} exit=${stopped.exitCode}`);
} catch (error) {
    record(`the pre-restart phase completed: ${String(error.message).slice(0, 100)}`, false, "see raw output");
} finally {
    // The first host is already stopped in the happy path; stopping twice is harmless and guarantees no
    // process survives a failure in the middle of this phase.
    try { await first.stop(); } catch { /* already gone */ }
}

// ---- restart on the SAME home ---------------------------------------------------------------
const second = await startIsolatedInstance({
    pluginRoot, bindings, controllerTokens,
    inboxRoot: path.join(workDir, "inbox"),
    storeRoot: path.join(workDir, "store"),
    scripted: { question },
    answerTimeoutMs: 8000,
    home: sharedHome
});
try {
    const client2 = new DshClient(new URL(second.url), 55_000);
    await client2.login();
    second.cookie = client2.cookie;
    await client2.rpc("session/create", { request: { cwd: projDir, sessionId } });

    // 3) The pending question must still be visible, with its signal.
    const afterQuestions = await callOn(second, `/questions?sessionId=${sessionId}&controller=codex`);
    const recovered = (afterQuestions.body.questions ?? []).find((q) => q.state && q.state.status === "pending");
    record("the pending question is still visible after the restart", Boolean(recovered), recovered ? `id=${recovered.id}` : `count=${(afterQuestions.body.questions ?? []).length}`);
    record("the recovered question keeps its identity", pendingId === null || (recovered !== undefined && recovered.id === pendingId), `before=${pendingId} after=${recovered ? recovered.id : "none"}`);

    const afterSignals = await callOn(second, "/signals?controller=codex");
    const recoveredSignal = (afterSignals.body.signals ?? []).find((s) => s.kind === "question");
    // This is the defect the previous round had: the question record survived but its SIGNAL did not, so
    // a controller waiting with wait-any was never told the question existed.
    record("the question's SIGNAL is rebuilt after the restart", Boolean(recoveredSignal), `kinds=${JSON.stringify((afterSignals.body.signals ?? []).map((s) => s.kind))}`);

    const waitAny = await callOn(second, "/wait-any?controller=codex&waitMs=1500&maxBatch=20");
    const offered = (waitAny.body.signals ?? []).find((s) => s.kind === "question");
    record("wait-any offers the recovered question instead of returning empty", Boolean(offered), `kinds=${JSON.stringify((waitAny.body.signals ?? []).map((s) => s.kind))}`);

    // 4) The recovered signal is confirmable — an unrecognized event would make confirm report unknown.
    if (recoveredSignal) {
        const confirmed = await callOn(second, "/signals/confirm", { method: "POST", body: JSON.stringify({ controller: "codex", signalId: recoveredSignal.id }) });
        record("the recovered question signal can be confirmed (it is known, not unknown)", confirmed.status === 200 && confirmed.body.confirmed === true, `status=${confirmed.status}`);
    } else {
        record("the recovered question signal can be confirmed (it is known, not unknown)", false, "no recovered signal to confirm");
    }

    // 5) Answering records the truth: no tool from the dead process is resumed.
    if (pendingId !== null) {
        const answered = await callOn(second, "/answer", { method: "POST", body: JSON.stringify({ questionId: pendingId, text: "Yes, one transaction.", source: "codex", controller: "codex" }) });
        record("the recovered question can be answered", answered.status === 200 && answered.body.ok === true, `status=${answered.status}`);
        record("the answer does NOT claim to have resumed a tool from the previous process", answered.body.delivered === false, `delivered=${answered.body.delivered}`);
        // `/questions` lists WORK, so an answered question correctly leaves that list. Durability is
        // therefore checked where the answer actually lives: a restart must still see it as answered.
        const answeredAgain = await callOn(second, `/questions?sessionId=${sessionId}&controller=codex`);
        record("an answered question is no longer offered as pending work", !(answeredAgain.body.questions ?? []).some((q) => q.id === pendingId), `pending=${(answeredAgain.body.questions ?? []).length}`);
        const repeated = await callOn(second, "/answer", { method: "POST", body: JSON.stringify({ questionId: pendingId, text: "Yes, one transaction.", source: "codex", controller: "codex" }) });
        record("re-answering the recovered question is idempotent", repeated.status === 200 && repeated.body.idempotent === true, `status=${repeated.status}`);
        const conflicting = await callOn(second, "/answer", { method: "POST", body: JSON.stringify({ questionId: pendingId, text: "No, split it up.", source: "codex", controller: "codex" }) });
        record("a different answer to the recovered question conflicts", conflicting.status === 409, `status=${conflicting.status}`);
    }
} finally {
    const outcome = await second.stop();
    // The home is caller-owned and deliberately preserved; only a leaking SCRATCH directory would be
    // this run's fault, so that is what is asserted.
    record("the restarted host stopped with no scratch residue", outcome.stopped === true && outcome.residue.length === 0, `stopped=${outcome.stopped} residue=${outcome.residue.length}`);
    record("the caller-owned home was preserved across the restart, not silently deleted", outcome.preservedHome === sharedHome, `preserved=${outcome.preservedHome === sharedHome}`);
    // Now that the whole scenario is over, the shared home is removed and verified gone.
    fs.rmSync(sharedHome, { recursive: true, force: true });
    record("the shared home is removed and verified gone", fs.existsSync(sharedHome) === false, "no residue");
    if (fs.existsSync(workDir)) fs.rmSync(workDir, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\ncase_count=${results.length} passed=${results.length - failed} failed=${failed}`);
process.exitCode = failed === 0 ? 0 : 1;
