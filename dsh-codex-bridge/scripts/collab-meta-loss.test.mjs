/**
 * Acceptance: a store whose meta is lost at runtime must not silently become a new store.
 *
 * The defect: `reserveSeq` read the meta without being told whether records already exist, so a meta file
 * that disappeared WHILE the process was running was indistinguishable from a fresh store, and the next
 * producer wrote from sequence 1 — renumbering the store and able to collide with a server-issued event
 * id that was already there.
 *
 * The whole point of this suite is the ROUTE it takes. A controller HTTP reload refuses correctly, and an
 * earlier revision relied on that: the check lived in the load path, so it only held for a client that
 * happened to re-read first. Here NO collaboration HTTP request is made after the meta is removed — the
 * write is attempted by a real model tool and by a real native event, which are the producers that
 * actually run unattended.
 *
 * Run: node scripts/collab-meta-loss.test.mjs
 *
 * @module dsh-codex-bridge/scripts/collab-meta-loss.test
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { startIsolatedInstance, stopIsClean } from "./isolated-instance.mjs";
import { CollabStore } from "../lib/store.js";

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

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "collab-meta-"));
const projDir = path.join(workDir, "proj");
fs.mkdirSync(projDir, { recursive: true });
const sessionId = "session-meta";
const TOKEN = "test-controller-codex-secret";
const REF = "TEST_CONTROLLER_TOKEN_CODEX";
const storeRoot = path.join(workDir, "store");

// ---- 1) the allocator itself refuses a lost meta -------------------------------------------
// The cheapest counterexample, at the shared allocation boundary every producer uses, so the rule is
// proven independently of any one caller.
{
    const root = path.join(workDir, "store-unit");
    const store = new CollabStore(root);
    record("a fresh store allocates its first sequence", store.reserveSeq().ok, "fresh reservation");
    const first = store.reserveSeq();
    store.putRecord({
        id: "server-minted-1", seq: first.seq, generation: first.generation,
        bindingId: "codex::meta", controller: "codex", sessionId, cwd: projDir,
        kind: "delivery", sourceIdentity: {}, reference: "collab:server-minted-1",
        createdAt: new Date().toISOString(), notification: "outstanding", business: "terminal"
    });
    const before = store.readMeta();
    record("a record now exists with a known high-water mark", before.ok && first.seq >= 1, `nextSeq=${before.meta.nextSeq}`);

    // The meta vanishes, exactly as a lost file would.
    const metaFile = path.join(root, "controller-meta.json");
    fs.rmSync(metaFile, { force: true });
    record("the test really removed the meta", !fs.existsSync(metaFile), "meta gone");

    // An allocation must now be REFUSED, not restarted at 1.
    const afterLoss = store.reserveSeq();
    record("allocating with a lost meta beside existing records is REFUSED", afterLoss.ok === false, `ok=${afterLoss.ok} reason=${afterLoss.reason ?? ""}`);
    record("the refusal names the lost sequence history", /sequence history|lost|missing/i.test(String(afterLoss.reason)), String(afterLoss.reason ?? ""));
    record("the refusal did NOT restart the sequence at 1", afterLoss.seq === undefined, `seq=${afterLoss.seq}`);
    record("no meta was written by the refused allocation", !fs.existsSync(metaFile), "meta still absent");
    record("the existing record is untouched by the refusal", store.getRecord("server-minted-1").ok, "record present");

    // A store that is genuinely fresh still allocates normally, so the rule is not a blanket refusal.
    const fresh = new CollabStore(path.join(workDir, "store-fresh"));
    record("a genuinely fresh store still allocates", fresh.reserveSeq().ok, "fresh store unaffected");
}

// ---- 2) the real producers, with NO controller reload --------------------------------------
// The scripted provider is configured to call `ask_codex`, so the "pending ask fails with a storage
// error rather than hanging" case is driven by a REAL model tool. The server-minted events are produced
// by NATIVE Goal completions, which is the other producer that runs without anyone watching.
const inst = await startIsolatedInstance({
    pluginRoot,
    bindings: [{ bindingId: "codex::meta", sessionId, cwd: projDir, controller: "codex", tokenRef: REF }],
    controllerTokens: [{ controller: "codex", tokenRef: REF, token: TOKEN }],
    inboxRoot: path.join(workDir, "inbox"), storeRoot,
    scripted: { question: "Should this question be recorded?" },
    answerTimeoutMs: 8000
});

/** Complete a Goal through the harness's own service, which emits a native `goal/change` event. */
const completeAGoal = async (client, objective) => {
    const created = await client.rpc("goals/create", {
        agentId: sessionId,
        request: { id: `goal-${crypto.randomUUID()}`, revision: 1, objective, maxGoalRounds: 1 }
    }).then((value) => ({ ok: true, value })).catch((error) => ({ ok: false, reason: String(error.message).slice(0, 140) }));
    if (!created.ok) return created;
    const ref = created.value && created.value.ref ? created.value.ref : created.value;
    return await client.rpc("goals/complete", { agentId: sessionId, ref: { id: ref.id, revision: ref.revision } })
        .then(() => ({ ok: true }))
        .catch((error) => ({ ok: false, reason: String(error.message).slice(0, 140) }));
};

try {
    const client = new DshClient(new URL(inst.url), 55_000);
    await client.login();
    inst.cookie = client.cookie;
    await client.rpc("session/create", { request: { cwd: projDir, sessionId } });

    // One native completion first, so the store has a record and a real high-water mark.
    const firstGoal = await completeAGoal(client, "mint one server event");
    record("a native Goal completion is accepted and mints an event", firstGoal.ok, firstGoal.ok ? "completed" : firstGoal.reason);
    await new Promise((r) => setTimeout(r, 2500));

    const store = new CollabStore(storeRoot);
    const existing = store.allRecords().records;
    record("the native event exists in the store", existing.length >= 1, `records=${existing.length}`);
    const metaBefore = store.readMeta({ recordsPresent: existing.length > 0 });
    record("the store has a known high-water mark before the loss", metaBefore.ok, `nextSeq=${metaBefore.ok ? metaBefore.meta.nextSeq : "unknown"}`);
    const idsBefore = existing.map((r) => r.id).sort();
    const seqsBefore = existing.map((r) => r.seq).sort((a, b) => a - b);

    // The meta is lost while the process keeps running.
    fs.rmSync(path.join(storeRoot, "controller-meta.json"), { force: true });
    record("the test removed the meta while the host kept running", !fs.existsSync(path.join(storeRoot, "controller-meta.json")), "meta gone");

    // NO collaboration HTTP request is made here. The very next write is a real NATIVE producer.
    const secondGoal = await completeAGoal(client, "mint a second event after the meta is lost");
    record("the native completion is still reported by the harness", secondGoal.ok, secondGoal.ok ? "completed" : secondGoal.reason);
    await new Promise((r) => setTimeout(r, 3000));

    const afterRecords = new CollabStore(storeRoot).allRecords().records;
    const idsAfter = afterRecords.map((r) => r.id).sort();
    record("the native producer did NOT mint a new event after the meta was lost", idsAfter.length === idsBefore.length, `before=${idsBefore.length} after=${idsAfter.length}`);
    record("no existing record was overwritten", idsBefore.every((id) => idsAfter.includes(id)), `ids=${JSON.stringify(idsAfter)}`);
    const seqsAfter = afterRecords.map((r) => r.seq).sort((a, b) => a - b);
    record("the existing cursor/high-water positions are unchanged", JSON.stringify(seqsBefore) === JSON.stringify(seqsAfter), `before=${JSON.stringify(seqsBefore)} after=${JSON.stringify(seqsAfter)}`);
    record("no meta was silently recreated from seq 1", !fs.existsSync(path.join(storeRoot, "controller-meta.json")), "meta still absent");
    // The refusal must be observable rather than silent. It is NOT read from the instance log: the plugin's
    // own logger does not write there, so asserting on that file would be asserting on nothing. The
    // observable fact is that the native producer's allocation was refused and the harness was informed —
    // and the store is unchanged, which the assertions above establish.
    const nativeStore = new CollabStore(storeRoot);
    const afterNative = nativeStore.readMeta({ recordsPresent: true });
    record("the native write left the store's sequence history still missing, not renumbered",
        !afterNative.ok && /sequence history|lost/i.test(String(afterNative.reason ?? "")), String(afterNative.reason ?? ""));

    // ---- 3) a real pending ASK must fail with that error, not hang -------------------------
    // The scripted provider calls `ask_codex` on this session's first model turn, so this is the real tool.
    // With the meta gone the question cannot be recorded, and the tool must return the storage reason
    // promptly instead of waiting out its deadline.
    const askStart = Date.now();
    await client.rpc("session/prompt", {
        request: {
            sessionId,
            requestId: crypto.randomUUID(),
            mode: "queue",
            content: [{ type: "text", text: 'Call the tool "ask_codex" with a question.' }],
            clientTimeZone: "Asia/Shanghai"
        }
    }).catch(() => { /* the tool result is the assertion */ });
    await new Promise((r) => setTimeout(r, 6000));
    const askElapsed = Date.now() - askStart;

    const afterAsk = await client.snapshot(sessionId, 300);
    const askResults = JSON.stringify(afterAsk.records.map((r) => r.event).filter((e) => e && e.type === "tool/result").map((e) => e.data));
    record("the pending ask was answered rather than left hanging", askResults.length > 2, `elapsed=${askElapsed}ms chars=${askResults.length}`);
    record("the failed ask reports a storage error instead of success", /not-recorded|question-not-recorded|lost|history/i.test(askResults) && !/"status":"answered"/.test(askResults), askResults.slice(0, 240));
    const finalRecords = new CollabStore(storeRoot).allRecords().records;
    record("the failed ask did not write a question either", finalRecords.length === idsBefore.length, `records=${finalRecords.length}`);
} finally {
    const outcome = await inst.stop();
    const verdict = stopIsClean(outcome);
    record("the instance stopped with no residue", verdict.clean, verdict.problems.join("; ") || "clean");
    if (fs.existsSync(workDir)) fs.rmSync(workDir, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\ncase_count=${results.length} passed=${results.length - failed} failed=${failed}`);
process.exitCode = failed === 0 ? 0 : 1;
