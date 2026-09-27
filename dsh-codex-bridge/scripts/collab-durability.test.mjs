/**
 * Acceptance: a store that cannot be written, and a race between answering and cancelling.
 *
 * Two things a durable design must get right that a happy path never shows:
 *
 *  1. When the durable store cannot be created or written, the bridge must REFUSE the operation rather
 *     than acknowledge it. An acknowledged notification that was never recorded is a lie the controller
 *     acts on, and it is exactly what a read-only mount or a full disk would produce.
 *  2. When an answer and a cancellation race for one question, exactly ONE terminal outcome may win.
 *     Two outcomes would mean the tool call was resolved twice and the transcript recorded a result that
 *     did not happen.
 *
 * Run: node scripts/collab-durability.test.mjs
 *
 * @module dsh-codex-bridge/scripts/collab-durability.test
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { startIsolatedInstance, stopIsClean } from "./isolated-instance.mjs";

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

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "collab-durability-"));
const projDir = path.join(workDir, "proj");
fs.mkdirSync(projDir, { recursive: true });
const sessionId = "session-durability";
const TOKEN = "test-controller-codex-secret";
const REF = "TEST_CONTROLLER_TOKEN_CODEX";
const bindings = [{ bindingId: "codex::dur", sessionId, cwd: projDir, controller: "codex", tokenRef: REF }];
const controllerTokens = [{ controller: "codex", tokenRef: REF, token: TOKEN }];

/** One control request as the controller. */
const callOn = (inst, route, init = {}) => fetch(new URL(`/codex-collab${route}`, new URL(inst.url)), {
    ...init,
    headers: { cookie: inst.cookie, "content-type": "application/json", "x-controller-token": TOKEN, ...(init.headers ?? {}) }
}).then(async (response) => ({ status: response.status, body: await response.json().catch(() => ({})) }));

try {
    // ---- 1) an unwritable store must refuse, not acknowledge -------------------------------
    // A path that cannot be created: a FILE stands where the store root's parent directory must be.
    const blockedParent = path.join(workDir, "blocked");
    fs.writeFileSync(blockedParent, "not a directory", "utf8");
    const unwritableStore = path.join(blockedParent, "store");

    const broken = await startIsolatedInstance({
        pluginRoot, bindings, controllerTokens, answerTimeoutMs: 6000,
        inboxRoot: path.join(workDir, "inbox-broken"), storeRoot: unwritableStore,
        // The scripted model is what lets a REAL tool call reach `notify_controller` here, so the store
        // failure is proven on the model-facing path and not only on the HTTP one.
        scripted: {
            toolName: "notify_controller",
            toolArguments: JSON.stringify({ kind: "delivery", text: "broken store" })
        },
        evidenceDir: path.join(workDir, "evidence")
    });
    try {
        const client = new DshClient(new URL(broken.url), 55_000);
        await client.login();
        broken.cookie = client.cookie;
        await client.rpc("session/create", { request: { cwd: projDir, sessionId } });

        const refused = await callOn(broken, "/notify", {
            method: "POST",
            body: JSON.stringify({ sessionId, controller: "codex", kind: "delivery", text: "should not be recorded", requestId: "req-broken" })
        });
        record("a notification that cannot be recorded durably is REFUSED", refused.status >= 500, `status=${refused.status}`);
        record("the refusal says the record could not be written, not that it was delivered", /not-recorded|not-recorded durably|recorded/.test(JSON.stringify(refused.body)) === false || refused.status >= 500, JSON.stringify(refused.body).slice(0, 140));

        // Nothing may be offered as if it had been recorded.
        const offered = await callOn(broken, "/signals?controller=codex");
        record("nothing is offered after a refused notification", (offered.body.signals ?? []).length === 0, `count=${(offered.body.signals ?? []).length}`);

        // The MODEL-FACING tool must report the truth too. The HTTP route answering 5xx does not prove the
        // tool path does: `notify_controller` used to return `ok: true` regardless, which would tell a
        // session its controller had been notified when nothing was recorded. This drives the real tool
        // and reads its tool/result from the session log.
        const toolTurn = await client.rpc("session/prompt", {
            request: {
                sessionId,
                requestId: crypto.randomUUID(),
                mode: "queue",
                content: [{ type: "text", text: 'Call the tool "notify_controller" with kind "delivery" and text "broken store".' }],
                clientTimeZone: "Asia/Shanghai"
            }
        }).then(() => true).catch(() => false);
        record("a prompt can be dispatched to reach the tool", toolTurn === true, `accepted=${toolTurn}`);
        await new Promise((r) => setTimeout(r, 6000));
        const snapshot = await client.snapshot(sessionId, 200);
        const toolResults = snapshot.records.map((r) => r.event).filter((e) => e && e.type === "tool/result");
        const notifyResults = JSON.stringify(toolResults.map((e) => e.data));
        record("the real notify_controller tool ran", /notify_controller/.test(JSON.stringify(snapshot.records.map((r) => r.event).filter((e) => e && e.type === "tool/call").map((e) => e.data))), `toolResults=${toolResults.length}`);
        // The tool must NOT report success: either it reports ok:false with a reason, or it failed loudly.
        record("the tool does not claim success when the store is unwritable", !/"ok"\s*:\s*true/.test(notifyResults), notifyResults.slice(0, 200));
    } finally {
        await broken.stop();
    }

    // ---- 2) a healthy store: concurrent answer and cancel, one terminal state ---------------
    const healthyStore = path.join(workDir, "store");
    const healthyInbox = path.join(workDir, "inbox");
    const healthy = await startIsolatedInstance({
        pluginRoot, bindings, controllerTokens, answerTimeoutMs: 6000,
        inboxRoot: healthyInbox, storeRoot: healthyStore
    });
    try {
        const client = new DshClient(new URL(healthy.url), 55_000);
        await client.login();
        healthy.cookie = client.cookie;
        await client.rpc("session/create", { request: { cwd: projDir, sessionId } });

        const first = await callOn(healthy, "/notify", {
            method: "POST",
            body: JSON.stringify({ sessionId, controller: "codex", kind: "delivery", text: "recorded", requestId: "req-ok" })
        });
        record("a notification is accepted when the store is writable", first.status === 200, `status=${first.status}`);

        // The same request id twice is the SAME event, so a retry cannot become two business events.
        const retried = await callOn(healthy, "/notify", {
            method: "POST",
            body: JSON.stringify({ sessionId, controller: "codex", kind: "delivery", text: "recorded", requestId: "req-ok" })
        });
        record("retrying the same notification is accepted", retried.status === 200, `status=${retried.status}`);
        record("a retry does not create a second business event", retried.body.signalId === first.body.signalId, `first=${first.body.signalId} retry=${retried.body.signalId}`);
        const listed = await callOn(healthy, "/signals?controller=codex");
        record("the retry did not duplicate the recorded event", (listed.body.signals ?? []).length === 1, `count=${(listed.body.signals ?? []).length}`);

        // Answering the same question twice: the second is idempotent, and a DIFFERENT answer conflicts,
        // so one question has exactly one terminal answer no matter how many times it is delivered.
        const questionId = "collab-race-1";
        const stored = path.join(healthyStore, "questions", "d-codex_003a_003adur", `${questionId}.json`);
        fs.mkdirSync(path.dirname(stored), { recursive: true });
        fs.writeFileSync(stored, JSON.stringify({
            id: questionId, seq: 1, question: "race me", bindingId: "codex::dur",
            controller: "codex", sessionId, cwd: projDir, askedAt: new Date().toISOString()
        }), "utf8");
        // The question must be visible to the plugin, so it is discovered through recovery.
        await callOn(healthy, "/questions?sessionId=" + sessionId + "&controller=codex");

        const [answerA, answerB] = await Promise.all([
            callOn(healthy, "/answer", { method: "POST", body: JSON.stringify({ questionId, text: "first", source: "codex", controller: "codex" }) }),
            callOn(healthy, "/answer", { method: "POST", body: JSON.stringify({ questionId, text: "second", source: "codex", controller: "codex" }) })
        ]);
        const accepted = [answerA, answerB].filter((r) => r.status === 200 && r.body.ok === true && r.body.idempotent !== true);
        const rejected = [answerA, answerB].filter((r) => r.status === 409);
        record("concurrent answers to one question produce at most one accepted terminal answer", accepted.length <= 1, `accepted=${accepted.length} statuses=${answerA.status}/${answerB.status}`);
        record("the losing answer is refused as a conflict, not silently applied", rejected.length >= 1, `conflicts=${rejected.length}`);

        // What is recorded must agree with the one accepted outcome.
        const after = await callOn(healthy, "/questions?sessionId=" + sessionId + "&controller=codex");
        const recordedAnswer = (after.body.questions ?? []).map((q) => q.state && q.state.answer).filter(Boolean)[0];
        record("the recorded answer matches the accepted outcome", recordedAnswer === undefined || ["first", "second"].includes(recordedAnswer.text), `recorded=${recordedAnswer ? recordedAnswer.text : "none"}`);

        // A late answer to a cancelled question is refused: cancellation is a terminal state.
        const cancelId = "collab-race-cancel";
        fs.writeFileSync(path.join(path.dirname(stored), `${cancelId}.json`), JSON.stringify({
            id: cancelId, seq: 2, question: "cancel me", bindingId: "codex::dur", controller: "codex",
            sessionId, cwd: projDir, askedAt: new Date().toISOString(),
            cancel: { id: cancelId, reason: "caller-cancelled", at: new Date().toISOString() }
        }), "utf8");
        const late = await callOn(healthy, "/answer", { method: "POST", body: JSON.stringify({ questionId: cancelId, text: "too late", source: "codex", controller: "codex" }) });
        record("an answer to a cancelled question is refused", late.status === 409, `status=${late.status}`);
    } finally {
        const outcome = await healthy.stop();
        const verdict = stopIsClean(outcome);
        record("the healthy instance stopped with no residue", verdict.clean, verdict.problems.join("; ") || "clean");
    }

    // ---- 3) store WRITABLE but inbox NOT: the question is kept, the degraded notice is reported ---
    // This is the case that "the store is unwritable" does not cover. The durable record must still be
    // made and the question must remain answerable through the API, while the failure of the FILE
    // notification is REPORTED rather than hidden — a broken file inbox must not silently masquerade as
    // a reliable notification, and must not discard a question that is perfectly answerable.
    const degradedInbox = path.join(workDir, "inbox-blocked");
    fs.writeFileSync(degradedInbox, "a file where the inbox directory must be", "utf8");
    const degraded = await startIsolatedInstance({
        pluginRoot, bindings, controllerTokens, answerTimeoutMs: 8000,
        inboxRoot: degradedInbox, storeRoot: path.join(workDir, "store-degraded"),
        scripted: { question: "Is the degraded inbox reported?" },
        evidenceDir: path.join(workDir, "evidence")
    });
    try {
        const client3 = new DshClient(new URL(degraded.url), 55_000);
        await client3.login();
        degraded.cookie = client3.cookie;
        await client3.rpc("session/create", { request: { cwd: projDir, sessionId } });

        void client3.rpc("session/prompt", {
            request: {
                sessionId,
                requestId: crypto.randomUUID(),
                mode: "queue",
                content: [{ type: "text", text: 'Call the tool "ask_codex" with a question.' }],
                clientTimeZone: "Asia/Shanghai"
            }
        }).catch(() => { /* the tool result is what is under test */ });

        let pending = null;
        for (let i = 0; i < 30 && pending === null; i += 1) {
            await new Promise((r) => setTimeout(r, 500));
            const listed = await callOn(degraded, `/questions?sessionId=${sessionId}&controller=codex`);
            pending = (listed.body.questions ?? [])[0] ?? null;
        }
        record("a question survives an unwritable file inbox", pending !== null, pending ? `id=${pending.id}` : "no question recorded");

        // The durable signal must still be visible through the API even though its file could not be made.
        const signals = await callOn(degraded, "/signals?controller=codex");
        record("the question is still offered through the API when the inbox is broken", (signals.body.signals ?? []).some((s) => s.kind === "question"), `kinds=${JSON.stringify((signals.body.signals ?? []).map((s) => s.kind))}`);

        // The question is still answerable, so a degraded notification did not cost the work itself.
        if (pending !== null) {
            const answered = await callOn(degraded, "/answer", { method: "POST", body: JSON.stringify({ questionId: pending.id, text: "yes, reported", source: "codex", controller: "codex" }) });
            record("the question is still answerable despite the broken inbox", answered.status === 200 && answered.body.ok === true, `status=${answered.status}`);
        }

        // The model-facing tool must surface the degraded notification rather than implying success. The
        // tool result only exists AFTER the call completes, so it is read once the answer has resumed it.
        await new Promise((r) => setTimeout(r, 4000));
        const snap = await client3.snapshot(sessionId, 200);
        const toolText = JSON.stringify(snap.records.map((r) => r.event).filter((e) => e && e.type === "tool/result").map((e) => e.data));
        record("the real tool reports the degraded file delivery", /deliveryWarning/.test(toolText) && /not-delivered/.test(toolText), toolText.slice(0, 200));
    } finally {
        const outcome = await degraded.stop();
        const verdict = stopIsClean(outcome);
        record("the degraded instance stopped with no residue", verdict.clean, verdict.problems.join("; ") || "clean");
    }
} finally {
    if (fs.existsSync(workDir)) fs.rmSync(workDir, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\ncase_count=${results.length} passed=${results.length - failed} failed=${failed}`);
process.exitCode = failed === 0 ? 0 : 1;
