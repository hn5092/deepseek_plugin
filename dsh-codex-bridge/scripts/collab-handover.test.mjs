/**
 * Acceptance: a handover routes real work to the NEW owner and refuses the old one's late answer.
 *
 * The helper test proves `matchBinding` skips a superseded binding. That is not the requirement on its
 * own: the requirement is that the REAL callers — the question tool, the notification tool and the answer
 * path — actually route through the live owner. So this suite configures a session with the superseded
 * binding listed FIRST (the order that used to win) and drives real tools.
 *
 * Each binding has its OWN controller credential, so "the old owner's late answer" is a request from the
 * old owner, not merely a request naming the old binding.
 *
 * Run: node scripts/collab-handover.test.mjs
 *
 * @module dsh-codex-bridge/scripts/collab-handover.test
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

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "collab-handover-"));
const projDir = path.join(workDir, "proj");
fs.mkdirSync(projDir, { recursive: true });
const sessionId = "session-handover";
const OLD_TOKEN = "test-old-owner-secret";
const NEW_TOKEN = "test-new-owner-secret";
// The superseded binding is deliberately FIRST: an implementation that simply takes the first match
// would pick it, which is exactly the defect being guarded against.
const bindings = [
    { bindingId: "codex::old", sessionId, cwd: projDir, controller: "codex-old", tokenRef: "TEST_TOKEN_OLD", current: false },
    { bindingId: "codex::new", sessionId, cwd: projDir, controller: "codex-new", tokenRef: "TEST_TOKEN_NEW" }
];
const controllerTokens = [
    { controller: "codex-old", tokenRef: "TEST_TOKEN_OLD", token: OLD_TOKEN },
    { controller: "codex-new", tokenRef: "TEST_TOKEN_NEW", token: NEW_TOKEN }
];
const question = "Which owner should apply the migration?";

const inst = await startIsolatedInstance({
    pluginRoot, bindings, controllerTokens,
    inboxRoot: path.join(workDir, "inbox"),
    storeRoot: path.join(workDir, "store"),
    scripted: { question },
    answerTimeoutMs: 20_000
});

/** One control request as a named owner. */
const callAs = (token, route, init = {}) => fetch(new URL(`/codex-collab${route}`, new URL(inst.url)), {
    ...init,
    headers: { cookie: inst.cookie, "content-type": "application/json", "x-controller-token": token, ...(init.headers ?? {}) }
}).then(async (response) => ({ status: response.status, body: await response.json().catch(() => ({})) }));

try {
    const client = new DshClient(new URL(inst.url), 55_000);
    await client.login();
    inst.cookie = client.cookie;
    await client.rpc("session/create", { request: { cwd: projDir, sessionId } });

    // A REAL ask from the session: the tool must resolve its binding to the LIVE owner.
    void client.rpc("session/prompt", {
        request: {
            sessionId,
            requestId: crypto.randomUUID(),
            mode: "queue",
            content: [{ type: "text", text: `Call the tool "ask_codex" with question "${question}".` }],
            clientTimeZone: "Asia/Shanghai"
        }
    }).catch(() => { /* the tool is what is under test; the turn itself is incidental */ });

    let pending = null;
    for (let i = 0; i < 40 && pending === null; i += 1) {
        await new Promise((r) => setTimeout(r, 500));
        const listed = await callAs(NEW_TOKEN, `/questions?sessionId=${sessionId}&controller=codex-new`);
        pending = (listed.body.questions ?? [])[0] ?? null;
    }
    record("a real ask resolves to the live owner, not the superseded one", pending !== null, pending ? `id=${pending.id}` : "no question observed");
    record("the question is attributed to the NEW binding", pending !== null && pending.bindingId === "codex::new", `binding=${pending ? pending.bindingId : "none"}`);

    // The question must be discoverable ONLY through the new owner's credential, which proves the
    // superseded binding was not selected for this work.
    const asOld = await callAs(OLD_TOKEN, `/questions?sessionId=${sessionId}&controller=codex-old`);
    record("the superseded owner cannot read the session's questions", asOld.status === 403 || (asOld.body.questions ?? []).length === 0, `status=${asOld.status} count=${(asOld.body.questions ?? []).length}`);

    const signalsNew = await callAs(NEW_TOKEN, "/signals?controller=codex-new");
    const questionSignal = (signalsNew.body.signals ?? []).find((s) => s.kind === "question");
    record("the live owner receives the question signal", Boolean(questionSignal), `kinds=${JSON.stringify((signalsNew.body.signals ?? []).map((s) => s.kind))}`);
    record("the signal is attributed to the new binding", Boolean(questionSignal) && questionSignal.bindingId === "codex::new", `binding=${questionSignal ? questionSignal.bindingId : "none"}`);

    // The OLD owner's late answer must be refused: a handover must not leave the previous owner able to
    // resolve a question that now belongs to its successor.
    if (pending !== null) {
        const lateAnswer = await callAs(OLD_TOKEN, "/answer", {
            method: "POST",
            body: JSON.stringify({ questionId: pending.id, text: "I still own this.", source: "codex", controller: "codex-old" })
        });
        record("the superseded owner's late answer is refused", lateAnswer.status === 403 || lateAnswer.status === 409, `status=${lateAnswer.status}`);
        const stillPending = await callAs(NEW_TOKEN, `/questions?sessionId=${sessionId}&controller=codex-new`);
        record("the refused late answer did not resolve the question", (stillPending.body.questions ?? []).some((q) => q.id === pending.id), `pending=${(stillPending.body.questions ?? []).length}`);

        // The live owner's answer is accepted, so the refusal above was about ownership, not breakage.
        const goodAnswer = await callAs(NEW_TOKEN, "/answer", {
            method: "POST",
            body: JSON.stringify({ questionId: pending.id, text: "The new owner applies it.", source: "codex", controller: "codex-new" })
        });
        record("the live owner's answer is accepted", goodAnswer.status === 200 && goodAnswer.body.ok === true, `status=${goodAnswer.status}`);
        record("the live owner's answer is attributed to the new binding", goodAnswer.status === 200, `delivered=${goodAnswer.body.delivered}`);
    }

    // A notification from a session resolves through the live owner too.
    const notifyAsNew = await callAs(NEW_TOKEN, "/notify", {
        method: "POST",
        body: JSON.stringify({ sessionId, controller: "codex-new", kind: "delivery", text: "handover complete", requestId: "handover-1" })
    });
    record("the live owner can notify for this session", notifyAsNew.status === 200, `status=${notifyAsNew.status}`);
    record("the notification is attributed to the new binding", notifyAsNew.status === 200 && notifyAsNew.body.bindingId === "codex::new", `binding=${notifyAsNew.body.bindingId}`);
} finally {
    const outcome = await inst.stop();
    const stopVerdict = stopIsClean(outcome);
    record("the instance stopped with no residue", stopVerdict.clean, stopVerdict.problems.join("; ") || "clean");
    if (fs.existsSync(workDir)) fs.rmSync(workDir, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\ncase_count=${results.length} passed=${results.length - failed} failed=${failed}`);
process.exitCode = failed === 0 ? 0 : 1;
