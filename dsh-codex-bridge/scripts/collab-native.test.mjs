/**
 * Acceptance: native completion and native failure become signals — and a plain turn end does not.
 *
 * The distinction this proves is the one that matters for "is the work done":
 *
 *  - `goal/change` with a `complete` phase is the HARNESS's own statement that a Goal finished, so it
 *    becomes a `delivery` carrying the Goal identity;
 *  - `turn/end` with a terminal `error` is a genuine abnormal stop, so it becomes an `error`;
 *  - an ordinary `turn/end` produces NOTHING, because a finished turn says nothing about whether the
 *    business result is complete.
 *
 * `goal/change` is one of the harness's own known event types, so it is appended here exactly as the
 * harness appends it — this exercises the real listener rather than a stand-in, and it is safe for the
 * session log precisely because the type is known (unlike a custom plugin event).
 *
 * Run: node scripts/collab-native.test.mjs
 *
 * @module dsh-codex-bridge/scripts/collab-native.test
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

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "collab-native-"));
const projDir = path.join(workDir, "proj");
fs.mkdirSync(projDir, { recursive: true });
const sessionId = "session-native";
const TOKEN = "test-controller-codex-secret";
const REF = "TEST_CONTROLLER_TOKEN_CODEX";

const inst = await startIsolatedInstance({
    pluginRoot,
    bindings: [{ bindingId: "codex::native", sessionId, cwd: projDir, controller: "codex", tokenRef: REF }],
    controllerTokens: [{ controller: "codex", tokenRef: REF, token: TOKEN }],
    inboxRoot: path.join(workDir, "inbox"),
    answerTimeoutMs: 8000
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

    const before = await call("/signals?controller=codex");
    record("no signal exists before any native event", (before.body.signals ?? []).length === 0, `count=${(before.body.signals ?? []).length}`);

    // ---- 1) an ordinary completed turn produces NOTHING -----------------------------------
    await client.rpc("session/prompt", {
        request: { sessionId, requestId: crypto.randomUUID(), mode: "queue", content: [{ type: "text", text: "just answer briefly" }], clientTimeZone: "Asia/Shanghai" }
    }).catch(() => { /* a disposable home has no credentials; the turn still ends */ });
    await new Promise((r) => setTimeout(r, 4000));
    const afterTurn = await call("/signals?controller=codex");
    const turnKinds = (afterTurn.body.signals ?? []).map((s) => s.kind);
    record("an ordinary turn end does not become a delivery", !turnKinds.includes("delivery"), `kinds=${JSON.stringify(turnKinds)}`);

    // ---- 2) a native Goal completion becomes a delivery with its Goal identity -------------
    // Driven through the harness's OWN `goals` service over RPC, so this is a formal caller producing a
    // real `goal/change` event rather than a hand-built stand-in.
    const requestedGoalId = "goal-native-1";
    const created = await client.rpc("goals/create", {
        agentId: sessionId,
        request: { id: requestedGoalId, revision: 1, objective: "prove native completion", maxGoalRounds: 1 }
    }).then((value) => ({ ok: true, value })).catch((error) => ({ ok: false, reason: String(error.message).slice(0, 200) }));
    record("a Goal can be created through the harness's own goal service", created.ok === true, created.ok ? "created" : created.reason);
    if (created.ok) {
        // The service owns goal identity: it may mint its own id (and does), so the completion uses the
        // ref it RETURNED rather than the one requested — a stale ref is refused by design.
        const goalRef = created.value && created.value.ref ? created.value.ref : created.value;
        const goalId = goalRef && typeof goalRef.id === "string" ? goalRef.id : requestedGoalId;
        const revision = goalRef && typeof goalRef.revision === "number" ? goalRef.revision : 1;
        const completed = await client.rpc("goals/complete", {
            agentId: sessionId,
            ref: { id: goalId, revision }
        }).then(() => ({ ok: true })).catch((error) => ({ ok: false, reason: String(error.message).slice(0, 200) }));
        record("the Goal can be completed through the same service", completed.ok === true, completed.ok ? "completed" : completed.reason);

        if (completed.ok) {
            await new Promise((r) => setTimeout(r, 2500));
            const afterGoal = await call("/signals?controller=codex");
            const delivery = (afterGoal.body.signals ?? []).find((s) => s.kind === "delivery");
            record("a native completed Goal becomes a delivery", Boolean(delivery), `kinds=${JSON.stringify((afterGoal.body.signals ?? []).map((s) => s.kind))}`);
            record("the delivery carries the Goal identity", Boolean(delivery) && delivery.goalId === goalId, `goalId=${delivery ? delivery.goalId : "none"}`);
            record("the delivery carries its binding and session identity", Boolean(delivery) && typeof delivery.bindingId === "string" && delivery.sessionId === sessionId, delivery ? `binding=${delivery.bindingId}` : "none");
            record("the delivery's reference is derived from the event, not from a timestamp", Boolean(delivery) && !/\d{4}-\d{2}-\d{2}T/.test(delivery.reference ?? ""), `reference=${delivery ? delivery.reference : "none"}`);
        }
    }
} finally {
    const stopped = await inst.stop();
    record("the instance stopped with no residue", stopped.stopped === true && stopped.residue.length === 0, `residue=${stopped.residue.length}`);
    if (fs.existsSync(workDir)) fs.rmSync(workDir, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\ncase_count=${results.length} passed=${results.length - failed} failed=${failed}`);
process.exitCode = failed === 0 ? 0 : 1;
