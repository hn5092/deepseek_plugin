/**
 * Focused behaviour tests for the collaboration rules.
 *
 * These are the security- and correctness-relevant decisions of the bridge, so they are proven at the
 * cheapest boundary: pure functions, no instance, no model. Every case states a real distinction the
 * contract requires, including the ones that must be REFUSED.
 *
 * Run: node scripts/collab-rules.test.mjs
 */
import assert from "node:assert/strict";
import {
    ANSWER_SOURCES,
    answerVerdict,
    assertSingleOwner,
    identifyController,
    matchBinding,
    normalizeBinding,
    pendingQuestions,
    questionStateOf,
    sameDirectory
} from "../lib/collab.js";

let passed = 0;
const cases = [];
/** @param {string} title - what the case proves. @param {() => void} body - the assertions. */
function test(title, body) {
    cases.push({ title, body });
}

const WIN = "win32";
const POSIX = "linux";

// ---- binding identity: no guessing from titles or windows --------------------------------
test("a binding requires a session, directory, controller and credential reference", () => {
    assert.equal(normalizeBinding({ sessionId: "s", cwd: "D:/a", controller: "codex", tokenRef: "TOKEN" }).ok, true);
    assert.equal(normalizeBinding({ sessionId: "s", cwd: "D:/a", controller: "codex" }).ok, false, "a controller must be authenticatable");
    assert.equal(normalizeBinding({ sessionId: "s", cwd: "D:/a", tokenRef: "TOKEN" }).ok, false, "controller is mandatory");
    assert.equal(normalizeBinding({ sessionId: "s", controller: "codex", tokenRef: "TOKEN" }).ok, false, "cwd is mandatory");
    assert.equal(normalizeBinding({ cwd: "D:/a", controller: "codex", tokenRef: "TOKEN" }).ok, false, "session is mandatory");
});

test("only the bound session may answer", () => {
    const bindings = [{ sessionId: "s1", cwd: "D:/proj", controller: "codex" }];
    assert.equal(matchBinding({ sessionId: "s1", cwd: "D:/proj", controller: "codex" }, bindings, WIN).allowed, true);
    const other = matchBinding({ sessionId: "s2", cwd: "D:/proj", controller: "codex" }, bindings, WIN);
    assert.equal(other.allowed, false);
    assert.equal(other.reason, "session-not-bound");
});

test("the same session under a different controller is refused (cross-project rule)", () => {
    const bindings = [
        { sessionId: "s1", cwd: "D:/proj", controller: "codex" },
        { sessionId: "s2", cwd: "D:/other", controller: "codex-2" }
    ];
    const wrong = matchBinding({ sessionId: "s2", cwd: "D:/other", controller: "codex" }, bindings, WIN);
    assert.equal(wrong.allowed, false, "controller must not read another project's events");
    assert.equal(wrong.reason, "controller-not-bound");
});

test("a session answered for the wrong directory is refused", () => {
    const bindings = [{ sessionId: "s1", cwd: "D:/proj", controller: "codex" }];
    const wrong = matchBinding({ sessionId: "s1", cwd: "D:/elsewhere", controller: "codex" }, bindings, WIN);
    assert.equal(wrong.allowed, false);
    assert.equal(wrong.reason, "cwd-not-bound");
});

test("an undeclared session is never allowed by omission", () => {
    assert.equal(matchBinding({ sessionId: "ghost", cwd: "D:/p", controller: "codex" }, [], WIN).allowed, false);
    assert.equal(matchBinding({}, [{ sessionId: "s1", cwd: "D:/p", controller: "c" }], WIN).allowed, false);
});

test("a bound directory matches in either separator spelling", () => {
    const bindings = [{ sessionId: "s1", cwd: "D:\\proj\\sub", controller: "codex" }];
    assert.equal(matchBinding({ sessionId: "s1", cwd: "D:/proj/sub", controller: "codex" }, bindings, WIN).allowed, true);
});

test("directory identity does not fold case on POSIX, nor split backslashes", () => {
    assert.equal(sameDirectory("/a/CT", "/a/ct", POSIX), false, "case-sensitive names stay distinct");
    assert.equal(sameDirectory("/a\\b", "/a/b", POSIX), false, "a backslash is an ordinary character");
    assert.equal(sameDirectory("D:/A/B", "D:\\a\\b", WIN), true);
    assert.equal(sameDirectory("D:/a/b", "D:/a/c", WIN), false);
});

// ---- question state: the log is the record -----------------------------------------------
test("state folds ask, answer and cancel", () => {
    assert.equal(questionStateOf([]).status, "unknown");
    assert.equal(questionStateOf([{ type: "collab/question", data: {} }]).status, "pending");
    const answered = questionStateOf([
        { type: "collab/question", data: {} },
        { type: "collab/answer", data: { text: "use X", source: "codex" } }
    ]);
    assert.equal(answered.status, "answered");
    assert.equal(answered.answer.text, "use X");
    const cancelled = questionStateOf([
        { type: "collab/question", data: {} },
        { type: "collab/cancel", data: { reason: "session-cancelled" } }
    ]);
    assert.equal(cancelled.status, "cancelled");
});

test("the first answer wins; later events do not overwrite it", () => {
    const state = questionStateOf([
        { type: "collab/question", data: {} },
        { type: "collab/answer", data: { text: "first", source: "codex" } },
        { type: "collab/answer", data: { text: "second", source: "codex" } }
    ]);
    assert.equal(state.answer.text, "first");
});

// ---- answer verdict: the four required outcomes ------------------------------------------
test("a pending question accepts an answer", () => {
    assert.equal(answerVerdict({ status: "pending" }, { text: "use X", source: "codex" }).action, "accept");
});

test("the same answer twice is idempotent, not a second delivery", () => {
    const state = { status: "answered", answer: { text: "use X", source: "codex" } };
    assert.equal(answerVerdict(state, { text: "use X", source: "codex" }).action, "idempotent");
});

test("a different answer for an answered question is a conflict", () => {
    const state = { status: "answered", answer: { text: "use X", source: "codex" } };
    const verdict = answerVerdict(state, { text: "use Y", source: "codex" });
    assert.equal(verdict.action, "conflict");
});

test("a late answer to a cancelled question is refused", () => {
    const verdict = answerVerdict({ status: "cancelled", reason: "session-cancelled" }, { text: "too late", source: "codex" });
    assert.equal(verdict.action, "reject");
    assert.equal(verdict.reason, "question-cancelled");
});

test("a machine answer cannot masquerade as the human", () => {
    // The bridge only ever produces controller answers, so `user` is NOT an accepted network source:
    // a caller claiming it would be recording machine output as human consent on the transcript.
    assert.equal(answerVerdict({ status: "pending" }, { text: "x", source: "user" }).action, "reject", "the human source is not caller-selectable");
    assert.equal(answerVerdict({ status: "pending" }, { text: "x", source: "codex" }).action, "accept");
    assert.equal(answerVerdict({ status: "pending" }, { text: "x", source: "system" }).action, "reject");
    assert.equal(answerVerdict({ status: "pending" }, { text: "x" }).action, "reject", "source is mandatory");
});

test("an empty answer is refused", () => {
    assert.equal(answerVerdict({ status: "pending" }, { text: "   ", source: "codex" }).action, "reject");
});

test("an answer to an unknown question is refused, not accepted", () => {
    assert.equal(answerVerdict({ status: "unknown" }, { text: "x", source: "codex" }).action, "reject");
});

// ---- delivery: backlog first, lossless reconnect -----------------------------------------
test("pending questions are returned oldest first", () => {
    const questions = [
        { id: "b", seq: 5, state: { status: "pending" } },
        { id: "a", seq: 2, state: { status: "pending" } }
    ];
    assert.deepEqual(pendingQuestions(questions).map((q) => q.id), ["a", "b"]);
});

test("answered and cancelled questions are not delivered as work", () => {
    const questions = [
        { id: "a", seq: 1, state: { status: "pending" } },
        { id: "b", seq: 2, state: { status: "answered" } },
        { id: "c", seq: 3, state: { status: "cancelled" } }
    ];
    assert.deepEqual(pendingQuestions(questions).map((q) => q.id), ["a"]);
});

test("a reconnect after a cursor returns everything not yet seen, without duplicates", () => {
    const questions = [
        { id: "a", seq: 1, state: { status: "pending" } },
        { id: "b", seq: 2, state: { status: "pending" } },
        { id: "c", seq: 3, state: { status: "pending" } }
    ];
    assert.deepEqual(pendingQuestions(questions, 1).map((q) => q.id), ["b", "c"]);
    assert.deepEqual(pendingQuestions(questions, 3).map((q) => q.id), []);
});

// ---- controller identity comes from a credential, never from a self-claim ----------------
test("a controller is identified by its credential, not by the name it sends", () => {
    const bindings = [
        { bindingId: "a", sessionId: "s1", cwd: "D:/a", controller: "codex", tokenRef: "TOKEN_A" },
        { bindingId: "b", sessionId: "s2", cwd: "D:/b", controller: "codex-2", tokenRef: "TOKEN_B" }
    ];
    const secrets = { TOKEN_A: "secret-a", TOKEN_B: "secret-b" };
    const resolve = (ref) => secrets[ref] ?? null;
    assert.deepEqual(identifyController("secret-a", bindings, resolve), { ok: true, controller: "codex" });
    assert.deepEqual(identifyController("secret-b", bindings, resolve), { ok: true, controller: "codex-2" });
});

test("a caller without a matching credential is not identified at all", () => {
    const bindings = [{ bindingId: "a", sessionId: "s1", cwd: "D:/a", controller: "codex", tokenRef: "TOKEN_A" }];
    const resolve = () => "secret-a";
    assert.equal(identifyController("", bindings, resolve).ok, false, "no credential is refused");
    assert.equal(identifyController("wrong", bindings, resolve).ok, false, "a wrong credential is refused");
    // A controller naming a controller with no declared credential cannot be trusted either.
    assert.equal(identifyController("secret-a", [{ bindingId: "a", sessionId: "s1", cwd: "D:/a", controller: "codex" }], resolve).ok, false);
    // An unresolvable reference never authenticates.
    assert.equal(identifyController("secret-a", bindings, () => null).ok, false);
});

test("the AI answer source is codex only, and the human source is not caller-selectable", () => {
    assert.deepEqual([...ANSWER_SOURCES], ["codex"]);
    assert.equal(answerVerdict({ status: "pending" }, { text: "x", source: "codex" }).action, "accept");
    assert.equal(answerVerdict({ status: "pending" }, { text: "x", source: "user" }).action, "reject", "a machine must not claim the human source");
});

// ---- one session has exactly one answer owner --------------------------------------------
test("one session with two answer owners is refused", () => {
    const verdict = assertSingleOwner([
        { bindingId: "old", sessionId: "s1" },
        { bindingId: "new", sessionId: "s1" }
    ]);
    assert.equal(verdict.ok, false);
    assert.equal(verdict.sessionId, "s1");
});

test("a handover is expressed by marking the predecessor non-current", () => {
    assert.equal(assertSingleOwner([
        { bindingId: "old", sessionId: "s1", current: false },
        { bindingId: "new", sessionId: "s1" }
    ]).ok, true);
    // Several sessions each with one owner is the multi-open case and stays valid.
    assert.equal(assertSingleOwner([
        { bindingId: "a", sessionId: "s1" },
        { bindingId: "b", sessionId: "s2" },
        { bindingId: "c", sessionId: "s3" }
    ]).ok, true);
});

test("dropping an ambiguous session leaves it with no owner, never with two", () => {
    // The startup rule: an ambiguous session's bindings are all removed, so the session goes from two
    // possible owners to ZERO — the fail-closed direction. It must not silently keep one of them.
    const declared = [
        { bindingId: "a1", sessionId: "amb", current: true },
        { bindingId: "a2", sessionId: "amb", current: true },
        { bindingId: "ok", sessionId: "fine", current: true }
    ];
    const verdict = assertSingleOwner(declared);
    assert.equal(verdict.ok, false);
    const remaining = declared.filter((entry) => entry.sessionId !== verdict.sessionId);
    assert.deepEqual(remaining.map((entry) => entry.bindingId), ["ok"]);
    assert.equal(remaining.some((entry) => entry.sessionId === "amb"), false, "the ambiguous session has no answer owner at all");
});

// ---- runner -----------------------------------------------------------------------------
let failed = 0;
for (const { title, body } of cases) {
    try {
        body();
        passed += 1;
        console.log(`PASS  ${title}`);
    } catch (error) {
        failed += 1;
        console.log(`FAIL  ${title}`);
        console.log(`      ${error && error.message}`);
    }
}
console.log(`\ncase_count=${cases.length} passed=${passed} failed=${failed}`);
process.exitCode = failed === 0 ? 0 : 1;
