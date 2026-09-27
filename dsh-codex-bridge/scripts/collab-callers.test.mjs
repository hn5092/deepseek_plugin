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
 *  4. CONFIGURED-BOUNDS-FROM-THE-FIRST-WRITE — the retention window must be the CONFIGURED one before any
 *     reclaim has happened, on a fresh instance and again after a restart, and an unreadable store must
 *     refuse production instead of looking empty.
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
    // A window long enough that the confirmed record is still RETAINED across the restart, which is what
    // makes the retry expectation "idempotent" rather than "expired".
    const home = path.join(workDir, "home");
    const storeRoot = path.join(workDir, "store3");
    fs.mkdirSync(home, { recursive: true });
    const longWindowMs = 60_000;
    const firstRun = await startIsolatedInstance({
        pluginRoot, bindings, controllerTokens, answerTimeoutMs: 8000,
        inboxRoot: path.join(workDir, "inbox3"), storeRoot, home,
        extraConfig: { inboxMaxAgeMs: longWindowMs, inboxMaxEvents: 500 }
    });
    let confirmedId = null;
    let originalSeq = null;
    try {
        const call3 = makeCaller(firstRun);
        const client = new DshClient(new URL(firstRun.url), 55_000);
        await client.login();
        firstRun.cookie = client.cookie;
        await client.rpc("session/create", { request: { cwd: projDir, sessionId } });
        const issuedAt = new Date().toISOString();
        const created = await call3("/notify", { method: "POST", body: JSON.stringify({ sessionId, controller: "codex", kind: "delivery", text: "survives restart", requestId: "restart-producer", issuedAt }) });
        confirmedId = created.body.signalId;
        originalSeq = new CollabStore(storeRoot).getRecord(confirmedId).value.seq;
        await call3("/signals/confirm", { method: "POST", body: JSON.stringify({ controller: "codex", signalId: confirmedId }) });
        const before = await call3("/signals?controller=codex");
        record("the event is confirmed before the restart", !(before.body.signals ?? []).some((s) => s.id === confirmedId), `count=${(before.body.signals ?? []).length}`);
        record("the record is RETAINED, not reclaimed, so a retry of it must be idempotent",
            new CollabStore(storeRoot).getRecord(confirmedId).ok, "present before the restart");
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
        inboxRoot: path.join(workDir, "inbox3"), storeRoot, home,
        extraConfig: { inboxMaxAgeMs: longWindowMs, inboxMaxEvents: 500 }
    });
    try {
        const call4 = makeCaller(secondRun);
        const client = new DshClient(new URL(secondRun.url), 55_000);
        await client.login();
        secondRun.cookie = client.cookie;
        // The session is adopted first: a Session must exist for a producer to act on it at all, and
        // `session/create` is an idempotent adoption of the SAME log rather than a controller read. The
        // ordering being tested is that the PRODUCER runs before the controller's first GET, which still
        // holds — no `/signals`, `/questions` or `/wait` call has been made yet.
        await client.rpc("session/create", { request: { cwd: projDir, sessionId } });

        // The PRODUCER acts FIRST, before the controller reads anything. Because the record is retained,
        // the contract says this retry is the SAME event: it must be accepted IDEMPOTENTLY, must not create
        // a second record, and must not come back as outstanding work. A producer running against an
        // unloaded cache would instead see nothing and mint a fresh event, which is the defect this guards.
        const retry = await call4("/notify", { method: "POST", body: JSON.stringify({ sessionId, controller: "codex", kind: "delivery", text: "survives restart", requestId: "restart-producer", issuedAt: new Date().toISOString() }) });
        record("a producer retrying a RETAINED event after a restart is accepted idempotently",
            retry.status === 200 && retry.body.signalId === confirmedId, `status=${retry.status} sameId=${retry.body.signalId === confirmedId}`);
        const afterRetry = new CollabStore(storeRoot);
        record("the retry did not mint a second record", (afterRetry.allRecords().records.filter((r) => r.id === confirmedId)).length === 1, "one record with that id");
        record("the retry kept the ORIGINAL sequence, so it is the same event", afterRetry.getRecord(confirmedId).value.seq === originalSeq, `seq=${afterRetry.getRecord(confirmedId).value.seq} original=${originalSeq}`);

        // Only NOW does the controller read for the first time.
        const after = await call4("/signals?controller=codex");
        record("the confirmed event did NOT come back as outstanding after the restart", !(after.body.signals ?? []).some((s) => s.id === confirmedId), `count=${(after.body.signals ?? []).length}`);
        const confirmedAfter = await call4("/signals/confirm", { method: "POST", body: JSON.stringify({ controller: "codex", signalId: confirmedId }) });
        record("confirming the retained record again is idempotent", confirmedAfter.status === 200 && confirmedAfter.body.idempotent === true, `status=${confirmedAfter.status} idempotent=${confirmedAfter.body.idempotent}`);
    } finally {
        const outcome = await secondRun.stop();
        const verdict = stopIsClean(outcome);
        record("the restarted instance stopped with no residue", verdict.clean, verdict.problems.join("; ") || "clean");
    }

    // ---- 4) the CONFIGURED window applies from the first write, and a broken store is refused ----
    // The defect this guards: the owner's window defaulted to seven days and was only overwritten when a
    // reclaim happened to run, so a fresh instance judged retries by the default. Here NOTHING is confirmed
    // and NO reclaim is triggered, so only a correctly injected configuration can reject the retry.
    {
        const narrowWindowMs = 1000;
        const narrowStore = path.join(workDir, "store-narrow");
        const narrow = await startIsolatedInstance({
            pluginRoot, bindings, controllerTokens, answerTimeoutMs: 8000,
            inboxRoot: path.join(workDir, "inbox-narrow"), storeRoot: narrowStore,
            extraConfig: { inboxMaxAgeMs: narrowWindowMs, inboxMaxEvents: 500 }
        });
        try {
            const call5 = makeCaller(narrow);
            const client = new DshClient(new URL(narrow.url), 55_000);
            await client.login();
            narrow.cookie = client.cookie;
            await client.rpc("session/create", { request: { cwd: projDir, sessionId } });

            // An issue time two seconds before "now" is outside a one-second window. No confirm and no
            // reclaim has run on this instance, so the rejection can only come from the injected config.
            const staleIssuedAt = new Date(Date.now() - 2000).toISOString();
            const refused = await call5("/notify", { method: "POST", body: JSON.stringify({ sessionId, controller: "codex", kind: "delivery", text: "stale", requestId: "narrow-stale", issuedAt: staleIssuedAt }) });
            record("a fresh instance rejects a stale retry by the CONFIGURED window, with no prior reclaim",
                refused.status >= 400 && /expired/.test(JSON.stringify(refused.body)), `status=${refused.status} detail=${refused.body.detail ?? ""}`);
            record("the refused stale retry created no record",
                !new CollabStore(narrowStore).allRecords().records.some((r) => r.id.includes("narrow-stale")), "no record with that id");

            // The SAME window applies to a normal new notification, which must still work.
            const fresh = await call5("/notify", { method: "POST", body: JSON.stringify({ sessionId, controller: "codex", kind: "delivery", text: "fresh" }) });
            record("a normal new notification is unaffected by the narrow window", fresh.status === 200, `status=${fresh.status}`);
        } finally {
            const outcome = await narrow.stop();
            const verdict = stopIsClean(outcome);
            record("the narrow-window instance stopped with no residue", verdict.clean, verdict.problems.join("; ") || "clean");
        }

        // After a RESTART on the same home the configured window must still apply to the first write.
        const narrowHome = path.join(workDir, "home-narrow");
        fs.mkdirSync(narrowHome, { recursive: true });
        const firstNarrow = await startIsolatedInstance({
            pluginRoot, bindings, controllerTokens, answerTimeoutMs: 8000,
            inboxRoot: path.join(workDir, "inbox-narrow2"), storeRoot: narrowStore, home: narrowHome,
            extraConfig: { inboxMaxAgeMs: narrowWindowMs, inboxMaxEvents: 500 }
        });
        try {
            const call6 = makeCaller(firstNarrow);
            const client = new DshClient(new URL(firstNarrow.url), 55_000);
            await client.login();
            firstNarrow.cookie = client.cookie;
            await client.rpc("session/create", { request: { cwd: projDir, sessionId } });
            await call6("/notify", { method: "POST", body: JSON.stringify({ sessionId, controller: "codex", kind: "delivery", text: "existing" }) });
        } finally {
            await firstNarrow.stop();
        }
        const secondNarrow = await startIsolatedInstance({
            pluginRoot, bindings, controllerTokens, answerTimeoutMs: 8000,
            inboxRoot: path.join(workDir, "inbox-narrow2"), storeRoot: narrowStore, home: narrowHome,
            extraConfig: { inboxMaxAgeMs: narrowWindowMs, inboxMaxEvents: 500 }
        });
        try {
            const call7 = makeCaller(secondNarrow);
            const client = new DshClient(new URL(secondNarrow.url), 55_000);
            await client.login();
            secondNarrow.cookie = client.cookie;
            await client.rpc("session/create", { request: { cwd: projDir, sessionId } });
            const staleAfterRestart = await call7("/notify", { method: "POST", body: JSON.stringify({ sessionId, controller: "codex", kind: "delivery", text: "stale", requestId: "narrow-restart", issuedAt: new Date(Date.now() - 2000).toISOString() }) });
            record("after a restart the first write still uses the CONFIGURED window, not a default",
                staleAfterRestart.status >= 400 && /expired/.test(JSON.stringify(staleAfterRestart.body)), `status=${staleAfterRestart.status} detail=${staleAfterRestart.body.detail ?? ""}`);
        } finally {
            const outcome = await secondNarrow.stop();
            const verdict = stopIsClean(outcome);
            record("the restarted narrow-window instance stopped with no residue", verdict.clean, verdict.problems.join("; ") || "clean");
        }
    }

    // ---- 5) a store that cannot be READ must refuse production, not look empty ----------------
    // A file placed where the events DIRECTORY must be produces a real read error that is not ENOENT. It
    // must be reported and production refused; it must NOT be mistaken for "no records yet".
    {
        const blockedStore = path.join(workDir, "store-blocked");
        fs.mkdirSync(blockedStore, { recursive: true });
        fs.writeFileSync(path.join(blockedStore, "events"), "a file where the events directory must be", "utf8");
        const blocked = await startIsolatedInstance({
            pluginRoot, bindings, controllerTokens, answerTimeoutMs: 6000,
            inboxRoot: path.join(workDir, "inbox-blocked"), storeRoot: blockedStore,
            evidenceDir: path.join(workDir, "evidence")
        });
        try {
            const call8 = makeCaller(blocked);
            const client = new DshClient(new URL(blocked.url), 55_000);
            await client.login();
            blocked.cookie = client.cookie;
            await client.rpc("session/create", { request: { cwd: projDir, sessionId } });
            const refused = await call8("/notify", { method: "POST", body: JSON.stringify({ sessionId, controller: "codex", kind: "delivery", text: "must not be written" }) });
            record("an unreadable store refuses production instead of reporting success", refused.status >= 500, `status=${refused.status} detail=${refused.body.detail ?? refused.body.error ?? ""}`);
            // The refusal must carry the REAL error, not a generic message and not an empty-store claim:
            // `ENOTDIR` here is the concrete read failure, and it has to survive to the caller so an
            // operator can tell a broken store from a fresh one.
            const detail = String(refused.body.detail ?? "");
            record("the refusal names the real read failure, so the error is not swallowed",
                /store-not-loaded/.test(detail) && /ENOTDIR|could not be read/.test(detail), detail.slice(0, 150));
            record("nothing was written into the broken store", fs.readFileSync(path.join(blockedStore, "events"), "utf8") === "a file where the events directory must be", "the placeholder file is untouched");
        } finally {
            const outcome = await blocked.stop();
            const verdict = stopIsClean(outcome);
            record("the instance with the broken store stopped with no residue", verdict.clean, verdict.problems.join("; ") || "clean");
        }
    }
} finally {
    if (fs.existsSync(workDir)) fs.rmSync(workDir, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\ncase_count=${results.length} passed=${results.length - failed} failed=${failed}`);
process.exitCode = failed === 0 ? 0 : 1;
