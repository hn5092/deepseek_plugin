/**
 * Focused tests for the signal rules and the file inbox.
 *
 * The signal layer exists so a controller can be woken without polling each session in turn, and the
 * file inbox exists so that wake-up survives a reconnect. Both are proven at the cheapest boundary:
 * pure functions, and a real temporary directory for the filesystem half.
 *
 * Run: node scripts/collab-signals.test.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
    deliverableSignals,
    normalizeSignal,
    signalVerdict,
    waitOutcome
} from "../lib/signals.js";
import { confirmSignal, inboxDirFor, publishSignal, readSignals } from "../lib/inbox.js";
// Imported under a local name purely to ASSERT its absence: a directory-level prune with file-age-only
// semantics would delete events a controller had not confirmed, so the module must not offer one.
import * as inboxModule from "../lib/inbox.js";
const pruneInbox = inboxModule.pruneInbox;
const watchInbox = inboxModule.watchInbox;

let passed = 0;
const cases = [];
/** @param {string} title - what the case proves. @param {() => void|Promise<void>} body - the assertions. */
function test(title, body) {
    cases.push({ title, body });
}

const baseSignal = {
    id: "sig-1",
    controller: "codex",
    bindingId: "codex::session-a",
    sessionId: "session-a",
    cwd: "D:/proj",
    kind: "question",
    at: "2026-09-26T10:00:00.000Z"
};

// ---- identity: a signal must carry what routes it ----------------------------------------
test("a signal carries id, controller, session, cwd and kind", () => {
    const result = normalizeSignal(baseSignal);
    assert.equal(result.ok, true);
    assert.equal(result.signal.sessionId, "session-a");
    assert.equal(result.signal.kind, "question");
});

/**
 * The integration counterexample a peer reproduced: one event id, one changed identity field.
 * Every one of these must be a conflict, because the contract uses these fields to stop a stale task's
 * event from being applied to the current one.
 */
for (const [field, value] of [
    ["bindingId", "binding-new"],
    ["cwd", "D:/different/b"],
    ["goalId", "goal-new"],
    ["requestId", "request-new"],
    ["reference", "question:new"]
]) {
    test(`the same event id with a changed ${field} is a conflict`, () => {
        const baseline = {
            id: "event-1",
            kind: "question",
            controller: "controller-a",
            bindingId: "binding-old",
            sessionId: "session-a",
            cwd: "D:/approved/a",
            goalId: "goal-old",
            requestId: "request-old",
            reference: "question:old"
        };
        assert.equal(signalVerdict(baseline, { ...baseline, [field]: value }).action, "conflict");
    });
}

test("a signal missing any routing identity is refused", () => {
    for (const missing of ["id", "controller", "bindingId", "sessionId", "cwd", "kind"]) {
        const candidate = { ...baseSignal };
        delete candidate[missing];
        assert.equal(normalizeSignal(candidate).ok, false, `${missing} must be mandatory`);
    }
});

// ---- multi-open: many sessions under one controller, and a second controller ---------------
test("signals from several sessions keep their own binding identity", () => {
    const signals = [
        normalizeSignal({ ...baseSignal, id: "s1", bindingId: "codex::a", sessionId: "a", cwd: "D:/projA" }).signal,
        normalizeSignal({ ...baseSignal, id: "s2", bindingId: "codex::b", sessionId: "b", cwd: "D:/projB" }).signal,
        normalizeSignal({ ...baseSignal, id: "s3", bindingId: "codex::c", sessionId: "c", cwd: "D:/projC" }).signal
    ];
    const delivered = deliverableSignals(signals, "codex", []);
    assert.equal(delivered.length, 3, "one controller receives all of its bindings");
    assert.deepEqual(delivered.map((s) => s.bindingId).sort(), ["codex::a", "codex::b", "codex::c"]);
    assert.deepEqual(delivered.map((s) => s.sessionId).sort(), ["a", "b", "c"], "no session is merged into another");
});

test("a second controller receives nothing of the first controller's bindings", () => {
    const signals = [
        normalizeSignal({ ...baseSignal, id: "s1", bindingId: "codex::a", sessionId: "a" }).signal,
        normalizeSignal({ ...baseSignal, id: "s2", controller: "other", bindingId: "other::b", sessionId: "b" }).signal
    ];
    assert.deepEqual(deliverableSignals(signals, "codex").map((s) => s.id), ["s1"]);
    assert.deepEqual(deliverableSignals(signals, "other").map((s) => s.id), ["s2"]);
});

test("confirming one session's event does not confirm another session's", () => {
    const signals = [
        normalizeSignal({ ...baseSignal, id: "a1", bindingId: "codex::a", sessionId: "a" }).signal,
        normalizeSignal({ ...baseSignal, id: "b1", bindingId: "codex::b", sessionId: "b" }).signal
    ];
    const remaining = deliverableSignals(signals, "codex", ["a1"]);
    assert.deepEqual(remaining.map((s) => s.id), ["b1"], "an unconfirmed event in another session survives");
});

test("two sessions raising the SAME local question id stay distinct by binding", () => {
    // The same local id in two sessions must not be one event.
    const one = normalizeSignal({ ...baseSignal, id: "sig-q-1", bindingId: "codex::a", sessionId: "a" }).signal;
    const two = normalizeSignal({ ...baseSignal, id: "sig-q-1", bindingId: "codex::b", sessionId: "b" }).signal;
    // Same signal id but a different binding is a conflict, never a silent merge.
    assert.equal(signalVerdict(one, two).action, "conflict");
});

test("a batch is bounded and reports whether more remain, without skipping events", () => {
    const signals = Array.from({ length: 7 }, (_, i) =>
        normalizeSignal({ ...baseSignal, id: `sig-${i}`, bindingId: `codex::s${i}`, sessionId: `s${i}` }).signal
    ).map((s, i) => ({ ...s, seq: i + 1 }));
    const first = waitOutcome({ signals, controller: "codex", maxBatch: 3 });
    assert.equal(first.signals.length, 3, "a batch is bounded");
    assert.equal(first.more, true, "the caller is told more remain");
    // Resuming from the cursor yields the next events, so nothing is skipped by the cap.
    const second = waitOutcome({ signals, controller: "codex", since: first.cursor, maxBatch: 3 });
    assert.deepEqual(second.signals.map((s) => s.id), ["sig-3", "sig-4", "sig-5"], "the next batch continues where the last stopped");
});

test("an unknown kind is refused", () => {
    assert.equal(normalizeSignal({ ...baseSignal, kind: "whatever" }).ok, false);
});

test("a signal does not carry the message body, only a reference", () => {
    const result = normalizeSignal({ ...baseSignal, reference: "session-event:42", text: "SECRET BODY" });
    assert.equal(result.ok, true);
    assert.equal(result.signal.reference, "session-event:42");
    assert.equal("text" in result.signal, false, "the inbox must not become a second body store");
});

// ---- duplicate handling: one identity, one event ------------------------------------------
test("the same id and content is the same event, not a second delivery", () => {
    assert.equal(signalVerdict(normalizeSignal(baseSignal).signal, normalizeSignal(baseSignal).signal).action, "same");
});

test("the same id with different content is a conflict", () => {
    const known = normalizeSignal(baseSignal).signal;
    const other = normalizeSignal({ ...baseSignal, sessionId: "session-b" }).signal;
    assert.equal(signalVerdict(known, other).action, "conflict");
});

test("an unseen id is new", () => {
    assert.equal(signalVerdict(null, normalizeSignal(baseSignal).signal).action, "new");
});

// The wake policy is no longer a helper here: a record's OUTSTANDING notification is what makes it
// deliverable, and whether a delivery exists at all is decided by the producer (a plain finished turn
// produces no record). That rule is proven at the real callers in `collab-native`, where a normal
// `turn/end` is shown to create nothing and a native Goal completion is shown to create a delivery.

// ---- selection: per controller, unacknowledged, oldest first -------------------------------
test("signals are selected per controller so bindings cannot cross", () => {
    const signals = [
        { id: "a", controller: "codex", seq: 1 },
        { id: "b", controller: "other", seq: 2 }
    ];
    assert.deepEqual(deliverableSignals(signals, "codex").map((s) => s.id), ["a"]);
});

test("confirmed signals are not delivered again", () => {
    const signals = [
        { id: "a", controller: "codex", seq: 1 },
        { id: "b", controller: "codex", seq: 2 }
    ];
    assert.deepEqual(deliverableSignals(signals, "codex", ["a"]).map((s) => s.id), ["b"]);
});

test("a wait with backlog returns immediately and reports nothing new when there is none", () => {
    const signals = [{ id: "a", controller: "codex", seq: 1 }];
    assert.equal(waitOutcome({ signals, controller: "codex" }).status, "signals");
    assert.equal(waitOutcome({ signals, controller: "codex", since: 1 }).status, "empty");
    assert.equal(waitOutcome({ signals: [], controller: "codex" }).status, "empty");
});

// Restart recovery no longer folds a signal log here: the record store IS the recovered state, and the
// proof lives at the real caller in `collab-pending-restart` (a real pending question and its signal
// rebuilt across a real restart) and `collab-projection` (reclamation does not lower the cursor). What
// remains testable at this boundary is that a cursor still selects only genuinely newer events.
test("a cursor selects only events newer than it", () => {
    const signals = [
        { id: "old", controller: "codex", seq: 1 },
        { id: "new", controller: "codex", seq: 2 }
    ];
    const outcome = waitOutcome({ signals, controller: "codex", since: 1 });
    assert.equal(outcome.status, "signals");
    assert.deepEqual(outcome.signals.map((s) => s.id), ["new"]);
});

test("a wait never invents an event that does not exist", () => {
    assert.equal(waitOutcome({ signals: [], controller: "codex" }).status, "empty");
});

// ---- the file inbox ------------------------------------------------------------------------
const inboxRoot = fs.mkdtempSync(path.join(os.tmpdir(), "collab-inbox-"));

test("a controller id that is not one safe segment is refused", () => {
    assert.equal(inboxDirFor(inboxRoot, "codex").ok, true);
    assert.equal(inboxDirFor(inboxRoot, "../escape").ok, false, "path traversal must be refused");
    assert.equal(inboxDirFor(inboxRoot, "a/b").ok, false);
    assert.equal(inboxDirFor(inboxRoot, "").ok, false);
});

test("two controllers get separate directories, so one cannot read the other", () => {
    const a = inboxDirFor(inboxRoot, "codex").dir;
    const b = inboxDirFor(inboxRoot, "other").dir;
    assert.notEqual(a, b);
});

test("an event is published as one complete file and read back intact", () => {
    const dir = inboxDirFor(inboxRoot, "codex").dir;
    const signal = normalizeSignal(baseSignal).signal;
    const published = publishSignal(dir, signal);
    assert.equal(published.ok, true);
    const { signals, problems } = readSignals(dir);
    assert.equal(problems.length, 0);
    assert.equal(signals.length, 1);
    assert.equal(signals[0].id, "sig-1");
});

test("publishing the same event twice does not create a second event", () => {
    const dir = inboxDirFor(inboxRoot, "idem").dir;
    const signal = normalizeSignal({ ...baseSignal, id: "sig-idem" }).signal;
    publishSignal(dir, signal);
    publishSignal(dir, signal);
    assert.equal(readSignals(dir).signals.length, 1, "a repeat notification is the same identity");
});

test("two different events in one inbox stay separate", () => {
    const dir = inboxDirFor(inboxRoot, "multi").dir;
    publishSignal(dir, normalizeSignal({ ...baseSignal, id: "sig-a" }).signal);
    publishSignal(dir, normalizeSignal({ ...baseSignal, id: "sig-b" }).signal);
    assert.deepEqual(readSignals(dir).signals.map((s) => s.id).sort(), ["sig-a", "sig-b"]);
});

test("a malformed file is reported, not silently treated as no work", () => {
    const dir = inboxDirFor(inboxRoot, "bad").dir;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "broken.json"), "{not json", "utf8");
    const { signals, problems } = readSignals(dir);
    assert.equal(signals.length, 0);
    assert.equal(problems.length, 1, "a corrupt event must be visible");
});

test("confirmation removes exactly one event and is idempotent", () => {
    const dir = inboxDirFor(inboxRoot, "confirm").dir;
    publishSignal(dir, normalizeSignal({ ...baseSignal, id: "keep" }).signal);
    publishSignal(dir, normalizeSignal({ ...baseSignal, id: "drop" }).signal);
    confirmSignal(dir, "drop");
    confirmSignal(dir, "drop");
    assert.deepEqual(readSignals(dir).signals.map((s) => s.id), ["keep"]);
});

test("re-reading the directory is the record, so a missed notification cannot lose an event", () => {
    // The inbox is a PROJECTION and every read re-reads the actual directory, which is what makes a
    // missed watcher notification harmless. There is deliberately no watcher to depend on: the previous
    // revision exposed one, but nothing consumed it, and a watcher is only ever a prompt to re-read.
    const dir = inboxDirFor(inboxRoot, "watch").dir;
    publishSignal(dir, normalizeSignal({ ...baseSignal, id: "before-read" }).signal);
    const first = readSignals(dir).signals.map((s) => s.id);
    assert.deepEqual(first, ["before-read"], "an event written before the read is returned by the read");
});

test("an event written after a read is seen by the NEXT read, so nothing is lost in between", () => {
    const dir = inboxDirFor(inboxRoot, "race").dir;
    fs.mkdirSync(dir, { recursive: true });
    const before = readSignals(dir).signals.map((s) => s.id);
    assert.deepEqual(before, [], "the directory starts empty");
    publishSignal(dir, normalizeSignal({ ...baseSignal, id: "after-read" }).signal);
    const after = readSignals(dir).signals.map((s) => s.id);
    assert.ok(after.includes("after-read"), `the next read sees it; saw ${JSON.stringify(after)}`);
});

// Retention is owned by the store, not by the inbox directory (see `CollabStore.reclaim`), and it is
// exercised against the real production class in `collab-durability`/`collab-five` where the store is
// live. What is asserted HERE is the property an inbox-level prune used to violate: an UNCONFIRMED event
// is never removable just because a cap was reached. The inbox module no longer exports a prune at all,
// so this guards against it being reintroduced with file-age-only semantics.
test("the inbox module exposes no directory-level prune that could drop unconfirmed events", () => {
    assert.equal(typeof pruneInbox, "undefined", "retention must be decided by the store that knows what is confirmed");
});

test("the inbox module exposes no watcher, because a read is the record", () => {
    // A watcher would be a second, asynchronous way to learn about files, and nothing consumed it; every
    // read re-reads the directory instead, so a missed notification cannot lose an event.
    assert.equal(typeof watchInbox, "undefined", "reads reconcile the directory; a watcher would be a second truth");
});

// The inbox root is removed AFTER the cases have run, in the runner below: removing it here would only
// delete the directory before the cases create anything in it, leaving the real contents behind.

// ---- runner ------------------------------------------------------------------------------
let failed = 0;
for (const { title, body } of cases) {
    try {
        await body();
        passed += 1;
        console.log(`PASS  ${title}`);
    } catch (error) {
        failed += 1;
        console.log(`FAIL  ${title}`);
        console.log(`      ${error && error.message}`);
    }
}
// Cleanup AFTER the cases, and asserted: a suite that silently leaves its scratch directory behind is
// leaking exactly what it is testing the plugin to avoid.
let inboxCleanupOk = false;
try {
    fs.rmSync(inboxRoot, { recursive: true, force: true });
    inboxCleanupOk = !fs.existsSync(inboxRoot);
} catch {
    inboxCleanupOk = false;
}
if (!inboxCleanupOk) {
    failed += 1;
    console.log("FAIL  the test inbox was removed and verified gone");
} else {
    passed += 1;
    console.log("PASS  the test inbox was removed and verified gone");
}

console.log(`\ncase_count=${passed + failed} passed=${passed} failed=${failed}`);
process.exitCode = failed === 0 ? 0 : 1;
