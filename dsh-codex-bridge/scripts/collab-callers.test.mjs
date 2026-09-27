/**
 * Acceptance for the three formal-caller gaps a fourth review found.
 *
 * Each case is the smallest real scenario that failed, driven through the formal entry points rather
 * than the internal helpers, because the defects were all "the owner is right but nobody wired it up":
 *
 *  1. RECLAIMED-THEN-RETRIED — an arbitrary `requestId` whose record was reclaimed must NOT become a new
 *     outstanding event. The retry either names the original issue time (and is told expired) or is
 *     refused outright; it can never slip past the expiry check by omitting the time.
 *  2. CONFIRMED-then-TERMINAL — confirming N pending questions does NOT finish them, so a batch
 *     confirmation followed by plain answers/timeouts must still be reclaimed at the terminal boundary
 *     even though no further confirmation ever arrives.
 *  3. PRODUCER-BEFORE-CONTROLLER — after a real restart the model's producer (and the native observer)
 *     must act on the LOADED state, not on an empty cache, so an already-confirmed record is not
 *     resurrected by a producer that ran before the controller's first read.
 *
 * Run: node scripts/collab-callers.test.mjs
 *
 * @module dsh-codex-bridge/scripts/collab-callers.test
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { startIsolatedInstance, stopIsClean } from "./isolated-instance.mjs";
import { CollabStore, NOTIFICATION, NOTICE_STATE } from "../lib/store.js";

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

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "collab-callers-"));
const projDir = path.join(workDir, "proj");
fs.mkdirSync(projDir, { recursive: true });
const sessionId = "session-callers";
const TOKEN = "test-controller-codex-secret";
const REF = "TEST_CONTROLLER_TOKEN_CODEX";
const bindings = [{ bindingId: "codex::call", sessionId, cwd: projDir, controller: "codex", tokenRef: REF }];
const controllerTokens = [{ controller: "codex", tokenRef: REF, token: TOKEN }];

/** One control request as the controller. */
const makeCaller = (inst) => (route, init = {}) => fetch(new URL(`/codex-collab${route}`, new URL(inst.url)), {
    ...init,
    headers: { cookie: inst.cookie, "content-type": "application/json", "x-controller-token": TOKEN, ...(init.headers ?? {}) }
}).then(async (response) => ({ status: response.status, body: await response.json().catch(() => ({})) }));

try {
    // ---- 1) a reclaimed requestId must not become new work ---------------------------------
    // The window is small but REAL: an age bound of zero would make even a timestamp taken in the same
    // millisecond "beyond the window" a moment later, so the test would be racing the clock instead of
    // exercising the rule. A one-second bound lets this run age a record deliberately.
    const WINDOW_MS = 1000;
    const inst = await startIsolatedInstance({
        pluginRoot, bindings, controllerTokens, answerTimeoutMs: 8000,
        inboxRoot: path.join(workDir, "inbox"), storeRoot: path.join(workDir, "store"),
        extraConfig: { inboxMaxAgeMs: WINDOW_MS, inboxMaxEvents: 1 }
    });
    const call = makeCaller(inst);
    try {
        const client = new DshClient(new URL(inst.url), 55_000);
        await client.login();
        inst.cookie = client.cookie;
        await client.rpc("session/create", { request: { cwd: projDir, sessionId } });

        const issuedAt = new Date().toISOString();
        const first = await call("/notify", { method: "POST", body: JSON.stringify({ sessionId, controller: "codex", kind: "delivery", text: "reclaim me", requestId: "caller-reclaim", issuedAt }) });
        record("a notification with an issue time is accepted", first.status === 200, `status=${first.status}`);
        const signalId = first.body.signalId;
        // A reader is constructed per observation rather than once: `CollabStore` reads the directory on
        // each call, but the test must not hold a snapshot taken before the records it is asserting about.
        // The store is consulted directly because `/signals` lists only OUTSTANDING records, so a confirmed
        // record is invisible there whether or not it still exists and cannot prove reclamation.
        const readRecord = (id) => new CollabStore(path.join(workDir, "store")).getRecord(id);
        record("the record exists before it is finished", readRecord(signalId).ok, `id=${signalId}`);
        /** The sequence the first record was issued with, used to tell a re-created record apart from it. */
        const originalSeq = readRecord(signalId).value.seq;

        // Confirm it so it becomes reclaimable, then let real time pass and push it out of the retained
        // window with a second confirmed record. The age bound is `> 0`, so a measurable delay is required
        // — a zero-millisecond wait would leave this asserting on a race rather than on the rule.
        await call("/signals/confirm", { method: "POST", body: JSON.stringify({ controller: "codex", signalId }) });
        // Wait past the window so the first record is genuinely reclaimable, not merely confirmed.
        await new Promise((r) => setTimeout(r, WINDOW_MS + 200));
        const newer = await call("/notify", { method: "POST", body: JSON.stringify({ sessionId, controller: "codex", kind: "delivery", text: "newer", requestId: "caller-newer", issuedAt: new Date().toISOString() }) });
        await call("/signals/confirm", { method: "POST", body: JSON.stringify({ controller: "codex", signalId: newer.body.signalId }) });
        record("the first event is actually RECLAIMED (its record is gone, not merely confirmed)",
            !readRecord(signalId).ok, `stillPresent=${readRecord(signalId).ok}`);

        // The retry, WITHOUT the original time, must not create a new outstanding event.
        const bare = await call("/notify", { method: "POST", body: JSON.stringify({ sessionId, controller: "codex", kind: "delivery", text: "reclaim me", requestId: "caller-reclaim" }) });
        record("retrying a reclaimed id WITHOUT its issue time is refused", bare.status >= 400, `status=${bare.status} detail=${bare.body.detail ?? bare.body.error ?? ""}`);
        record("the refused retry did not re-create the record", !readRecord(signalId).ok, `present=${readRecord(signalId).ok}`);
        const listed = await call("/signals?controller=codex");
        record("the refused retry did not become new outstanding work", !(listed.body.signals ?? []).some((s) => (s.requestId ?? "") === "caller-reclaim"), `count=${(listed.body.signals ?? []).length}`);

        // The retry WITH the original time is recognized as expired, and still does not re-appear.
        const retried = await call("/notify", { method: "POST", body: JSON.stringify({ sessionId, controller: "codex", kind: "delivery", text: "reclaim me", requestId: "caller-reclaim", issuedAt }) });
        record("retrying with the ORIGINAL issue time is answered as expired", retried.status >= 400 && /expired/.test(JSON.stringify(retried.body)), `status=${retried.status} detail=${retried.body.detail ?? ""}`);
        record("the expired retry did not re-create the record", !readRecord(signalId).ok, `present=${readRecord(signalId).ok}`);
        const listedAgain = await call("/signals?controller=codex");
        record("the expired retry did not re-appear as work either", !(listedAgain.body.signals ?? []).some((s) => (s.requestId ?? "") === "caller-reclaim"), `count=${(listedAgain.body.signals ?? []).length}`);

        // The stated LIMIT, asserted so it is recorded rather than glossed over. With the record gone, a
        // caller presenting an IN-WINDOW issue time is indistinguishable from one legitimately creating a
        // new event under a custom id, so it is accepted. The id string is the same because it is DERIVED
        // from the requestId; what proves it is a fresh record is its new sequence number. Bounded
        // retention and perfect deduplication of an arbitrary string cannot both hold — the retry contract
        // above is what makes the common case safe, and an over-window retry that omits its original time
        // is still refused.
        const inWindow = await call("/notify", { method: "POST", body: JSON.stringify({ sessionId, controller: "codex", kind: "delivery", text: "reclaim me", requestId: "caller-reclaim", issuedAt: new Date().toISOString() }) });
        const recreated = readRecord(inWindow.body.signalId);
        record("an in-window issue time under a reclaimed id creates a NEW record (the stated limit)",
            inWindow.status === 200 && recreated.ok && recreated.value.seq > originalSeq,
            `status=${inWindow.status} newSeq=${recreated.ok ? recreated.value.seq : "none"} originalSeq=${originalSeq}`);
        record("the re-created record is NOT already confirmed, so it is genuinely new work",
            recreated.ok && recreated.value.notification !== "confirmed", `notification=${recreated.ok ? recreated.value.notification : "none"}`);
        // Leave the store clean for the checks that follow.
        await call("/signals/confirm", { method: "POST", body: JSON.stringify({ controller: "codex", signalId: inWindow.body.signalId }) });
        // ---- 2) batch confirm, then plain terminal outcomes, with NO further confirm ----------
        const batchCount = 5;
        const batchIds = [];
        for (let i = 0; i < batchCount; i += 1) {
            const created = await call("/notify", { method: "POST", body: JSON.stringify({ sessionId, controller: "codex", kind: "delivery", text: `batch ${i}` }) });
            batchIds.push(created.body.signalId);
        }
        for (const id of batchIds) await call("/signals/confirm", { method: "POST", body: JSON.stringify({ controller: "codex", signalId: id }) });

        // Create MORE than maxEvents terminal questions so the window cannot retain them all, confirm each
        // first (notification only), then answer each with NO further confirmation anywhere.
        const questionIds = [];
        for (let i = 0; i < batchCount * 2; i += 1) {
            const reservation = new CollabStore(path.join(workDir, "store")).reserveSeq();
            const id = `collab-batch-${reservation.seq}`;
            new CollabStore(path.join(workDir, "store")).putRecord({
                id, seq: reservation.seq, generation: reservation.generation,
                bindingId: "codex::call", controller: "codex", sessionId, cwd: projDir,
                kind: "question", sourceIdentity: {}, reference: "collab-question",
                createdAt: new Date(Date.now() - 60_000).toISOString(),
                notification: NOTIFICATION.OUTSTANDING, business: "pending", question: `batch question ${i}`
            });
            questionIds.push(id);
        }
        for (const id of questionIds) await call("/signals/confirm", { method: "POST", body: JSON.stringify({ controller: "codex", signalId: id }) });
        const stillPending = await call(`/questions?sessionId=${sessionId}&controller=codex`);
        record("confirming a pending question does NOT finish it", (stillPending.body.questions ?? []).length >= questionIds.length, `pending=${(stillPending.body.questions ?? []).length}`);
        record("the confirmed-but-pending records are all still stored", questionIds.every((id) => readRecord(id).ok), `present=${questionIds.filter((id) => readRecord(id).ok).length}/${questionIds.length}`);

        // Now finish them through the ANSWER boundary; retention must run at that boundary by itself.
        for (const id of questionIds) {
            await call("/answer", { method: "POST", body: JSON.stringify({ questionId: id, text: "done", source: "codex", controller: "codex" }) });
        }
        await new Promise((r) => setTimeout(r, WINDOW_MS + 200));
        // One more notification pushes the window so the finished questions past it are reclaimed by the
        // normal boundary; no question is ever confirmed again.
        const pusher = await call("/notify", { method: "POST", body: JSON.stringify({ sessionId, controller: "codex", kind: "delivery", text: "push" }) });
        await call("/signals/confirm", { method: "POST", body: JSON.stringify({ controller: "codex", signalId: pusher.body.signalId }) });
        const remainingQuestions = questionIds.filter((id) => readRecord(id).ok);
        record("finished questions are reclaimed at the terminal boundary, with no later confirmation",
            remainingQuestions.length < questionIds.length, `remaining=${remainingQuestions.length}/${questionIds.length}`);

        // An UNCONFIRMED record must never be removed, however full the store is.
        const neverConfirmed = await call("/notify", { method: "POST", body: JSON.stringify({ sessionId, controller: "codex", kind: "delivery", text: "never confirmed" }) });
        for (let i = 0; i < 4; i += 1) {
            const filler = await call("/notify", { method: "POST", body: JSON.stringify({ sessionId, controller: "codex", kind: "delivery", text: `filler ${i}` }) });
            await call("/signals/confirm", { method: "POST", body: JSON.stringify({ controller: "codex", signalId: filler.body.signalId }) });
        }
        record("an UNCONFIRMED record survives every reclamation that ran", readRecord(neverConfirmed.body.signalId).ok, `present=${readRecord(neverConfirmed.body.signalId).ok}`);
    } finally {
        const outcome = await inst.stop();
        const verdict = stopIsClean(outcome);
        record("the instance stopped with no residue", verdict.clean, verdict.problems.join("; ") || "clean");
    }

    // ---- 3) a producer must act on LOADED state after a real restart -----------------------
    const home = path.join(workDir, "home");
    const storeRoot = path.join(workDir, "store3");
    fs.mkdirSync(home, { recursive: true });
    const firstRun = await startIsolatedInstance({
        pluginRoot, bindings, controllerTokens, answerTimeoutMs: 8000,
        inboxRoot: path.join(workDir, "inbox3"), storeRoot, home
    });
    let confirmedId = null;
    try {
        const call3 = makeCaller(firstRun);
        const client = new DshClient(new URL(firstRun.url), 55_000);
        await client.login();
        firstRun.cookie = client.cookie;
        await client.rpc("session/create", { request: { cwd: projDir, sessionId } });
        const issuedAt = new Date().toISOString();
        const created = await call3("/notify", { method: "POST", body: JSON.stringify({ sessionId, controller: "codex", kind: "delivery", text: "survives restart", requestId: "restart-producer", issuedAt }) });
        confirmedId = created.body.signalId;
        await call3("/signals/confirm", { method: "POST", body: JSON.stringify({ controller: "codex", signalId: confirmedId }) });
        const before = await call3("/signals?controller=codex");
        record("the event is confirmed before the restart", !(before.body.signals ?? []).some((s) => s.id === confirmedId), `count=${(before.body.signals ?? []).length}`);
    } finally {
        // No `keepLog`: a retained scratch directory would be a silent leak, and the receipt is asserted so
        // a host that failed to stop cannot pass unnoticed. The caller-owned home lives outside it and is
        // preserved deliberately, so it is not reported as residue.
        const firstOutcome = await firstRun.stop();
        const firstVerdict = stopIsClean(firstOutcome);
        record("the first host stopped and its scratch was removed", firstVerdict.clean, firstVerdict.problems.join("; ") || "clean");
    }

    const secondRun = await startIsolatedInstance({
        pluginRoot, bindings, controllerTokens, answerTimeoutMs: 8000,
        inboxRoot: path.join(workDir, "inbox3"), storeRoot, home
    });
    try {
        const call4 = makeCaller(secondRun);
        const client = new DshClient(new URL(secondRun.url), 55_000);
        await client.login();
        secondRun.cookie = client.cookie;

        // The PRODUCER acts FIRST, before the controller reads anything: the model retries the same event.
        // A producer running on an unloaded cache would see no record and could create a fresh one.
        const retry = await call4("/notify", { method: "POST", body: JSON.stringify({ sessionId, controller: "codex", kind: "delivery", text: "survives restart", requestId: "restart-producer", issuedAt: new Date(Date.now() - 1000).toISOString() }) });
        record("a producer retrying a confirmed event after a restart is answered as expired", retry.status >= 400, `status=${retry.status} detail=${retry.body.detail ?? ""}`);

        // Only NOW does the controller read for the first time.
        const after = await call4("/signals?controller=codex");
        record("the confirmed event did NOT come back after the restart", !(after.body.signals ?? []).some((s) => s.id === confirmedId), `count=${(after.body.signals ?? []).length}`);
        const confirmedAfter = await call4("/signals/confirm", { method: "POST", body: JSON.stringify({ controller: "codex", signalId: confirmedId }) });
        record("the record is still known as confirmed, so confirming it again is idempotent or retired", confirmedAfter.status === 200 || confirmedAfter.status === 410, `status=${confirmedAfter.status}`);
    } finally {
        const outcome = await secondRun.stop();
        const verdict = stopIsClean(outcome);
        record("the restarted instance stopped with no residue", verdict.clean, verdict.problems.join("; ") || "clean");
    }
} finally {
    if (fs.existsSync(workDir)) fs.rmSync(workDir, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\ncase_count=${results.length} passed=${results.length - failed} failed=${failed}`);
process.exitCode = failed === 0 ? 0 : 1;
