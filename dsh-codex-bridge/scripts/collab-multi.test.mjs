/**
 * Multi-session integration proof: many DS sessions under one controller, plus a second controller.
 *
 * The user-visible requirement is that several DS sessions can run at once and each one's question or
 * delivery reaches its controller without being lost, merged or mis-routed. Everything here runs on a
 * disposable instance with its own directories; no real session of any project is touched.
 *
 * Run: node scripts/collab-multi.test.mjs
 *
 * @module dsh-codex-bridge/scripts/collab-multi.test
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

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "collab-multi-"));
const inboxRoot = path.join(workDir, "inbox");
// Five sessions across five DISTINCT directories, all owned by this fixture. One controller owns them
// all, which is the multi-open case; a second controller owns its own session elsewhere.
const sessions = [];
for (let i = 1; i <= 5; i += 1) {
    const dir = path.join(workDir, `proj-${i}`);
    fs.mkdirSync(dir, { recursive: true });
    sessions.push({
        sessionId: `session-multi-${i}`,
        bindingId: `codex::multi-${i}`,
        cwd: dir,
        controller: "codex",
        question: `Question number ${i}: which retry policy?`
    });
}
const otherDir = path.join(workDir, "proj-other");
fs.mkdirSync(otherDir, { recursive: true });
const other = { sessionId: "session-other", bindingId: "other::solo", cwd: otherDir, controller: "other" };

const inst = await startIsolatedInstance({
    pluginRoot,
    bindings: [
        ...sessions.map((s) => ({ bindingId: s.bindingId, sessionId: s.sessionId, cwd: s.cwd, controller: s.controller })),
        { bindingId: other.bindingId, sessionId: other.sessionId, cwd: other.cwd, controller: other.controller }
    ],
    answerTimeoutMs: 30_000,
    scripted: null,
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
            headers: { cookie, "content-type": "application/json", ...(init.headers ?? {}) }
        });
        const text = await response.text();
        let body = {};
        try { body = text.length > 0 ? JSON.parse(text) : {}; } catch { body = { raw: text.slice(0, 200) }; }
        return { status: response.status, body };
    };
    console.log(`instance: ${url.origin}  sessions=${sessions.length + 1}`);

    // Create every session in its own bound directory.
    for (const s of [...sessions, other]) {
        await client.rpc("session/create", { request: { cwd: s.cwd, sessionId: s.sessionId } });
    }

    // ---- 1) every session raises its own question signal ------------------------------------
    for (const s of sessions) {
        const notified = await call("/notify", {
            method: "POST",
            body: JSON.stringify({ sessionId: s.sessionId, controller: "codex", kind: "delivery", text: `slice ${s.sessionId} complete` })
        });
        if (notified.status !== 200) record(`notification accepted for ${s.sessionId}`, false, `status=${notified.status}`);
    }
    const otherNotify = await call("/notify", {
        method: "POST",
        body: JSON.stringify({ sessionId: other.sessionId, controller: "other", kind: "delivery", text: "other project complete" })
    });
    record("every session's notification is accepted", otherNotify.status === 200, `status=${otherNotify.status}`);

    // ---- 2) one controller receives ALL of its bindings, losslessly -------------------------
    const all = await call("/signals?controller=codex&acknowledged=");
    const received = all.body.signals ?? [];
    record("one controller receives every one of its own bindings", received.length === sessions.length, `received=${received.length} expected=${sessions.length}`);
    const sessionIds = received.map((s) => s.sessionId).sort();
    record("no session's signal is lost or merged", JSON.stringify(sessionIds) === JSON.stringify(sessions.map((s) => s.sessionId).sort()), JSON.stringify(sessionIds));
    record("every signal keeps its own bindingId", new Set(received.map((s) => s.bindingId)).size === sessions.length, `unique=${new Set(received.map((s) => s.bindingId)).size}`);
    record("every signal carries the session's own cwd", received.every((s) => typeof s.cwd === "string" && s.cwd.length > 0), "cwds present");

    // ---- 3) wait-any returns a bounded batch with a cursor, not just the last event ----------
    // Deliveries only interrupt a wait when the caller declares the business result complete, so the
    // wait is asked with that intent — which is exactly the "notify me when work is really done" case.
    const batch = await call("/wait-any?controller=codex&waitMs=1000&maxBatch=2&deliveryComplete=true");
    const batchSignals = batch.body.signals ?? [];
    record("wait-any returns a bounded batch", batchSignals.length === 2, `batch=${batchSignals.length}`);
    record("the batch reports that more remain", batch.body.more === true, `more=${batch.body.more}`);
    record("the batch carries a cursor to resume from", Number.isFinite(batch.body.cursor), `cursor=${batch.body.cursor}`);
    const next = await call(`/wait-any?controller=codex&waitMs=1000&maxBatch=10&deliveryComplete=true&since=${batch.body.cursor}`);
    const nextIds = (next.body.signals ?? []).map((s) => s.id);
    record("resuming from the cursor yields the remaining events", nextIds.length === sessions.length - 2, `next=${nextIds.length}`);
    record("no event is delivered twice across the two batches", nextIds.every((id) => !batchSignals.some((s) => s.id === id)), "ids disjoint");
    // A plain finished turn is not a completed delivery, so an undeclared wait sees the deliveries as
    // NOT wake-worthy. This is the rule that keeps "the turn ended" from meaning "the work is done".
    const undeclared = await call("/wait-any?controller=codex&waitMs=800&maxBatch=2");
    record("a wait that has not declared completion is not woken by a delivery", (undeclared.body.signals ?? []).length === 0 && undeclared.body.empty === true, `signals=${(undeclared.body.signals ?? []).length}`);

    // ---- 4) a second controller cannot see or touch the first controller's events -----------
    const foreign = await call("/signals?controller=other");
    record("the second controller sees only its own binding", (foreign.body.signals ?? []).every((s) => s.controller === "other"), `count=${(foreign.body.signals ?? []).length}`);
    record("the first controller's events are not visible to the second", (foreign.body.signals ?? []).length === 1, `count=${(foreign.body.signals ?? []).length}`);
    const foreignAnswers = await call("/answer", { method: "POST", body: JSON.stringify({ questionId: "anything", text: "x", source: "codex", controller: "other" }) });
    record("the second controller cannot answer the first controller's question", foreignAnswers.status === 404 || foreignAnswers.status === 403, `status=${foreignAnswers.status}`);

    // ---- 5) confirming one session's event leaves every other session's event intact --------
    const target = received.find((s) => s.sessionId === sessions[0].sessionId);
    const confirmed = await call("/signals/confirm", { method: "POST", body: JSON.stringify({ controller: "codex", signalId: target.id }) });
    record("confirming one session's event succeeds", confirmed.status === 200 && confirmed.body.confirmed === true, `status=${confirmed.status}`);
    // A confirmed event is excluded from what the controller is owed; the others are untouched. The
    // caller names what it has processed, which is why confirmation is not implied by delivery.
    const remaining = await call(`/signals?controller=codex&acknowledged=${encodeURIComponent(target.id)}`);
    const remainingIds = (remaining.body.signals ?? []).map((s) => s.id);
    record("confirming A does not confirm or delete B's event", !remainingIds.includes(target.id) && remainingIds.length === sessions.length - 1, `remaining=${remainingIds.length}`);
    record("the confirmed event is gone from its file too", !(await call("/signals/files?controller=codex")).body.signals.some((s) => s.id === target.id), "file removed");
    record("the file projection still holds the unconfirmed events", (await call("/signals/files?controller=codex")).body.signals.length === sessions.length - 1, "files independent of the ack list");

    // ---- 6) a per-controller inbox directory keeps the two controllers apart ----------------
    const dirs = fs.existsSync(inboxRoot) ? fs.readdirSync(inboxRoot).sort() : [];
    record("the inbox is partitioned per controller", dirs.includes("codex") && dirs.includes("other"), `dirs=${JSON.stringify(dirs)}`);
    const codexFiles = fs.existsSync(path.join(inboxRoot, "codex")) ? fs.readdirSync(path.join(inboxRoot, "codex")) : [];
    const otherFiles = fs.existsSync(path.join(inboxRoot, "other")) ? fs.readdirSync(path.join(inboxRoot, "other")) : [];
    record("each controller's files are separate", codexFiles.length >= sessions.length - 1 && otherFiles.length === 1, `codex=${codexFiles.length} other=${otherFiles.length}`);

    // ---- 7) a reconnect re-reads unconfirmed events ----------------------------------------
    const reconnect = await call("/signals/files?controller=codex");
    record("a reconnect still finds the unconfirmed events", (reconnect.body.signals ?? []).length === sessions.length - 1, `found=${(reconnect.body.signals ?? []).length}`);
    record("a re-read returns no problems for well-formed events", (reconnect.body.problems ?? []).length === 0, `problems=${(reconnect.body.problems ?? []).length}`);

    // ---- 8) binding list is scoped per controller ------------------------------------------
    const scoped = await call("/bindings?controller=codex");
    record("a controller's binding list contains only its own bindings", (scoped.body.bindings ?? []).every((b) => b.controller === "codex"), `count=${(scoped.body.bindings ?? []).length}`);
    const unbound = await call("/bindings?controller=stranger");
    record("an unknown controller cannot list bindings", unbound.status === 403, `status=${unbound.status}`);
} finally {
    inst.stop();
    fs.rmSync(workDir, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\ncase_count=${results.length} passed=${results.length - failed} failed=${failed}`);
process.exitCode = failed === 0 ? 0 : 1;
