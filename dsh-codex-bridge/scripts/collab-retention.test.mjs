/**
 * Acceptance: the retention bounds are validated, and confirmation never destroys a pending question.
 *
 * Two properties that a mis-set configuration or a conflated state model would silently break:
 *
 *  1. INVALID BOUNDS — a nonsensical retention value must stop the plugin at startup. These numbers
 *     decide when finished records are reclaimed, so accepting a negative age, a fractional number or an
 *     empty retained window would leave the store either unbounded or actively discarding work.
 *  2. CONFIRM THEN RECLAIM THEN ANSWER — the controller confirms being told but has NOT answered; the
 *     question is still pending, so reclamation must not touch it and the original tool call must still
 *     be answerable. This is the case an earlier three-file design got wrong by deleting the question
 *     file when the notification was confirmed.
 *
 * Run: node scripts/collab-retention.test.mjs
 *
 * @module dsh-codex-bridge/scripts/collab-retention.test
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

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "collab-retention-"));
const projDir = path.join(workDir, "proj");
fs.mkdirSync(projDir, { recursive: true });
const sessionId = "session-retention";
const TOKEN = "test-controller-codex-secret";
const REF = "TEST_CONTROLLER_TOKEN_CODEX";
const bindings = [{ bindingId: "codex::ret", sessionId, cwd: projDir, controller: "codex", tokenRef: REF }];
const controllerTokens = [{ controller: "codex", tokenRef: REF, token: TOKEN }];

// ---- 1) invalid bounds must stop the PLUGIN from activating -------------------------------
// The host treats a plugin that throws during apply as an entry that "did not activate": it logs the
// refusal and keeps serving, so the observable fact is not "the server fails to start" but "the bridge
// is not running and its routes are absent". That is what is asserted — a bridge that came up anyway
// would be honouring a retention policy it cannot.
for (const [label, overrides] of [
    ["a negative age", { inboxMaxAgeMs: -1 }],
    ["a fractional age", { inboxMaxAgeMs: 1.5 }],
    ["a non-numeric age", { inboxMaxAgeMs: "soon" }],
    ["a zero retained window", { inboxMaxEvents: 0 }],
    ["a negative retained window", { inboxMaxEvents: -5 }]
]) {
    let started = null;
    let refused = false;
    let detail = "";
    try {
        started = await startIsolatedInstance({
            pluginRoot, bindings, controllerTokens, answerTimeoutMs: 4000,
            inboxRoot: path.join(workDir, "inbox-invalid"), storeRoot: path.join(workDir, "store-invalid"),
            extraConfig: overrides
        });
        // The plugin must NOT be serving: its health route does not exist when it failed to activate.
        const response = await fetch(new URL("/codex-bridge/health", new URL(started.url))).catch(() => null);
        refused = response === null || response.status === 404;
        const log = fs.existsSync(started.logFile) ? fs.readFileSync(started.logFile, "utf8") : "";
        detail = (log.match(/(refusing to start|Validation error)[^\n]*/) ?? [log.slice(0, 80).replace(/\s+/g, " ")])[0].slice(0, 140);
        // The refusal must be VISIBLE and attributable, so an operator can fix it. It may come from the
        // schema (a value of the wrong type) or from the plugin's own bound check (a value of the right
        // type that is not a valid bound) — either is a real refusal, and neither may pass silently.
        refused = refused && /refusing to start|Validation error|did not activate/.test(log);
    } catch (error) {
        // A start that never produced a URL is also a valid refusal.
        refused = true;
        detail = String(error.message ?? error).slice(0, 140).replace(/\s+/g, " ");
    } finally {
        if (started !== null) await started.stop();
    }
    record(`the bridge refuses to activate with ${label}`, refused, detail);
}

// ---- 2) a confirmed notification does not destroy a pending question ----------------------
const inst = await startIsolatedInstance({
    pluginRoot, bindings, controllerTokens, answerTimeoutMs: 20_000,
    inboxRoot: path.join(workDir, "inbox"), storeRoot: path.join(workDir, "store"),
    scripted: { question: "Confirm me but do not answer me yet." },
    // A tiny window: everything that CAN be reclaimed is reclaimed promptly, so if the pending question
    // were eligible it would be removed during this run.
    extraConfig: { inboxMaxAgeMs: 0, inboxMaxEvents: 1 }
});

/** One control request as the controller. */
const call = (route, init = {}) => fetch(new URL(`/codex-collab${route}`, new URL(inst.url)), {
    ...init,
    headers: { cookie: inst.cookie, "content-type": "application/json", "x-controller-token": TOKEN, ...(init.headers ?? {}) }
}).then(async (response) => ({ status: response.status, body: await response.json().catch(() => ({})) }));

try {
    const client = new DshClient(new URL(inst.url), 55_000);
    await client.login();
    inst.cookie = client.cookie;
    await client.rpc("session/create", { request: { cwd: projDir, sessionId } });

    // A REAL ask leaves the question pending and the tool waiting.
    void client.rpc("session/prompt", {
        request: {
            sessionId,
            requestId: crypto.randomUUID(),
            mode: "queue",
            content: [{ type: "text", text: 'Call the tool "ask_codex" with a question.' }],
            clientTimeZone: "Asia/Shanghai"
        }
    }).catch(() => { /* the tool result is the assertion, not the turn */ });

    let pending = null;
    for (let i = 0; i < 40 && pending === null; i += 1) {
        await new Promise((r) => setTimeout(r, 500));
        const listed = await call(`/questions?sessionId=${sessionId}&controller=codex`);
        pending = (listed.body.questions ?? [])[0] ?? null;
    }
    record("a real ask leaves a pending question", pending !== null, pending ? `id=${pending.id}` : "no question observed");

    if (pending !== null) {
        // Confirm the NOTIFICATION only. The question itself is still unanswered.
        const confirmed = await call("/signals/confirm", { method: "POST", body: JSON.stringify({ controller: "codex", signalId: pending.id }) });
        record("the notification can be confirmed", confirmed.status === 200 && confirmed.body.confirmed === true, `status=${confirmed.status}`);
        record("confirming the notification reports the question still pending", confirmed.body.business === "pending", `business=${confirmed.body.business}`);

        // Reclamation ran at that confirmation with the tightest possible bounds. The question must remain.
        const afterConfirm = await call(`/questions?sessionId=${sessionId}&controller=codex`);
        record("reclamation does not remove a confirmed-but-pending question", (afterConfirm.body.questions ?? []).some((q) => q.id === pending.id), `count=${(afterConfirm.body.questions ?? []).length}`);

        // And it must still be answerable, which is the whole point.
        const answered = await call("/answer", { method: "POST", body: JSON.stringify({ questionId: pending.id, text: "answered after confirmation", source: "codex", controller: "codex" }) });
        record("the confirmed-but-pending question is still answerable", answered.status === 200 && answered.body.ok === true, `status=${answered.status}`);

        // The ORIGINAL tool call must resume with that answer, exactly once.
        await new Promise((r) => setTimeout(r, 5000));
        const snapshot = await client.snapshot(sessionId, 200);
        const events = snapshot.records.map((r) => r.event).filter(Boolean);
        const calls = events.filter((e) => e.type === "tool/call" && e.data?.name === "ask_codex");
        const resultsText = JSON.stringify(events.filter((e) => e.type === "tool/result").map((e) => e.data));
        record("the original tool call ran exactly once and resumed", calls.length === 1 && resultsText.includes("answered after confirmation"), `calls=${calls.length}`);

        // A duplicate confirmation is idempotent and does not re-execute anything.
        const again = await call("/signals/confirm", { method: "POST", body: JSON.stringify({ controller: "codex", signalId: pending.id }) });
        record("confirming twice is idempotent", again.status === 200 && again.body.idempotent === true, `idempotent=${again.body.idempotent}`);
    }
} finally {
    const outcome = await inst.stop();
    const verdict = stopIsClean(outcome);
    record("the instance stopped with no residue", verdict.clean, verdict.problems.join("; ") || "clean");
    if (fs.existsSync(workDir)) fs.rmSync(workDir, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\ncase_count=${results.length} passed=${results.length - failed} failed=${failed}`);
process.exitCode = failed === 0 ? 0 : 1;
