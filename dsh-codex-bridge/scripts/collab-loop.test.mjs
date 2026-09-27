/**
 * Integration proof for the DS-asks / Codex-answers loop and the wait-any signal layer.
 *
 * Everything runs against a real instance with a scripted provider, so the production tool dispatcher,
 * session log, projections and route admission are all the real ones. The two sessions used exist only
 * in this disposable home; no other session is touched.
 *
 * Run: node scripts/collab-loop.test.mjs
 *
 * @module dsh-codex-bridge/scripts/collab-loop.test
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { startIsolatedInstance, stopIsClean } from "./isolated-instance.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(here, "..");
// scripts/ -> dsh-codex-bridge/ -> deepseek_plugin/ -> _tools/ -> workspace root
const repoRoot = path.resolve(here, "..", "..", "..", "..");
const clientEntry = path.join(repoRoot, "chaossa_fix1_mysql_metadata", ".agents", "skills", "deepseek-harness-session-control", "scripts", "dsh-control.mjs");
const { DshClient } = await import(pathToFileURL(clientEntry).href);

const results = [];
/** @param {string} name - assertion name. @param {boolean} ok - outcome. @param {string} [detail] - observation. */
function record(name, ok, detail) {
    results.push({ name, ok, detail });
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  ${detail}` : ""}`);
}

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "collab-proof-"));
const inboxRoot = path.join(workDir, "inbox");
const dirA = path.join(workDir, "projA");
const dirB = path.join(workDir, "projB");
fs.mkdirSync(dirA, { recursive: true });
fs.mkdirSync(dirB, { recursive: true });

const sessionA = "session-collab-a";
const sessionB = "session-collab-b";
const question = "Should the retry use exponential backoff?";

const inst = await startIsolatedInstance({
    pluginRoot,
    bindings: [
        { bindingId: "codex::a", sessionId: sessionA, cwd: dirA, controller: "codex", tokenRef: "TEST_CONTROLLER_TOKEN_CODEX" },
        { bindingId: "codex::b", sessionId: sessionB, cwd: dirB, controller: "codex", tokenRef: "TEST_CONTROLLER_TOKEN_CODEX" }
    ],
    controllerTokens: [{ controller: "codex", tokenRef: "TEST_CONTROLLER_TOKEN_CODEX", token: "test-controller-codex-secret" }],
    answerTimeoutMs: 30_000,
    scripted: { question },
    inboxRoot
});

try {
    const url = new URL(inst.url);
    const client = new DshClient(url, 55_000);
    await client.login();
    const cookie = client.cookie;
    /** Issue one authenticated control request. @returns {Promise<{status: number, body: object}>} the result. */
    const call = async (route, init = {}) => {
        const response = await fetch(new URL(`/codex-collab${route}`, url), {
            ...init,
            headers: { cookie, "content-type": "application/json", "x-controller-token": "test-controller-codex-secret", ...(init.headers ?? {}) }
        });
        const text = await response.text();
        let body = {};
        try { body = text.length > 0 ? JSON.parse(text) : {}; } catch { body = { raw: text.slice(0, 200) }; }
        return { status: response.status, body };
    };
    console.log(`instance: ${url.origin}`);

    // Both sessions are created in their own bound directories.
    await client.rpc("session/create", { request: { cwd: dirA, sessionId: sessionA } });
    await client.rpc("session/create", { request: { cwd: dirB, sessionId: sessionB } });

    // ---- 1) the core loop: ask -> wait -> answer -> the SAME tool call resumes -------------
    const promptA = client.rpc("session/prompt", {
        request: { sessionId: sessionA, requestId: crypto.randomUUID(), mode: "queue", content: [{ type: "text", text: `Call the tool "ask_codex" with question "${question}".` }], clientTimeZone: "Asia/Shanghai" }
    }).catch((error) => ({ error: String(error.message) }));

    const waited = await call(`/wait?sessionId=${sessionA}&controller=codex&waitMs=25000`);
    const received = (waited.body.questions ?? [])[0];
    record("the controller's wait receives the DS question", Boolean(received), received ? `id=${received.id}` : `HTTP ${waited.status}`);
    record("the received question matches what the tool asked", received?.question === question, JSON.stringify(received?.question ?? "").slice(0, 60));

    if (received) {
        // The source rule is proven HERE, on a real pending question: the caller sends `user` and the
        // recorded answer must still be the server's own `codex`. A machine cannot mint human consent.
        const answered = await call("/answer", { method: "POST", body: JSON.stringify({ questionId: received.id, text: "Yes, use exponential backoff.", source: "user", controller: "codex" }) });
        record("the controller's answer is accepted and resumes the call", answered.status === 200 && answered.body.delivered === true, `status=${answered.status} delivered=${answered.body.delivered}`);
        record("a caller-supplied `user` source is overridden by the server's own", answered.body.answer?.source === "codex", `recorded source=${answered.body.answer?.source}`);

        const repeated = await call("/answer", { method: "POST", body: JSON.stringify({ questionId: received.id, text: "Yes, use exponential backoff.", source: "codex", controller: "codex" }) });
        record("the identical answer again is idempotent, not a second delivery", repeated.status === 200 && repeated.body.idempotent === true, `idempotent=${repeated.body.idempotent}`);

        const conflict = await call("/answer", { method: "POST", body: JSON.stringify({ questionId: received.id, text: "No, use a fixed delay.", source: "codex", controller: "codex" }) });
        record("different content for an answered question conflicts", conflict.status === 409, `status=${conflict.status}`);

        const cross = await call("/answer", { method: "POST", body: JSON.stringify({ questionId: received.id, text: "hijack", source: "codex", controller: "other" }) });
        record("another controller cannot answer this binding's question", cross.status === 403, `status=${cross.status}`);
    }

    const prompted = await promptA;
    record("the DS tool call resumed instead of timing out", !prompted?.error, prompted?.error ? prompted.error.slice(0, 100) : "accepted");

    const snapshotA = await client.snapshot(sessionA, 100);
    const eventsA = snapshotA.records.map((r) => r.event).filter(Boolean);
    const askCalls = eventsA.filter((e) => e.type === "tool/call" && e.data?.name === "ask_codex");
    record("the model called ask_codex exactly once (nothing replayed)", askCalls.length === 1, `calls=${askCalls.length}`);
    const resultJson = JSON.stringify(eventsA.filter((e) => e.type === "tool/result").map((e) => e.data));
    record("the tool result carries the controller's answer", resultJson.includes("exponential backoff"), "answer present in tool/result");
    record("the answer is attributed to the controller, not to the human", resultJson.includes('"source":"codex"') || resultJson.includes('\\"source\\":\\"codex\\"'), "source recorded");

    // ---- 2) an answer cannot be labelled as the human, and unknown questions are refused -----
    // An UNKNOWN question is refused by identity (404). That alone does not prove the source rule, so
    // the source rule is proven on a REAL pending question further down: whatever a caller sends, the
    // recorded source is the server's own.
    const forged = await call("/answer", { method: "POST", body: JSON.stringify({ questionId: "nope", text: "x", source: "user", controller: "codex" }) });
    record("an unknown question is refused rather than accepted", forged.status === 404, `status=${forged.status}`);

    // ---- 3) wait-any over the controller's OWN bound sessions ------------------------------
    const backlog = await call("/wait-any?controller=codex&waitMs=1000");
    record("wait-any returns the outstanding question as backlog immediately", (backlog.body.signals ?? []).some((s) => s.kind === "question"), `signals=${JSON.stringify((backlog.body.signals ?? []).map((s) => s.kind))}`);
    record("a backlog wait does not spend the full wait window", backlog.body.waited === false, `waited=${backlog.body.waited}`);

    const otherController = await call("/wait-any?controller=someone-else&waitMs=1000");
    record("an unbound controller cannot wait on these bindings", otherController.status === 403, `status=${otherController.status}`);

    // ---- 4) an explicit notification raises a signal; a plain finished turn does not -------
    // The contract is specifically about DELIVERY: a finished turn says nothing about whether the
    // business result is complete, so it must not produce a delivery. The count of ALL signals is not the
    // right measure — the scripted provider asks a question on session B's first turn, which is a
    // legitimate question signal and not what this rule is about.
    const beforeNotify = await call("/signals?controller=codex");
    const beforeDeliveries = (beforeNotify.body.signals ?? []).filter((s) => s.kind === "delivery").length;

    await client.rpc("session/prompt", {
        request: { sessionId: sessionB, requestId: crypto.randomUUID(), mode: "queue", content: [{ type: "text", text: "Just answer briefly." }], clientTimeZone: "Asia/Shanghai" }
    });
    // Let the turn finish; a finished turn alone must NOT create a delivery signal.
    await new Promise((r) => setTimeout(r, 4000));
    const afterTurn = await call("/signals?controller=codex");
    const afterDeliveries = (afterTurn.body.signals ?? []).filter((s) => s.kind === "delivery").length;
    record("a finished turn alone does not become a delivery signal", afterDeliveries === beforeDeliveries, `deliveries before=${beforeDeliveries} after=${afterDeliveries}`);

    const notified = await call("/notify", { method: "POST", body: JSON.stringify({ sessionId: sessionB, controller: "codex", kind: "delivery", text: "slice complete" }) });
    record("an explicit delivery notification is accepted", notified.status === 200, `status=${notified.status}`);
    const afterNotify = await call("/signals?controller=codex");
    record("the explicit notification raises a delivery signal", (afterNotify.body.signals ?? []).some((s) => s.kind === "delivery"), `kinds=${JSON.stringify((afterNotify.body.signals ?? []).map((s) => s.kind))}`);

    // ---- 5) the file projection mirrors the signals ---------------------------------------
    const files = await call("/signals/files?controller=codex");
    record("the file inbox is configured and readable", files.status === 200 && files.body.configured === true, `count=${(files.body.signals ?? []).length}`);
    record("every signal is also present as a file, one per event", (files.body.signals ?? []).length === (afterNotify.body.signals ?? []).length, `files=${(files.body.signals ?? []).length} signals=${(afterNotify.body.signals ?? []).length}`);
    const fileIds = (files.body.signals ?? []).map((s) => s.id);
    record("each file carries its own unique id, so no two events share a name", new Set(fileIds).size === fileIds.length, `unique=${new Set(fileIds).size}/${fileIds.length}`);
    record("a signal file carries a reference instead of the message body", (files.body.signals ?? []).every((s) => typeof s.reference === "string"), "references present");

    // ---- 6) confirmation is separate and durable ------------------------------------------
    const target = (files.body.signals ?? [])[0];
    if (target) {
        const confirmed = await call("/signals/confirm", { method: "POST", body: JSON.stringify({ controller: "codex", signalId: target.id }) });
        record("confirmation is accepted", confirmed.status === 200 && confirmed.body.confirmed === true, `status=${confirmed.status}`);
        const afterConfirm = await call("/signals/files?controller=codex");
        record("a confirmed event is not delivered again", !(afterConfirm.body.signals ?? []).some((s) => s.id === target.id), `remaining=${(afterConfirm.body.signals ?? []).length}`);
        const reconfirm = await call("/signals/confirm", { method: "POST", body: JSON.stringify({ controller: "codex", signalId: target.id }) });
        record("confirming twice is idempotent", reconfirm.status === 200, `status=${reconfirm.status}`);
    }

    // ---- 7) wait-any returns empty on deadline without becoming an answer ------------------
    const empty = await call("/wait-any?controller=codex&waitMs=1500&acknowledged=" + encodeURIComponent((afterNotify.body.signals ?? []).map((s) => s.id).join(",")));
    record("wait-any reports no new events on deadline instead of inventing a result", empty.status === 200 && empty.body.empty === true && empty.body.reason === "no-new-events", `status=${empty.status} empty=${empty.body.empty}`);

    // ---- 8) files live under per-controller directories ------------------------------------
    const dirs = fs.existsSync(inboxRoot) ? fs.readdirSync(inboxRoot) : [];
    record("the inbox is partitioned per controller", dirs.includes("codex"), `dirs=${JSON.stringify(dirs)}`);

    // ---- 9) the anonymous caller is refused -------------------------------------------------
    const anonymous = await fetch(new URL("/codex-collab/signals?controller=codex", url));
    record("an unauthenticated caller is refused", anonymous.status === 401, `status=${anonymous.status}`);
} finally {
    // The stop receipt is asserted, not discarded: a suite must not pass while leaving a process behind.
    const outcome = await inst.stop();
    const stopVerdict = stopIsClean(outcome);
    record("the instance stopped cleanly", stopVerdict.clean, stopVerdict.problems.join("; ") || "clean");
    fs.rmSync(workDir, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\ncase_count=${results.length} passed=${results.length - failed} failed=${failed}`);
process.exitCode = failed === 0 ? 0 : 1;
