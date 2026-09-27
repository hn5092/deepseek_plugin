/**
 * Acceptance: FIVE sessions ask at once, each gets its own answer, and each original call continues.
 *
 * This is the scenario root's controller drives from the Codex side. It matters because a
 * single-session test cannot show that concurrent questions are kept apart: a provider that tracks its
 * script globally, a routing bug that mixes sessions, or an answer applied to the wrong question would
 * all pass with one session and fail here.
 *
 * Five sessions across five bound directories, each with the SAME controller, ask REAL questions through
 * the real `ask_codex` tool at the same time. The controller then receives them in batches through
 * `wait-any`, answers each by its own identity, and every original call must continue exactly once and
 * observe ITS answer.
 *
 * Run: node scripts/collab-five.test.mjs
 *
 * @module dsh-codex-bridge/scripts/collab-five.test
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

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "collab-five-"));
const TOKEN = "test-controller-codex-secret";
const REF = "TEST_CONTROLLER_TOKEN_CODEX";
const COUNT = 5;

// Five sessions, five directories, one controller. Each session must ask its OWN question, so the
// question text is a per-session marker that identifies which session spoke.
const sessions = [];
for (let i = 1; i <= COUNT; i += 1) {
    const dir = path.join(workDir, `proj-${i}`);
    fs.mkdirSync(dir, { recursive: true });
    sessions.push({
        sessionId: `session-five-${i}`,
        bindingId: `codex::five-${i}`,
        cwd: dir,
        controller: "codex",
        // `scripted-model` uses ONE toolQuestion config for every session, so the marker that identifies a
        // session cannot be the text. Identity is proven instead through the session/binding the question
        // is delivered under, which is the routing fact that actually matters.
        question: "Which migration order should this session use?"
    });
}

const inst = await startIsolatedInstance({
    pluginRoot,
    bindings: sessions.map((s) => ({ bindingId: s.bindingId, sessionId: s.sessionId, cwd: s.cwd, controller: s.controller, tokenRef: REF })),
    controllerTokens: [{ controller: "codex", tokenRef: REF, token: TOKEN }],
    inboxRoot: path.join(workDir, "inbox"),
    storeRoot: path.join(workDir, "store"),
    scripted: { question: sessions[0].question },
    answerTimeoutMs: 60_000
});

/** One control request as the controller. */
const call = (route, init = {}) => fetch(new URL(`/codex-collab${route}`, new URL(inst.url)), {
    ...init,
    headers: { cookie: inst.cookie, "content-type": "application/json", "x-controller-token": TOKEN, ...(init.headers ?? {}) }
}).then(async (response) => ({ status: response.status, body: await response.json().catch(() => ({})) }));

try {
    const clients = [];
    for (const s of sessions) {
        // The shared client caps its timeout at 60s, and the question wait can outlast a short default, so
        // the allowed maximum is used rather than a value the client would reject.
        const client = new DshClient(new URL(inst.url), 60_000);
        await client.login();
        inst.cookie = client.cookie;
        await client.rpc("session/create", { request: { cwd: s.cwd, sessionId: s.sessionId } });
        clients.push(client);
    }

    // ALL FIVE ask at the same time. This is the concurrency the scenario is about: with a global
    // provider counter only one of these would ever reach the tool.
    const prompts = sessions.map((s, index) => clients[index].rpc("session/prompt", {
        request: {
            sessionId: s.sessionId,
            requestId: crypto.randomUUID(),
            mode: "queue",
            content: [{ type: "text", text: 'Call the tool "ask_codex" with a question about the migration order.' }],
            clientTimeZone: "Asia/Shanghai"
        }
    }).then(() => ({ sessionId: s.sessionId, ok: true })).catch((error) => ({ sessionId: s.sessionId, ok: false, error: String(error.message).slice(0, 120) })));
    const dispatched = await Promise.all(prompts);
    record("all five sessions accept the asking prompt", dispatched.every((d) => d.ok), `ok=${dispatched.filter((d) => d.ok).length}/${COUNT}`);

    // Collect questions through wait-any in bounded batches, exactly as a controller would.
    const collected = new Map();
    let cursor = undefined;
    const deadline = Date.now() + 90_000;
    while (collected.size < COUNT && Date.now() < deadline) {
        const query = `/wait-any?controller=codex&waitMs=4000&maxBatch=10${cursor === undefined ? "" : `&since=${cursor}`}`;
        const batch = await call(query);
        for (const signal of batch.body.signals ?? []) {
            if (signal.kind !== "question") continue;
            if (!collected.has(signal.sessionId)) collected.set(signal.sessionId, signal);
        }
        if (Number.isFinite(batch.body.cursor)) cursor = batch.body.cursor;
    }
    record("all five sessions' questions arrive, one batch at a time", collected.size === COUNT, `received=${collected.size}/${COUNT}`);
    record("each question is attributed to its own session", new Set([...collected.values()].map((s) => s.sessionId)).size === COUNT, `unique sessions=${new Set([...collected.values()].map((s) => s.sessionId)).size}`);
    record("each question is attributed to its own binding", new Set([...collected.values()].map((s) => s.bindingId)).size === COUNT, `unique bindings=${new Set([...collected.values()].map((s) => s.bindingId)).size}`);

    // Answer each question BY ITS OWN IDENTITY, with an answer unique to that question.
    const answeredIds = [];
    for (const [sessionId, signal] of collected) {
        const questionId = String(signal.reference ?? "").replace("collab-question:", "");
        const listed = await call(`/questions?sessionId=${sessionId}&controller=codex`);
        const question = (listed.body.questions ?? []).find((q) => q.id === questionId) ?? (listed.body.questions ?? [])[0];
        if (question === undefined) continue;
        const answered = await call("/answer", {
            method: "POST",
            body: JSON.stringify({ questionId: question.id, text: `answer-for:${sessionId}`, source: "codex", controller: "codex" })
        });
        if (answered.status === 200 && answered.body.ok === true) answeredIds.push(question.id);
    }
    record("every question is answerable by its own identity", answeredIds.length === COUNT, `answered=${answeredIds.length}/${COUNT}`);

    // Each ORIGINAL call must continue and read ITS OWN answer.
    await Promise.all(prompts.map((p) => p.catch(() => null)));
    await new Promise((r) => setTimeout(r, 6000));

    let continuedOnce = 0;
    let sawOwnAnswer = 0;
    for (let i = 0; i < COUNT; i += 1) {
        const snapshot = await clients[i].snapshot(sessions[i].sessionId, 200);
        const events = snapshot.records.map((r) => r.event).filter(Boolean);
        const calls = events.filter((e) => e.type === "tool/call" && e.data?.name === "ask_codex");
        const resultsText = JSON.stringify(events.filter((e) => e.type === "tool/result").map((e) => e.data));
        if (calls.length === 1) continuedOnce += 1;
        // The session must observe its OWN answer and no other session's.
        const own = `answer-for:${sessions[i].sessionId}`;
        if (resultsText.includes(own)) {
            const others = sessions.filter((s) => s.sessionId !== sessions[i].sessionId).map((s) => `answer-for:${s.sessionId}`);
            if (!others.some((other) => resultsText.includes(other))) sawOwnAnswer += 1;
        }
    }
    record("every session called ask_codex exactly once (nothing replayed or skipped)", continuedOnce === COUNT, `once=${continuedOnce}/${COUNT}`);
    record("every session read its OWN answer and no other session's", sawOwnAnswer === COUNT, `correct=${sawOwnAnswer}/${COUNT}`);
} finally {
    const outcome = await inst.stop();
    const stopVerdict = stopIsClean(outcome);
    record("the instance stopped with no residue and no leaked helper", stopVerdict.clean, stopVerdict.problems.join("; ") || "clean");
    if (fs.existsSync(workDir)) fs.rmSync(workDir, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\ncase_count=${results.length} passed=${results.length - failed} failed=${failed}`);
process.exitCode = failed === 0 ? 0 : 1;
