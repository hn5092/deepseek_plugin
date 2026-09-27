/**
 * The one owner of collaboration state.
 *
 * Every fact this bridge keeps — a question, a delivery, an error, and whether the controller has
 * confirmed being told — is ONE record with two INDEPENDENT axes:
 *
 *   notification: outstanding | confirmed    (has the controller dealt with being told?)
 *   business:     pending | answered | cancelled | expired | terminal   (is the work itself finished?)
 *
 * Confirming a notification must not finish the work, and finishing the work must not silence the
 * notification. An earlier revision kept those in three separate files and consequently confirmed the
 * notification by deleting the question, destroyed a pending question during reclamation, and could
 * leave half of an event on disk; all three were the same mistake — one event modelled as three
 * writable facts.
 *
 * This module therefore owns the record, its transitions, its sequence/generation identity and the
 * inbox projection, and the host half consumes it instead of re-deriving anything:
 *
 *  - `publish`     creates a record atomically, then projects and wakes. A record that could not be
 *                  persisted is never published, so nothing is announced that a restart could not find.
 *  - `answer` / `cancel` / `expire`  compare-and-set the BUSINESS axis from `pending`, so the first
 *                  terminal outcome wins and a late one is refused rather than overwriting it.
 *  - `confirm`     compare-and-set the NOTIFICATION axis only; a pending question stays answerable.
 *  - `reclaim`     removes only records that are confirmed AND terminal AND past both bounds; a
 *                  pending or unconfirmed record is never removed for capacity, however full the store.
 *  - `project`     the inbox is a projection of OUTSTANDING records: a missing file is written again, a
 *                  confirmed or reclaimed record is not delivered, and a file with no record is reported
 *                  as a ghost and never delivered.
 *
 * In-memory maps are caches of these records and are rebuilt from them. Waiter functions are pure
 * in-memory and are deliberately NOT recovered: a process that died cannot resume a tool call, so it
 * records the truth and lets a caller resume by identity.
 *
 * @module dsh-codex-bridge/state
 */
import { CollabStore, NOTIFICATION, NOTICE_STATE, QUESTION_STATE, isTerminalBusiness } from "./store.js";
import { confirmSignal, inboxDirFor, publishSignal, readSignals } from "./inbox.js";
import { normalizeSignal, signalVerdict } from "./signals.js";

/** Kinds a caller may publish. */
export const KINDS = Object.freeze(["question", "delivery", "error"]);

/**
 * The signal view of a record: what the HTTP surface and the controller see.
 *
 * Derived on read, never stored twice, so there is no second copy that can disagree with the record.
 *
 * @param {object} record - a stored record.
 * @returns {object} the signal view.
 */
export function signalView(record) {
    const source = record.sourceIdentity ?? {};
    return {
        id: record.id,
        controller: record.controller,
        bindingId: record.bindingId,
        sessionId: record.sessionId,
        cwd: record.cwd,
        kind: record.kind,
        seq: record.seq,
        generation: record.generation,
        reference: record.reference ?? `collab:${record.id}`,
        at: record.createdAt,
        ...(source.goalId === undefined ? {} : { goalId: source.goalId }),
        ...(source.requestId === undefined ? {} : { requestId: source.requestId })
    };
}

/** Whether a record should be delivered to a controller (notification not yet confirmed). */
export function isOutstanding(record) {
    return record !== null && typeof record === "object" && record.notification !== NOTIFICATION.CONFIRMED;
}

/**
 * The collaboration state owner.
 */
export class BridgeState {
    /**
     * @param {object} config - `{storeRoot, inboxRoot, logger}`.
     */
    constructor({ storeRoot, inboxRoot, logger }) {
        this.store = new CollabStore(storeRoot);
        this.inboxRoot = typeof inboxRoot === "string" && inboxRoot.length > 0 ? inboxRoot : null;
        this.logger = logger;
        /** Cache of every record, keyed by id. Rebuildable from the store. */
        this.records = new Map();
        /** Live waiters only: id -> settle. Never recovered. */
        this.waiters = new Map();
        /** Called after any state change, so the host can wake its waits. */
        this.onChange = null;
    }

    /**
     * Rebuild the cache from the durable records.
     *
     * Called before any producer or observer is exposed, because a producer that ran against an empty
     * cache would publish into it and could then overwrite a durable record it never read — a restart
     * where the model's tool call arrived before the controller's first read would lose a confirmation.
     * A store that cannot be read is reported so the caller can refuse to serve rather than continue with
     * empty state.
     *
     * @returns {{ok: boolean, loaded: number, problems: ReadonlyArray<object>, reason?: string}} the outcome.
     */
    load() {
        this.records.clear();
        if (!this.store.available) return { ok: false, loaded: 0, problems: [], reason: "store-not-configured" };
        const { records, problems } = this.store.allRecords();
        for (const record of records) this.records.set(record.id, record);
        // A meta file that cannot be read would reset the sequence, letting a new event reuse a number an
        // existing cursor had already passed, so it is treated as a load failure rather than defaulted.
        const meta = this.store.readMeta();
        if (!meta.ok) return { ok: false, loaded: records.length, problems, reason: meta.reason };
        if (problems.length > 0) {
            // An unreadable record is reported. It is NOT silently skipped: continuing could hide a
            // conflict, and the caller decides whether that is acceptable for this start.
            return { ok: false, loaded: records.length, problems, reason: `${problems.length} unreadable record(s)` };
        }
        return { ok: true, loaded: records.length, problems: [] };
    }

    /**
     * Create and persist one record, then project it and wake waiters.
     *
     * The order is the contract: persist first, because announcing an event a restart could not find is
     * how a controller ends up working from a fact that does not exist.
     *
     * @param {object} input - `{kind, bindingId, controller, sessionId, cwd, id?, sourceIdentity?, reference?, text?, at?}`.
     * @returns {{ok: true, record: object, duplicate: boolean, fileError?: string} | {ok: false, reason: string, expired?: boolean}} the outcome.
     */
    publish(input) {
        const kind = input.kind;
        if (!KINDS.includes(kind)) return { ok: false, reason: `kind must be one of ${KINDS.join(", ")}` };
        // Validate the routing identity before anything is written, using the shared rule: a record whose
        // session, directory, binding or controller is missing could not be routed to anyone, and a record
        // written with a hole in its identity is one a controller can never safely act on.
        const identityCheck = normalizeSignal({
            id: input.id ?? `pending-${this.records.size + 1}`,
            controller: input.controller,
            bindingId: input.bindingId,
            sessionId: input.sessionId,
            cwd: input.cwd,
            kind,
            ...(input.reference === undefined ? {} : { reference: input.reference }),
            at: input.at
        });
        if (!identityCheck.ok) return { ok: false, reason: `invalid-event-identity:${identityCheck.reason}` };
        const existing = input.id === undefined ? null : this.records.get(input.id) ?? null;
        if (existing !== null) {
            // The same identity is the same event — but ONLY if it really is the same event. The ids,
            // binding, session directory and kind are what say WHICH work a record belongs to, so a repeat
            // that disagrees on any of them is not a retry: it is a stale producer or a caller trying to
            // retarget an existing event. Accepting it would apply one task's event to another, which is
            // precisely what those fields exist to prevent. The comparison is the shared rule the peer
            // verifies independently, applied here at the one place a record is created.
            const identityOf = (source) => ({
                id: source.id,
                kind: source.kind,
                controller: source.controller,
                bindingId: source.bindingId,
                sessionId: source.sessionId,
                cwd: source.cwd,
                reference: source.reference ?? `collab:${source.id}`
            });
            const verdict = signalVerdict(identityOf(existing), identityOf({
                id: existing.id,
                kind: input.kind ?? existing.kind,
                controller: input.controller ?? existing.controller,
                bindingId: input.bindingId ?? existing.bindingId,
                sessionId: input.sessionId ?? existing.sessionId,
                cwd: input.cwd ?? existing.cwd,
                reference: input.reference ?? existing.reference
            }));
            if (verdict.action === "conflict") {
                return { ok: false, reason: `same-identity-different-content:${verdict.reason}` };
            }
            // Its projection is rewritten in case an earlier write failed, but nothing new is created and
            // no waiter is disturbed.
            const file = this.projectRecord(existing);
            return { ok: true, record: existing, duplicate: true, ...(file.ok ? {} : { fileError: file.reason }) };
        }
        // A caller-supplied identity that is NOT present may be a first delivery or a retry of one already
        // reclaimed. Bounded retention and unlimited deduplication cannot both hold, and the two cases
        // cannot be told apart from the string alone, so the rule is explicit and applies to every entry
        // point alike:
        //
        //   - retrying an id we still hold is accepted above, idempotently, using the issue time already
        //     recorded in the envelope — the caller does not, and must not, substitute "now";
        //   - naming an id we no longer hold requires the ORIGINAL issue time, and is then answered as
        //     expired rather than re-created;
        //   - with no issue time the request is refused. There is deliberately NO "treat as new" escape:
        //     such a flag would be a documented way to slip a retry past the expiry check, which is the
        //     exact thing the check exists to prevent.
        //
        // An ordinary NEW notification carries no caller-supplied id at all and lets the server allocate
        // one, so a caller never has to invent an internal identity — it only has to name one when it is
        // genuinely retrying.
        if (input.id !== undefined) {
            if (typeof input.issuedAt !== "string") {
                return { ok: false, reason: "event-id-without-issue-time", rejected: true };
            }
            const issued = Date.parse(input.issuedAt);
            if (!Number.isFinite(issued)) {
                return { ok: false, reason: "event-id-with-unparsable-issue-time", rejected: true };
            }
            if (Date.now() - issued > this.retention.maxAgeMs) {
                // Beyond the retention window the record is gone for good; the caller is told it expired
                // instead of being allowed to re-create it as fresh work.
                return { ok: false, reason: "event-expired", expired: true };
            }
        }
        const reservation = this.store.reserveSeq();
        if (!reservation.ok) return { ok: false, reason: `could not reserve a sequence: ${reservation.reason}` };
        const id = input.id ?? `${kind === "question" ? "collab" : "sig"}-${reservation.generation}-${reservation.seq}`;
        // A caller-supplied id that is already used under a different identity is a conflict, not a
        // silent overwrite; ids are server-generated except when a caller retries a known one.
        const record = {
            id,
            seq: reservation.seq,
            generation: reservation.generation,
            bindingId: input.bindingId,
            controller: input.controller,
            sessionId: input.sessionId,
            cwd: input.cwd,
            kind,
            sourceIdentity: input.sourceIdentity ?? {},
            reference: input.reference ?? `collab:${id}`,
            createdAt: input.at ?? new Date().toISOString(),
            notification: NOTIFICATION.OUTSTANDING,
            business: kind === "question" ? QUESTION_STATE.PENDING : NOTICE_STATE.TERMINAL,
            ...(input.text === undefined ? {} : { text: input.text })
        };
        const written = this.store.putRecord(record);
        if (!written.ok) return { ok: false, reason: `record-not-persisted:${written.reason}` };
        this.records.set(record.id, record);
        const file = this.projectRecord(record);
        if (this.onChange !== null) this.onChange();
        return { ok: true, record, duplicate: false, ...(file.ok ? {} : { fileError: file.reason }) };
    }

    /** @returns {object|null} one record from the cache. */
    get(id) {
        return this.records.get(id) ?? null;
    }

    /** Every record, from the cache. */
    all() {
        return [...this.records.values()];
    }

    /**
     * The signal views a controller is owed: outstanding, not confirmed, this controller's.
     *
     * @param {string} controller - the controller.
     * @returns {ReadonlyArray<object>} the deliverable views, oldest first.
     */
    outstanding(controller) {
        return this.all()
            .filter((record) => record.controller === controller && isOutstanding(record))
            .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))
            .map(signalView);
    }

    /**
     * Confirm one event's NOTIFICATION.
     *
     * Compare-and-set on that axis alone. A still-pending question keeps its `pending` business state, so
     * an acknowledgement of the notification never destroys an answerable question.
     *
     * @param {string} id - the record id.
     * @returns {{ok: true, record: object, changed: boolean} | {ok: false, reason: string}} the outcome.
     */
    confirm(id) {
        const current = this.get(id);
        if (current === null) return { ok: false, reason: "unknown-event" };
        const outcome = this.store.confirmNotification(id);
        if (!outcome.ok) return outcome;
        this.records.set(outcome.record.id, outcome.record);
        // The projection is removed as part of confirming, but a failure to remove it does not undo the
        // authoritative confirmation, and the projection is filtered by confirmation anyway.
        const removal = this.unproject(outcome.record);
        if (this.onChange !== null) this.onChange();
        return { ok: true, record: outcome.record, changed: outcome.changed, ...(removal.ok ? {} : { fileNote: removal.reason }) };
    }

    /**
     * Move a question to a terminal business state, settle its live waiter, then reclaim — in that order.
     *
     * This is THE terminal boundary, shared by every way a question can finish (an answer, a
     * cancellation, a timeout), so no caller has to remember to run retention itself: a question that was
     * confirmed first and only finished later is reclaimed here even though no further confirmation ever
     * arrives.
     *
     * The order is the contract:
     *   1. the compare-and-set persists the winning outcome and nothing later may undo it;
     *   2. the live waiter is settled with THAT confirmed result, so the tool call receives what was
     *      actually recorded rather than whatever the caller hoped to write;
     *   3. only then is retention run.
     *
     * The caller receives a SNAPSHOT taken from the winning record, so a reclaim that removes the record
     * afterwards cannot make the caller read back `unknown` for a transition it just performed.
     *
     * @param {string} id - the record id.
     * @param {object} outcome - `{business, answer?}`.
     * @param {object} [waiterValue] - what to resolve a live waiter with; omitted leaves it untouched.
     * @returns {{ok: true, record: object, changed: boolean, delivered: boolean} | {ok: false, reason: string}} the outcome.
     */
    settleBusiness(id, outcome, waiterValue) {
        const current = this.get(id);
        if (current === null) return { ok: false, reason: "unknown-question" };
        if (current.kind !== "question") return { ok: false, reason: "not-a-question" };
        if (isTerminalBusiness(current)) {
            // The first terminal outcome wins. A second is reported, never applied — and the caller still
            // gets the recorded truth rather than a failure.
            return { ok: true, record: current, changed: false, delivered: false };
        }
        const applied = this.store.setBusinessOutcome(id, outcome);
        if (!applied.ok) return applied;
        // Take the snapshot BEFORE retention runs: the transition happened, and the caller must be able to
        // report it even if the record is reclaimed in the very next statement.
        const winner = { ...applied.record };
        this.records.set(winner.id, winner);
        const delivered = waiterValue === undefined ? false : this.settleWaiter(id, waiterValue);
        if (this.onChange !== null) this.onChange();
        // Retention runs at this boundary too, so a confirmed-then-finished question is bounded without
        // waiting for a later confirmation that may never come.
        if (applied.changed) this.reclaim(this.retention);
        return { ok: true, record: winner, changed: applied.changed, delivered };
    }

    /** Register the live waiter for one question. @returns {() => void} a disposer. */
    registerWaiter(id, settle) {
        this.waiters.set(id, settle);
        return () => { if (this.waiters.get(id) === settle) this.waiters.delete(id); };
    }

    /**
     * Settle the live waiter for one question, if this process still has one.
     *
     * @returns {boolean} whether a live waiter was resumed. A record whose waiter died with a previous
     * process reports `false`, which lets the caller say so instead of implying a continuation.
     */
    settleWaiter(id, value) {
        const waiter = this.waiters.get(id);
        if (waiter === undefined) return false;
        this.waiters.delete(id);
        waiter(value);
        return true;
    }

    /** Remove a record's inbox projection. */
    unproject(record) {
        if (this.inboxRoot === null) return { ok: false, reason: "file-inbox-not-configured" };
        const dir = inboxDirFor(this.inboxRoot, record.controller);
        if (!dir.ok) return { ok: false, reason: dir.reason };
        return confirmSignal(dir.dir, record.id);
    }

    /** Write one outstanding record's inbox file, or remove it when it is no longer outstanding. */
    projectRecord(record) {
        if (this.inboxRoot === null) return { ok: false, reason: "file-inbox-not-configured" };
        if (!isOutstanding(record)) return this.unproject(record);
        const dir = inboxDirFor(this.inboxRoot, record.controller);
        if (!dir.ok) return { ok: false, reason: dir.reason };
        return publishSignal(dir.dir, signalView(record));
    }

    /**
     * Reconcile one controller's inbox with the authoritative records.
     *
     * Repair (a record whose file is missing gets it back), filter (a confirmed or reclaimed record is
     * not delivered even if its file lingers) and report (a file with no record is a ghost, surfaced but
     * never delivered) are one operation, so the three read surfaces cannot disagree with each other.
     *
     * @param {string} controller - the controller.
     * @returns {{outstanding: ReadonlyArray<object>, repaired: number, ghosts: ReadonlyArray<object>, confirmedFromFiles: number}} the reconciled view.
     */
    project(controller) {
        const outstanding = this.outstanding(controller);
        const outstandingIds = new Set(outstanding.map((signal) => signal.id));
        let repaired = 0;
        for (const signal of outstanding) {
            const record = this.get(signal.id);
            if (record === null) continue;
            const written = this.projectRecord(record);
            if (written.ok) repaired += 1;
        }
        const ghosts = [];
        let confirmedFromFiles = 0;
        if (this.inboxRoot !== null) {
            const dir = inboxDirFor(this.inboxRoot, controller);
            if (dir.ok) {
                const onDisk = readSignals(dir.dir).signals;
                for (const file of onDisk) {
                    if (outstandingIds.has(file.id)) continue;
                    const record = this.get(file.id);
                    if (record === null) ghosts.push(file);
                    else confirmedFromFiles += 1;
                }
            }
        }
        return { outstanding, repaired, ghosts, confirmedFromFiles };
    }

    /**
     * Reclaim finished records within bounds, then rebuild the cache from the store so a removed record
     * cannot come back from a stale map.
     *
     * @param {object} bounds - `{maxAgeMs, maxEvents}`.
     * @returns {{removed: ReadonlyArray<string>, failed: ReadonlyArray<object>, retained: number, pending: number, unconfirmed: number, reloaded: number}} the outcome.
     */
    reclaim(bounds) {
        this.retention = bounds;
        const outcome = this.store.reclaim(bounds);
        /** @type {ReadonlyArray<string>} */
        const removed = outcome.removed;
        // Rebuild rather than delete keys: the store is the truth, and a rebuild also drops anything the
        // cache held that the store no longer has.
        const reloaded = this.load();
        for (const id of removed) this.waiters.delete(id);
        if (removed.length > 0 && this.onChange !== null) this.onChange();
        return { ...outcome, reloaded: reloaded.loaded };
    }

    /** The retention bounds currently in force, used when judging an expired retry. */
    retention = { maxAgeMs: 7 * 24 * 60 * 60 * 1000, maxEvents: 500 };
}

export { CollabStore, NOTIFICATION, NOTICE_STATE, QUESTION_STATE, isTerminalBusiness };
