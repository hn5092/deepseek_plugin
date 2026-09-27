/**
 * Collaboration rules, as pure functions.
 *
 * Every rule the bridge enforces about WHO may answer WHICH question, and whether a given answer is
 * the first, a harmless retry, or a contradiction, lives here without IO. That keeps the security
 * relevant decisions (binding identity, cross-session rejection, late-answer rejection) provable in
 * isolation, and leaves the host half responsible only for transport and lifecycle.
 *
 * @module dsh-codex-bridge/collab
 */

/**
 * Answer provenance. A machine controller must never be recorded as the human.
 *
 * Only `codex` is accepted from the network: the controller's answer is always attributed to the
 * controller, and the server sets it rather than trusting a caller-supplied field. A human answer is
 * produced through the shell's own question and approval surfaces, which this bridge never intercepts —
 * so there is deliberately no caller-selectable "user" source here.
 */
export const ANSWER_SOURCES = Object.freeze(["codex"]);

/**
 * Resolve which controller a request actually is, from a credential the caller must possess.
 *
 * `connection.admit` proves only that a request speaks for the operator; it cannot distinguish one
 * controller from another, so a controller field sent in a body or query is a CLAIM and never an
 * identity. The declared bindings name the credential reference for each controller, and the caller is
 * whichever controller's secret matches. Nothing here compares or returns the secret itself beyond the
 * equality test, and a caller with no match is not identified at all.
 *
 * @param {string} offered - the secret the caller presented, or an empty string.
 * @param {ReadonlyArray<{controller: string, tokenRef?: string}>} bindings - declared bindings.
 * @param {(ref: string) => string|null} resolveSecret - resolves a reference to its value, or null.
 * @returns {{ok: true, controller: string} | {ok: false, reason: string}} the identified controller.
 */
export function identifyController(offered, bindings, resolveSecret) {
    if (typeof offered !== "string" || offered.length === 0) return { ok: false, reason: "no-controller-credential" };
    const candidates = [...new Set((bindings || []).map((entry) => entry.controller))]
        .filter((controller) => typeof controller === "string" && controller.length > 0);
    for (const controller of candidates) {
        const binding = (bindings || []).find((entry) => entry.controller === controller);
        const ref = binding === undefined ? undefined : binding.tokenRef;
        if (typeof ref !== "string" || ref.length === 0) continue;
        const secret = resolveSecret(ref);
        // Constant-time-ish comparison is not required here (the secret is not echoed and the caller
        // supplies it in full), but the value is never logged, returned or stored.
        if (typeof secret === "string" && secret.length > 0 && secret === offered) return { ok: true, controller };
    }
    return { ok: false, reason: "credential-does-not-match-a-controller" };
}

/**
 * Whether one session id is claimed by more than one binding.
 *
 * A session may have exactly ONE effective answer owner: two owners would make an answer ambiguous and
 * could produce two terminal outcomes for one tool call. A handover is expressed as a new binding whose
 * predecessor is explicitly marked non-current, so this reports only genuine multiplicity.
 *
 * @param {ReadonlyArray<{bindingId: string, sessionId: string, current?: boolean}>} bindings - declared bindings.
 * @returns {{ok: true} | {ok: false, reason: string, sessionId: string}} the verdict.
 */
export function assertSingleOwner(bindings) {
    const owners = new Map();
    for (const entry of bindings || []) {
        if (entry.current === false) continue;
        const existing = owners.get(entry.sessionId);
        if (existing !== undefined && existing !== entry.bindingId) {
            return { ok: false, reason: `session "${entry.sessionId}" has more than one answer owner ("${existing}" and "${entry.bindingId}")`, sessionId: entry.sessionId };
        }
        owners.set(entry.sessionId, entry.bindingId);
    }
    return { ok: true };
}

/**
 * Normalize one collaboration binding.
 *
 * A binding fixes the facts a controller needs to route an event correctly and to prove it is acting on
 * the right session: a stable `bindingId`, the DS session, the directory that session actually works
 * in, and the controlling party. Identity is never inferred from a title or from which window is open.
 *
 * One controller may own many bindings, and one controller may legitimately control sessions in
 * DIFFERENT directories, so a directory is never used to merge two sessions into one identity — the
 * (controller, sessionId) pair is what identifies a binding, and `cwd` is validated as that session's
 * own directory rather than as the controller's project.
 *
 * @param {{bindingId?: unknown, sessionId?: unknown, cwd?: unknown, controller?: unknown}} raw - candidate binding.
 * @returns {{ok: true, binding: {bindingId: string, sessionId: string, cwd: string, controller: string}} | {ok: false, reason: string}} the result.
 */
export function normalizeBinding(raw) {
    const sessionId = raw && typeof raw.sessionId === "string" ? raw.sessionId.trim() : "";
    const cwd = raw && typeof raw.cwd === "string" ? raw.cwd.trim() : "";
    const controller = raw && typeof raw.controller === "string" ? raw.controller.trim() : "";
    // A binding id is required so that an event can name the binding it belongs to even when two
    // sessions share a local question id, and so a handover can be expressed as a new binding.
    const bindingId = raw && typeof raw.bindingId === "string" && raw.bindingId.trim().length > 0
        ? raw.bindingId.trim()
        : `${controller}\u0000${sessionId}`;
    // The credential reference identifies the controller; it is a reference, never the secret.
    const tokenRef = raw && typeof raw.tokenRef === "string" ? raw.tokenRef.trim() : "";
    if (sessionId.length === 0) return { ok: false, reason: "binding requires a sessionId" };
    if (cwd.length === 0) return { ok: false, reason: "binding requires a cwd" };
    if (controller.length === 0) return { ok: false, reason: "binding requires a controller" };
    if (tokenRef.length === 0) return { ok: false, reason: "binding requires a tokenRef so the controller can be authenticated" };
    return {
        ok: true,
        binding: {
            bindingId,
            sessionId,
            cwd,
            controller,
            tokenRef,
            // A superseded binding stays declared (so its late answers are recognizably stale) but is no
            // longer a current owner.
            current: raw.current !== false
        }
    };
}

/**
 * Compare two filesystem paths for identity, without resolving symlinks.
 *
 * The bridge must accept the same directory spelled with either separator (the session header keeps
 * the caller's spelling while a workspace path is canonicalized), yet must NOT equate genuinely
 * different directories. Windows alone folds case and treats `\` as a separator; on POSIX a
 * backslash is an ordinary filename character, so applying Windows rules there would merge two
 * different paths.
 *
 * @param {string} left - one path.
 * @param {string} right - the other path.
 * @param {string} platform - Host platform; injectable for deterministic tests.
 * @returns {boolean} whether both denote the same location.
 */
export function sameDirectory(left, right, platform = process.platform) {
    if (typeof left !== "string" || typeof right !== "string") return false;
    if (left.length === 0 || right.length === 0) return false;
    const windows = platform === "win32";
    const reduce = (value) => {
        const parts = windows ? value.replace(/\\/g, "/").split("/") : value.split("/");
        const stack = [];
        for (const part of parts) {
            if (part === "" || part === ".") continue;
            if (part === "..") {
                // A `..` with nothing to pop is retained, so an over-root path cannot converge with a
                // normalized one.
                if (stack.length > 0 && stack[stack.length - 1] !== "..") stack.pop();
                else stack.push("..");
                continue;
            }
            stack.push(windows ? part.toLowerCase() : part);
        }
        return stack.join("/");
    };
    return reduce(left) === reduce(right);
}

/**
 * Whether a controller may answer one question.
 *
 * Rejects a session that is not the question's own, a directory that is not that session's, and a
 * controller that is not the binding's. A question whose session is unknown is refused rather than
 * accepted, so a missing binding can never widen access.
 *
 * Being the same CONTROLLER is not sufficient on its own: when a controller owns several bindings, a
 * question is answered only through the binding that owns it, because two bindings may share a local
 * question id and an answer must not cross between them.
 *
 * @param {{sessionId?: unknown, cwd?: unknown, controller?: unknown, bindingId?: unknown}} binding - the answering side's identity.
 * @param {ReadonlyArray<{bindingId: string, sessionId: string, cwd: string, controller: string}>} bindings - declared bindings.
 * @param {string} platform - Host platform for path comparison.
 * @returns {{allowed: true, binding: object} | {allowed: false, reason: string}} the verdict.
 */
export function matchBinding(binding, bindings, platform = process.platform) {
    const sessionId = binding && typeof binding.sessionId === "string" ? binding.sessionId : "";
    if (sessionId.length === 0) return { allowed: false, reason: "no-session-identity" };
    const declared = (bindings || []).filter((entry) => entry.sessionId === sessionId);
    if (declared.length === 0) return { allowed: false, reason: "session-not-bound" };
    const controller = binding && typeof binding.controller === "string" ? binding.controller : "";
    const cwd = binding && typeof binding.cwd === "string" ? binding.cwd : "";
    const bindingId = binding && typeof binding.bindingId === "string" ? binding.bindingId : "";
    for (const entry of declared) {
        // The offered binding id, when present, must name the binding that owns this session: a
        // handover makes the old binding's late answer invalid rather than ambiguous.
        if (bindingId.length > 0 && entry.bindingId !== bindingId) continue;
        // Controller and directory must BOTH match one declared binding; a correct session with the
        // wrong controller (or a controller pointing at another directory) is not this binding.
        if (controller.length > 0 && entry.controller !== controller) continue;
        if (cwd.length > 0 && !sameDirectory(entry.cwd, cwd, platform)) continue;
        return { allowed: true, binding: entry };
    }
    if (controller.length > 0 && !declared.some((entry) => entry.controller === controller)) {
        return { allowed: false, reason: "controller-not-bound" };
    }
    if (bindingId.length > 0 && !declared.some((entry) => entry.bindingId === bindingId)) {
        return { allowed: false, reason: "binding-not-current" };
    }
    return { allowed: false, reason: "cwd-not-bound" };
}

/**
 * Whether a controller owns any binding at all.
 *
 * Used by the aggregate wait, so a controller that owns several bindings is never refused merely
 * because it did not name one session, while a controller that owns nothing is still refused.
 *
 * @param {ReadonlyArray<{controller: string}>} bindings - declared bindings.
 * @param {string} controller - the asking controller.
 * @returns {boolean} whether it is a known controller.
 */
export function isKnownController(bindings, controller) {
    if (typeof controller !== "string" || controller.length === 0) return false;
    return (bindings || []).some((entry) => entry.controller === controller);
}

/**
 * The bindings one controller owns.
 *
 * A controller sees exactly its own bindings; there is no global view and no "see everything" role, so
 * independent controllers cannot observe each other's sessions.
 *
 * @param {ReadonlyArray<{controller: string}>} bindings - declared bindings.
 * @param {string} controller - the asking controller.
 * @returns {ReadonlyArray<object>} that controller's bindings.
 */
export function bindingsOf(bindings, controller) {
    return (bindings || []).filter((entry) => entry.controller === controller);
}

/**
 * The state of one question, derived from its recorded events.
 *
 * The session log is the record; this folds it into the state a caller reads. Answers are matched by
 * CONTENT so a retry is recognizable: the same answer twice is the same outcome, a different answer
 * for an answered question is a contradiction.
 *
 * @param {ReadonlyArray<{type: string, data: object}>} events - that question's events, in order.
 * @returns {{status: string, answer?: object, reason?: string}} the folded state.
 */
export function questionStateOf(events) {
    let asked = false;
    let answer = null;
    let cancelled = null;
    for (const event of events || []) {
        if (event.type === "collab/question") asked = true;
        else if (event.type === "collab/answer") { if (answer === null) answer = event.data; }
        else if (event.type === "collab/cancel") { if (cancelled === null) cancelled = event.data; }
    }
    if (!asked) return { status: "unknown" };
    if (answer !== null) return { status: "answered", answer };
    if (cancelled !== null) return { status: "cancelled", reason: cancelled.reason };
    return { status: "pending" };
}

/**
 * Decide what an incoming answer should do.
 *
 * The four outcomes the contract requires, in the order they must be checked:
 *  - a cancelled question refuses a late answer (the tool is gone; the answer must not revive it);
 *  - an already-answered question accepts the SAME content as an idempotent retry and refuses
 *    differing content as a conflict;
 *  - a pending question accepts;
 *  - anything else is refused.
 *
 * @param {{status: string, answer?: object}} state - the question's folded state.
 * @param {{source?: string, text?: string}} candidate - the incoming answer.
 * @returns {{action: "accept"|"idempotent"|"conflict"|"reject", reason: string}} the decision.
 */
export function answerVerdict(state, candidate) {
    const source = candidate && typeof candidate.source === "string" ? candidate.source : "";
    const text = candidate && typeof candidate.text === "string" ? candidate.text : "";
    if (!ANSWER_SOURCES.includes(source)) return { action: "reject", reason: "unknown-answer-source" };
    if (text.trim().length === 0) return { action: "reject", reason: "empty-answer" };
    const status = state && typeof state.status === "string" ? state.status : "unknown";
    if (status === "cancelled") return { action: "reject", reason: "question-cancelled" };
    if (status === "answered") {
        const prior = state.answer || {};
        if (prior.text === text && prior.source === source) return { action: "idempotent", reason: "same-answer-retry" };
        return { action: "conflict", reason: "different-answer-for-answered-question" };
    }
    if (status === "pending") return { action: "accept", reason: "pending" };
    return { action: "reject", reason: `question-${status}` };
}

/**
 * Select the questions a controller should process now.
 *
 * Ordering is oldest-first so nothing is starved, and already-answered or cancelled questions are
 * excluded because they are no longer work. A `since` cursor returns everything the caller could have
 * missed, which is what makes a reconnect lossless without replaying delivery.
 *
 * @param {ReadonlyArray<{id: string, seq?: number, state?: {status: string}}>} questions - known questions.
 * @param {number} [since] - only questions with a sequence greater than this.
 * @returns {ReadonlyArray<object>} the pending questions to deliver.
 */
export function pendingQuestions(questions, since) {
    const floor = Number.isFinite(since) ? since : -1;
    return (questions || [])
        .filter((entry) => entry && entry.state && entry.state.status === "pending")
        .filter((entry) => !Number.isFinite(entry.seq) || entry.seq > floor)
        .slice()
        .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
}
