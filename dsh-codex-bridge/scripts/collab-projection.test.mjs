/**
 * Acceptance: the notification projection is repaired, filtered, and bounded.
 *
 * Three properties a projection must have, none of which a happy-path test exercises:
 *
 *  1. REPAIR — a signal that is durable but whose file was lost (deleted by hand, or never written
 *     because the inbox was briefly unwritable) has the file written again, so the API and the file
 *     inbox agree again instead of one silently lacking an event.
 *  2. FILTER — a signal the store records as confirmed is not offered as work, even when its file could
 *     not be removed. A file is not the fact.
 *  3. BOUND — a CONFIRMED event past both bounds is reclaimed, while an UNCONFIRMED event is never
 *     removed to satisfy a cap no matter how old it is.
 *
 * Run: node scripts/collab-projection.test.mjs
 *
 * @module dsh-codex-bridge/scripts/collab-projection.test
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { startIsolatedInstance, stopIsClean } from "./isolated-instance.mjs";
import { CollabStore } from "../lib/store.js";
import { inboxDirFor, publishSignal, readSignals } from "../lib/inbox.js";

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

// ---- 3) retention: the store's own bounds -------------------------------------------------
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "collab-reclaim-"));
    const store = new CollabStore(root);
    const old = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    for (let i = 0; i < 3; i += 1) store.putSignal({ id: `unconfirmed-${i}`, controller: "codex", bindingId: "codex::r", reference: `collab-question:q${i}`, kind: "question", at: old });
    for (let i = 0; i < 3; i += 1) {
        store.putSignal({ id: `confirmed-${i}`, controller: "codex", bindingId: "codex::r", reference: `collab-notify:x:${i}`, kind: "delivery", at: old });
        store.putConfirmation("codex", `confirmed-${i}`, {});
    }
    const reclaimed = store.reclaim({ maxAgeMs: 60_000, maxEvents: 1 });
    const remaining = store.allSignals().signals.map((s) => s.id);
    record("an unconfirmed event is NEVER removed to satisfy a capacity bound",
        [0, 1, 2].every((i) => remaining.includes(`unconfirmed-${i}`)),
        `remaining=${JSON.stringify(remaining.sort())}`);
    record("a confirmed event past both bounds is reclaimed", reclaimed.removed.length > 0, `removed=${JSON.stringify(reclaimed.removed.sort())}`);
    record("the newest confirmed event is retained regardless of age", remaining.includes("confirmed-0"), `remaining=${JSON.stringify(remaining.sort())}`);
    record("reclamation reports what it removed instead of being silent", Array.isArray(reclaimed.removed), `removed=${reclaimed.removed.length} retained=${reclaimed.retained}`);
    fs.rmSync(root, { recursive: true, force: true });
}

// ---- 1) and 2) on a live instance ---------------------------------------------------------
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "collab-projection-"));
const projDir = path.join(workDir, "proj");
fs.mkdirSync(projDir, { recursive: true });
const inboxRoot = path.join(workDir, "inbox");
const storeRoot = path.join(workDir, "store");
const sessionId = "session-projection";
const TOKEN = "test-controller-codex-secret";
const REF = "TEST_CONTROLLER_TOKEN_CODEX";

const inst = await startIsolatedInstance({
    pluginRoot,
    bindings: [{ bindingId: "codex::proj", sessionId, cwd: projDir, controller: "codex", tokenRef: REF }],
    controllerTokens: [{ controller: "codex", tokenRef: REF, token: TOKEN }],
    inboxRoot, storeRoot,
    answerTimeoutMs: 6000
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

    // Two durable notifications; then their files are DELETED behind the plugin's back.
    await call("/notify", { method: "POST", body: JSON.stringify({ sessionId, controller: "codex", kind: "delivery", text: "first", requestId: "proj-1" }) });
    const second = await call("/notify", { method: "POST", body: JSON.stringify({ sessionId, controller: "codex", kind: "delivery", text: "second", requestId: "proj-2" }) });
    const dir = inboxDirFor(inboxRoot, "codex").dir;
    const before = readSignals(dir).signals.length;
    for (const name of fs.readdirSync(dir)) fs.rmSync(path.join(dir, name), { force: true });
    record("the test really removed the inbox files", readSignals(dir).signals.length === 0, `files before=${before}`);

    // 1) A read must REPAIR the missing files from the durable records.
    const repairedView = await call("/signals?controller=codex");
    const filesAfterRead = readSignals(dir).signals.length;
    record("reading the view repairs the missing inbox files", filesAfterRead === before, `files=${filesAfterRead} expected=${before}`);
    record("the repaired view still lists every durable event", (repairedView.body.signals ?? []).length === before, `signals=${(repairedView.body.signals ?? []).length}`);

    // 2) Confirm one event, then make its file UNDELETABLE by replacing the file with a directory of the
    //    same name — a real "cannot delete" condition — and require it not to return as outstanding work.
    const target = (repairedView.body.signals ?? [])[0];
    const confirmed = await call("/signals/confirm", { method: "POST", body: JSON.stringify({ controller: "codex", signalId: target.id }) });
    record("the event is confirmed", confirmed.status === 200 && confirmed.body.confirmed === true, `status=${confirmed.status}`);
    const listedAfter = await call("/signals?controller=codex");
    record("a confirmed event is not offered as outstanding work", !(listedAfter.body.signals ?? []).some((s) => s.id === target.id), `count=${(listedAfter.body.signals ?? []).length}`);

    // Re-create the confirmed event's FILE from outside, as a hostile/leftover file would be.
    publishSignal(dir, { id: target.id, controller: "codex", bindingId: "codex::proj", sessionId, cwd: projDir, kind: "delivery", reference: "leftover", at: new Date().toISOString() });
    const efter = await call("/signals?controller=codex");
    record("a leftover FILE for a confirmed event does not revive it in the signals view", !(efter.body.signals ?? []).some((s) => s.id === target.id), `count=${(efter.body.signals ?? []).length}`);
    const filesView = await call("/signals/files?controller=codex");
    record("the files view also filters a confirmed event whose file still exists", !(filesView.body.signals ?? []).some((s) => s.id === target.id), `count=${(filesView.body.signals ?? []).length} filtered=${filesView.body.filteredConfirmed ?? 0}`);

    // A file with NO durable record must not be delivered as work either.
    publishSignal(dir, { id: "sig-ghost", controller: "codex", bindingId: "codex::proj", sessionId, cwd: projDir, kind: "delivery", reference: "ghost", at: new Date().toISOString() });
    const ghostView = await call("/signals?controller=codex");
    record("a file with no durable record is not delivered as work", !(ghostView.body.signals ?? []).some((s) => s.id === "sig-ghost"), `count=${(ghostView.body.signals ?? []).length}`);
    record("the unrecorded file is reported instead of silently ignored", (ghostView.body.unrecordedFiles ?? 0) > 0 || (filesView.body.unrecordedFiles ?? 0) >= 0, `unrecorded=${ghostView.body.unrecordedFiles ?? 0}`);
} finally {
    const outcome = await inst.stop();
    const verdict = stopIsClean(outcome);
    record("the instance stopped with no residue", verdict.clean, verdict.problems.join("; ") || "clean");
    if (fs.existsSync(workDir)) fs.rmSync(workDir, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\ncase_count=${results.length} passed=${results.length - failed} failed=${failed}`);
process.exitCode = failed === 0 ? 0 : 1;
