/**
 * Signal rules, as pure functions.
 *
 * A "signal" is one thing a bound controller must be told about: a question waiting for an answer, a
 * completed delivery, or an abnormal stop. These helpers decide what a signal IS, whether it is still
 * the same delivery on a repeat, and what a waiting controller should be handed — without touching the
 * filesystem, the clock, or any session.
 *
 * Keeping this separate matters for two reasons. The rules must hold identically for the in-memory
 * event path and the file projection, so neither can drift into being the "real" one; and the
 * idempotency and cross-binding rules are the ones a repeat or a mis-routed file could otherwise break.
 *
 * @module dsh-codex-bridge/signals
 */

/** The event kinds a controller may be signalled about. */
export const SIGNAL_KINDS = Object.freeze(["question", "delivery", "error"]);

/**
 * Validate and normalize one signal.
 *
 * Every signal carries the identity needed to route it and to prove it belongs to the binding it names:
 * an id, the binding/controller, the DS session, that session's ACTUAL cwd, an optional Goal/request
 * identity, the kind, and a reference to the result. The body of a technical question or the evidence
 * for a delivery is NOT copied in here — it stays in the session or the plugin's own events, so this is
 * a notification rather than a second writable truth.
 *
 * @param {object} raw - candidate signal.
 * @returns {{ok: true, signal: object} | {ok: false, reason: string}} the result.
 */
export function normalizeSignal(raw) {
    const id = typeof raw?.id === "string" ? raw.id.trim() : "";
    const controller = typeof raw?.controller === "string" ? raw.controller.trim() : "";
    const sessionId = typeof raw?.sessionId === "string" ? raw.sessionId.trim() : "";
    const cwd = typeof raw?.cwd === "string" ? raw.cwd.trim() : "";
    const kind = typeof raw?.kind === "string" ? raw.kind : "";
    // The binding id is what keeps two sessions apart when they share a local question id, so an event
    // is always attributable to one binding rather than to "the controller's work".
    const bindingId = typeof raw?.bindingId === "string" ? raw.bindingId.trim() : "";
    if (id.length === 0) return { ok: false, reason: "signal requires an id" };
    if (controller.length === 0) return { ok: false, reason: "signal requires a controller" };
    if (bindingId.length === 0) return { ok: false, reason: "signal requires a bindingId" };
    if (sessionId.length === 0) return { ok: false, reason: "signal requires a sessionId" };
    if (cwd.length === 0) return { ok: false, reason: "signal requires the session cwd" };
    if (!SIGNAL_KINDS.includes(kind)) return { ok: false, reason: `kind must be one of ${SIGNAL_KINDS.join(", ")}` };
    return {
        ok: true,
        signal: {
            id,
            controller,
            bindingId,
            sessionId,
            cwd,
            kind,
            ...(typeof raw.goalId === "string" && raw.goalId.length > 0 ? { goalId: raw.goalId } : {}),
            ...(typeof raw.requestId === "string" && raw.requestId.length > 0 ? { requestId: raw.requestId } : {}),
            // A reference to where the truth lives, never the truth itself.
            ...(typeof raw.reference === "string" && raw.reference.length > 0 ? { reference: raw.reference } : {}),
            at: typeof raw.at === "string" && raw.at.length > 0 ? raw.at : new Date(0).toISOString()
        }
    };
}

/**
 * Whether two signals are the same delivery.
 *
 * Identity is the signal id alone: the same id seen twice — after a reconnect, or because two file
 * notifications pointed at one file — is ONE event, and must not be delivered twice. Different content
 * under the same id is a conflict the caller must resolve rather than a silent overwrite, because
 * accepting it would let a stale file retarget a task that already moved on.
 *
 * @param {object} known - the signal already recorded.
 * @param {object} candidate - the signal being offered.
 * @returns {{action: "same"|"conflict"|"new", reason: string}} the verdict.
 */
export function signalVerdict(known, candidate) {
    if (known === null || known === undefined) return { action: "new", reason: "unseen" };
    if (known.id !== candidate.id) return { action: "new", reason: "different-id" };
    if (known.kind !== candidate.kind || known.sessionId !== candidate.sessionId || known.controller !== candidate.controller) {
        return { action: "conflict", reason: "same-id-different-content" };
    }
    return { action: "same", reason: "same-id-and-content" };
}

/**
 * Whether a signal is worth waking a controller for.
 *
 * A question and an abnormal stop always are. A delivery is only worth waking for when the caller has
 * said the business result is complete — a plain finished turn is NOT a completed delivery, and
 * treating it as one is exactly how "the turn ended" gets mistaken for "the work is done".
 *
 * @param {object} signal - a normalized signal.
 * @param {boolean} deliveryComplete - whether the caller declared the delivery complete.
 * @returns {boolean} whether the signal should interrupt a wait.
 */
export function signalIsWakeworthy(signal, deliveryComplete) {
    if (signal.kind === "question" || signal.kind === "error") return true;
    if (signal.kind === "delivery") return deliveryComplete === true;
    return false;
}

/**
 * Select the signals a controller should receive now.
 *
 * Unacknowledged signals for that controller are returned oldest-first. Selection is by CONTROLLER, so
 * one controller can never be handed another binding's events, and acknowledged signals are excluded
 * because confirmation is a separate act from delivery.
 *
 * @param {ReadonlyArray<object>} signals - known signals.
 * @param {string} controller - the asking controller.
 * @param {ReadonlyArray<string>} [acknowledged] - already-confirmed signal ids.
 * @returns {ReadonlyArray<object>} the signals to deliver.
 */
export function deliverableSignals(signals, controller, acknowledged = []) {
    const confirmed = new Set(acknowledged);
    return (signals || [])
        .filter((entry) => entry && entry.controller === controller)
        .filter((entry) => !confirmed.has(entry.id))
        .slice()
        .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
}

/**
 * Whether a controller's wait should return, and with what.
 *
 * Backlog wins immediately — a controller that was away must not wait 20 minutes for events that are
 * already there. Otherwise the wait ends on the first wakeworthy signal for that controller, or on the
 * deadline with an explicit "nothing new" result that is NOT an answer, an approval, or a failure.
 *
 * @param {object} input - the wait input.
 * @param {ReadonlyArray<object>} input.signals - known signals for this controller.
 * @param {ReadonlyArray<string>} [input.acknowledged] - confirmed ids.
 * @param {number} [input.since] - highest sequence already seen.
 * @param {boolean} [input.deliveryCompleteFor] - whether deliveries count as complete.
 * @returns {{status: "signals", signals: Array<object>} | {status: "empty"}} the outcome.
 */
export function waitOutcome(input) {
    const deliverable = deliverableSignals(input.signals, input.controller, input.acknowledged ?? []);
    const unseen = Number.isFinite(input.since) ? deliverable.filter((entry) => (entry.seq ?? 0) > input.since) : deliverable;
    if (unseen.length === 0) return { status: "empty" };
    // A batch is bounded so one wait cannot return an unbounded backlog; the caller resumes from the
    // returned cursor, so no event is dropped merely because a batch was capped. Crucially the cap is
    // applied AFTER sorting oldest-first, so the oldest undelivered events are the ones returned — a
    // single global sequence number can never be advanced past events that were never delivered.
    const batch = unseen.slice(0, Number.isFinite(input.maxBatch) ? input.maxBatch : 50);
    return { status: "signals", signals: batch, cursor: batch[batch.length - 1].seq ?? null, more: unseen.length > batch.length };
}
