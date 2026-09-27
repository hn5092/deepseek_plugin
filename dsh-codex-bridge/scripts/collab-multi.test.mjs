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

// Each controller has its OWN credential. These are throwaway values for a disposable home, supplied
// through the launch environment the credentials service reads; they are never written to Git.
const TOKEN_A = "test-controller-codex-secret";
const TOKEN_B = "test-controller-other-secret";
const tokenRefOf = (controller) => `TEST_CONTROLLER_TOKEN_${controller.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;

const inst = await startIsolatedInstance({
    pluginRoot,
    bindings: [
        ...sessions.map((s) => ({ bindingId: s.bindingId, sessionId: s.sessionId, cwd: s.cwd, controller: s.controller, tokenRef: tokenRefOf(s.controller) })),
        { bindingId: other.bindingId, sessionId: other.sessionId, cwd: other.cwd, controller: other.controller, tokenRef: tokenRefOf(other.controller) }
    ],
    controllerTokens: [
        { controller: "codex", tokenRef: tokenRefOf("codex"), token: TOKEN_A },
        { controller: "other", tokenRef: tokenRefOf("other"), token: TOKEN_B }
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
    /**
     * Issue one authenticated control request as a named controller.
     * @param {string} route - path under the collaboration base.
     * @param {object} [init] - fetch init.
     * @param {string} [token] - the controller credential to present.
     * @returns {Promise<{status: number, body: object}>} the result.
     */
    const call = async (route, init = {}, token = TOKEN_A) => {
        const response = await fetch(new URL(`/codex-collab${route}`, url), {
            ...init,
            headers: { cookie, "content-type": "application/json", "x-controller-token": token, ...(init.headers ?? {}) }
        });
        const text = await response.text();
        let body = {};
        try { body = text.length > 0 ? JSON.parse(text) : {}; } catch { body = { raw: text.slice(0, 200) }; }
        return { status: response.status, body };
    };
    /** Issue one request with NO controller credential, to prove authentication is required. */
    const callAnonymous = async (route) => {
        const response = await fetch(new URL(`/codex-collab${route}`, url), { headers: { cookie, "content-type": "application/json" } });
        return { status: response.status, body: {} };
    };
    console.log(`instance: ${url.origin}  sessions=${sessions.length + 1}`);

    // Create every session in its own bound directory.
    for (const s of [...sessions, other]) {
        await client.rpc("session/create", { request: { cwd: s.cwd, sessionId: s.sessionId } });
    }

    // ---- 1) every session raises its own delivery signal ------------------------------------
    for (const s of sessions) {
        const notified = await call("/notify", {
            method: "POST",
            body: JSON.stringify({ sessionId: s.sessionId, controller: "codex", kind: "delivery", text: `slice ${s.sessionId} complete` })
        });
        if (notified.status !== 200) record(`notification accepted for ${s.sessionId}`, false, `status=${notified.status} ${JSON.stringify(notified.body).slice(0, 120)}`);
    }
    const otherNotify = await call("/notify", {
        method: "POST",
        body: JSON.stringify({ sessionId: other.sessionId, controller: "other", kind: "delivery", text: "other project complete" })
    }, TOKEN_B);
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
    // A production-declared delivery now wakes a wait by DEFAULT: there is no consumer-side switch
    // declaring whether the producer finished.
    const batch = await call("/wait-any?controller=codex&waitMs=1000&maxBatch=2");
    const batchSignals = batch.body.signals ?? [];
    record("wait-any is woken by deliveries without the consumer declaring completion", batchSignals.length === 2, `batch=${batchSignals.length}`);
    record("the batch reports that more remain", batch.body.more === true, `more=${batch.body.more}`);
    record("the batch carries a cursor to resume from", Number.isFinite(batch.body.cursor), `cursor=${batch.body.cursor}`);
    const next = await call(`/wait-any?controller=codex&waitMs=1000&maxBatch=10&since=${batch.body.cursor}`);
    const nextIds = (next.body.signals ?? []).map((s) => s.id);
    record("resuming from the cursor yields the remaining events", nextIds.length === sessions.length - 2, `next=${nextIds.length}`);
    record("no event is delivered twice across the two batches", nextIds.every((id) => !batchSignals.some((s) => s.id === id)), "ids disjoint");

    // ---- 4) controller identity: a credential decides WHO is calling ----------------------
    record("a request with no controller credential is refused", (await callAnonymous("/signals?controller=codex")).status === 401, "anonymous control refused");
    record("a wrong controller credential is refused", (await call("/signals?controller=codex", {}, "not-a-real-token")).status === 401, "wrong credential refused");
    // B holding B's VALID credential while claiming to be A must still be refused: the credential
    // decides the identity, so a stated name cannot elevate one controller into another's binding.
    const bClaimsA = await call("/signals?controller=codex", {}, TOKEN_B);
    record("B's valid credential cannot read A's events by claiming to be A", bClaimsA.status === 403, `status=${bClaimsA.status}`);
    const bConfirmsA = await call("/signals/confirm", { method: "POST", body: JSON.stringify({ controller: "codex", signalId: received[0].id }) }, TOKEN_B);
    record("B's valid credential cannot confirm A's event by claiming to be A", bConfirmsA.status === 403, `status=${bConfirmsA.status}`);
    // Each controller resolves to itself: A sees its own bindings even when claiming to be B.
    const aClaimsB = await call("/signals?controller=other", {}, TOKEN_A);
    record("A's valid credential cannot read B's events by claiming to be B", aClaimsB.status === 403, `status=${aClaimsB.status}`);

    const foreign = await call("/signals?controller=other", {}, TOKEN_B);
    record("the second controller sees only its own binding", (foreign.body.signals ?? []).every((s) => s.controller === "other"), `count=${(foreign.body.signals ?? []).length}`);
    record("the first controller's events are not visible to the second", (foreign.body.signals ?? []).length === 1, `count=${(foreign.body.signals ?? []).length}`);
    const foreignAnswers = await call("/answer", { method: "POST", body: JSON.stringify({ questionId: "anything", text: "x", source: "codex", controller: "other" }) }, TOKEN_B);
    record("the second controller cannot answer the first controller's question", foreignAnswers.status === 404 || foreignAnswers.status === 403, `status=${foreignAnswers.status}`);

    // ---- 5) confirming one session's event leaves every other session's event intact --------
    const target = received.find((s) => s.sessionId === sessions[0].sessionId);
    const confirmed = await call("/signals/confirm", { method: "POST", body: JSON.stringify({ controller: "codex", signalId: target.id }) });
    record("confirming one session's event succeeds", confirmed.status === 200 && confirmed.body.confirmed === true, `status=${confirmed.status}`);
    // Confirmation is durable, so it is excluded for EVERY caller with no client-supplied list.
    const remaining = await call("/signals?controller=codex");
    const remainingIds = (remaining.body.signals ?? []).map((s) => s.id);
    record("confirming A does not confirm or delete B's event", !remainingIds.includes(target.id) && remainingIds.length === sessions.length - 1, `remaining=${remainingIds.length}`);
    const again = await call("/signals/confirm", { method: "POST", body: JSON.stringify({ controller: "codex", signalId: target.id }) });
    record("confirming the same event twice is idempotent", again.status === 200 && again.body.idempotent === true, `idempotent=${again.body.idempotent}`);
    record("the confirmed event is gone from its file too", !(await call("/signals/files?controller=codex")).body.signals.some((s) => s.id === target.id), "file removed");
    record("the file projection still holds the unconfirmed events", (await call("/signals/files?controller=codex")).body.signals.length === sessions.length - 1, "files independent of the ack list");
    record("an unknown or retired signal cannot be confirmed", [404, 410].includes((await call("/signals/confirm", { method: "POST", body: JSON.stringify({ controller: "codex", signalId: "no-such-signal" }) })).status), "unknown signal refused");

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
    // The stop receipt is asserted, not discarded: a suite must not pass while leaving a process behind.
    const outcome = await inst.stop();
    const stopVerdict = stopIsClean(outcome);
    record("the instance stopped cleanly", stopVerdict.clean, stopVerdict.problems.join("; ") || "clean");
    fs.rmSync(workDir, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\ncase_count=${results.length} passed=${results.length - failed} failed=${failed}`);
process.exitCode = failed === 0 ? 0 : 1;
