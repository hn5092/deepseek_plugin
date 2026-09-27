/**
 * The bridge's own durable state: ONE atomic record per event.
 *
 * Why not the Session log. This harness refuses to READ a session log containing an event type outside
 * its generated known set unless the envelope carries `ignorable: true`, and `Session.append` accepts
 * only `sourceEventSeqs` and `surfaceOp` — there is no way for an out-of-repo writer to set that marker.
 * Writing a custom event therefore made the session permanently uninterpretable, reproduced on a real
 * stop/restart. This store is where the plugin's own records live instead.
 *
 * Why ONE record and not three files. An earlier revision kept signals, questions and confirmations in
 * three separate directories. That made the same event three independent writable facts, and every
 * combination of them had to be reasoned about separately:
 *
 *  - confirming the NOTIFICATION deleted the QUESTION file, so a still-pending question could be
 *    destroyed by an act that says nothing about whether the question was answered;
 *  - reclaim removed the three files one after another, so a failure in the middle left a partial,
 *    permanently orphaned record;
 *  - memory and disk could disagree, so a deleted record could be written back from a stale cache.
 *
 * One record removes the class of problem rather than each instance of it: a single file is written by
 * `temp + rename`, so it is complete or absent, and there is no partial state to reconcile. The two axes
 * that were being conflated are now explicit and independent fields:
 *
 *  - `notification`: outstanding | confirmed — whether the CONTROLLER has dealt with being told;
 *  - `business`: for a question pending | answered | cancelled | expired; for a notice, terminal.
 *
 * Confirming a notification leaves a pending question answerable, which is the whole point.
 *
 * Records are addressed only by identities this store or the server issued (id/seq/generation), so a
 * lookup is a pure function of the id and two ids can never share a file.
 *
 * @module dsh-codex-bridge/store
 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

/** Only these characters may appear in a path segment, so no id can escape the store root. */
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

/** The notification axis: whether the controller has confirmed being told. */
export const NOTIFICATION = Object.freeze({ OUTSTANDING: "outstanding", CONFIRMED: "confirmed" });

/** The business axis for a question. */
export const QUESTION_STATE = Object.freeze({ PENDING: "pending", ANSWERED: "answered", CANCELLED: "cancelled", EXPIRED: "expired" });

/** The business axis for a notice. A notice has no follow-up state. */
export const NOTICE_STATE = Object.freeze({ TERMINAL: "terminal" });

/** Whether a business state is final for its kind. */
export function isTerminalBusiness(record) {
    if (record === null || typeof record !== "object") return false;
    if (record.kind === "question") return [QUESTION_STATE.ANSWERED, QUESTION_STATE.CANCELLED, QUESTION_STATE.EXPIRED].includes(record.business);
    return record.business === NOTICE_STATE.TERMINAL;
}

/**
 * Turn a record id into a filename-safe name.
 *
 * Ids legitimately contain characters that are legal inside a path segment but NOT inside a filename on
 * Windows: a binding id such as `codex::a` contains `:`, which the filesystem reads as an
 * alternate-data-stream separator, so naming a file after it fails with a misleading `ENOENT`. The
 * mapping is deterministic and INJECTIVE — `_` becomes `__`, and every other unsafe character becomes
 * `_` plus its 4-digit hex code point — so two different ids can never share a file.
 *
 * @param {string} id - the record id.
 * @returns {string} a name that is legal on every supported platform.
 */
export function safeFileName(id) {
    let out = "";
    for (const char of String(id)) {
        if (/[A-Za-z0-9.-]/.test(char)) out += char;
        else if (char === "_") out += "__";
        else out += `_${char.codePointAt(0).toString(16).padStart(4, "0")}`;
    }
    return out.length === 0 || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(out) ? `_${out}` : out;
}

/** Resolve a path beneath the root, refusing anything that could escape it. */
function resolveInside(root, ...segments) {
    if (typeof root !== "string" || root.length === 0) return { ok: false, reason: "no-store-root" };
    for (const segment of segments) {
        if (typeof segment !== "string" || !SAFE_SEGMENT.test(segment)) {
            return { ok: false, reason: `unsafe store segment ${JSON.stringify(segment)}` };
        }
    }
    const file = path.join(root, ...segments);
    const relative = path.relative(root, file);
    if (relative.startsWith("..") || path.isAbsolute(relative)) return { ok: false, reason: "store path escapes its root" };
    return { ok: true, file };
}

/** Write one JSON file atomically: a temp name in the same directory, then rename. */
function writeJsonAtomic(file, value) {
    const text = JSON.stringify(value);
    const temp = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(temp, text, { encoding: "utf8", flag: "wx" });
        fs.renameSync(temp, file);
        return { ok: true };
    } catch (error) {
        try { fs.rmSync(temp, { force: true }); } catch { /* best effort */ }
        return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
}

/**
 * Read one JSON file.
 *
 * The failure carries its `code` alongside the message so callers can classify it structurally. Matching
 * a message for a token like `ENOENT` is not safe: the text also contains the FILE PATH, so a path
 * containing that literal would be misread, and the message wording is not a contract.
 *
 * @param {string} file - the file to read.
 * @returns {{ok: true, value: unknown} | {ok: false, reason: string, code: string, missing: boolean}} the outcome.
 */
function readJson(file) {
    try {
        return { ok: true, value: JSON.parse(fs.readFileSync(file, "utf8")) };
    } catch (error) {
        const code = error !== null && typeof error === "object" && typeof error.code === "string" ? error.code : "";
        return {
            ok: false,
            reason: error instanceof Error ? error.message : String(error),
            code,
            // Only a genuine absence counts as "not here". A syntax error or an IO failure is corruption,
            // which is a different fact and must not be reported as a missing record.
            missing: code === "ENOENT"
        };
    }
}

/**
 * The bridge's durable event store: one record per event, plus a monotonic controller meta.
 *
 * `ControllerMeta` holds `nextSeq` and `generation`. A sequence is RESERVED before an event is written,
 * so a crash leaves a gap in the sequence rather than two events sharing one, and reclaiming records
 * can never lower the high-water mark — which is what keeps a caller's cursor meaningful across
 * reclamation and restart.
 *
 * `generation` is a PERSISTENT NAMESPACE for server-issued ids, not a handover mechanism: it lets an id
 * state which issuing epoch it came from, and handover is actually enforced by `bindingId` plus the
 * `current` flag in `matchBinding` (a superseded binding is never selected, and one session has exactly
 * one answer owner). Nothing increments it today, and no method is offered to, because inventing a
 * caller for it would be adding a concept rather than serving one.
 */
export class CollabStore {
    /**
     * @param {string} root - store root, from configuration.
     */
    constructor(root) {
        this.root = typeof root === "string" ? root : "";
        this.available = this.root.length > 0;
    }

    /** @returns {{ok: true, file: string} | {ok: false, reason: string}} the events directory. */
    eventsDir() {
        return resolveInside(this.root, "events");
    }

    /** @returns {{ok: true, file: string} | {ok: false, reason: string}} the meta file. */
    metaFile() {
        return resolveInside(this.root, "controller-meta.json");
    }

    /**
     * Read the controller meta.
     *
     * `existsSync` is deliberately NOT used: it answers only "is there something here", and returns false
     * for a file that exists but cannot be read, which would be indistinguishable from a fresh store and
     * would silently restart the sequence at 1. The file is read directly instead, and the error is
     * classified:
     *
     *  - a genuinely absent meta is a fresh store ONLY when there are no records either. A missing meta
     *    beside existing records means the sequence history was lost, and restarting at 1 would hand out
     *    numbers an existing cursor has already passed, so it is reported as a problem;
     *  - an unreadable or malformed meta is reported, never defaulted.
     *
     * @param {{recordsPresent?: boolean}} [context] - whether records already exist in the store.
     * @returns {{ok: true, meta: object} | {ok: false, reason: string}} the meta.
     */
    readMeta(context = {}) {
        if (!this.available) return { ok: false, reason: "store-not-configured" };
        const target = this.metaFile();
        if (!target.ok) return target;
        let raw;
        try {
            raw = fs.readFileSync(target.file, "utf8");
        } catch (error) {
            const code = error && typeof error.code === "string" ? error.code : "";
            if (code === "ENOENT") {
                // No meta at all. Acceptable only for a store that also has no records; otherwise the
                // sequence history is gone and continuing would reuse numbers.
                if (context.recordsPresent === true) {
                    return { ok: false, reason: "controller meta is missing while records exist; the sequence history was lost" };
                }
                return { ok: true, meta: { nextSeq: 1, generation: 1 } };
            }
            // Permissions, IO, a directory where the file should be: a real failure, reported as such.
            const reason = error instanceof Error ? error.message : String(error);
            return { ok: false, reason: `controller meta could not be read: ${reason}` };
        }
        let value;
        try {
            value = JSON.parse(raw);
        } catch (error) {
            return { ok: false, reason: `controller meta is not valid JSON: ${error instanceof Error ? error.message : String(error)}` };
        }
        if (value === null || typeof value !== "object" || !Number.isSafeInteger(value.nextSeq) || value.nextSeq < 1 || !Number.isSafeInteger(value.generation) || value.generation < 1) {
            return { ok: false, reason: "controller meta is malformed" };
        }
        return { ok: true, meta: { nextSeq: value.nextSeq, generation: value.generation } };
    }

    /**
     * Whether any record already exists, without reading or parsing them.
     *
     * Used by the sequence allocator to tell an empty store from one whose meta was lost. The distinction
     * is the whole point: a missing meta beside existing records means the sequence history is gone, and
     * continuing from 1 would hand out numbers an existing cursor has already passed — and could collide
     * with a server-issued event id that is already in the store.
     *
     * A directory that cannot be READ is reported rather than treated as empty, because "I could not look"
     * and "there is nothing there" lead to opposite decisions here.
     *
     * @returns {{ok: true, present: boolean} | {ok: false, reason: string}} whether records exist.
     */
    hasRecords() {
        if (!this.available) return { ok: false, reason: "store-not-configured" };
        const dir = this.eventsDir();
        if (!dir.ok) return { ok: false, reason: dir.reason };
        let names;
        try {
            names = fs.readdirSync(dir.file);
        } catch (error) {
            const code = error !== null && typeof error === "object" && typeof error.code === "string" ? error.code : "";
            // A store with no events directory yet is genuinely empty.
            if (code === "ENOENT") return { ok: true, present: false };
            return { ok: false, reason: error instanceof Error ? error.message : String(error) };
        }
        return { ok: true, present: names.some((name) => name.endsWith(".json")) };
    }

    /**
     * Reserve the next sequence and write the meta back, BEFORE the event that will use it.
     *
     * Reserving first is what makes a crash safe: an unused reserved number is a harmless gap, whereas
     * writing the event first and then discovering the sequence was stale would give two events one
     * identity. The high-water mark only ever increases.
     *
     * This is the ALLOCATION boundary every producer shares — the question tool, the notification tool and
     * the native-event observer all reach the store through it — so the lost-meta check belongs here and
     * not in one of those callers or in the HTTP surface. A producer that runs without a controller reload
     * must be refused exactly like one that followed a reload; otherwise a missing meta would quietly
     * renumber the store for whichever writer happened to arrive first.
     *
     * @returns {{ok: true, seq: number, generation: number} | {ok: false, reason: string}} the reservation.
     */
    reserveSeq() {
        if (!this.available) return { ok: false, reason: "store-not-configured" };
        const presence = this.hasRecords();
        if (!presence.ok) return { ok: false, reason: `records could not be checked: ${presence.reason}` };
        const current = this.readMeta({ recordsPresent: presence.present });
        if (!current.ok) return { ok: false, reason: current.reason };
        const target = this.metaFile();
        if (!target.ok) return target;
        const seq = current.meta.nextSeq;
        const written = writeJsonAtomic(target.file, { nextSeq: seq + 1, generation: current.meta.generation });
        if (!written.ok) return { ok: false, reason: `could not reserve a sequence: ${written.reason}` };
        return { ok: true, seq, generation: current.meta.generation };
    }

    /** @returns {{ok: true, file: string} | {ok: false, reason: string}} one record's path. */
    recordFile(id) {
        return resolveInside(this.root, "events", `${safeFileName(id)}.json`);
    }

    /**
     * Write one record atomically.
     *
     * The whole record is one file, so there is no partial state: either the event exists with all of
     * its fields, or it does not exist at all.
     *
     * @param {object} record - the complete record.
     * @returns {{ok: true} | {ok: false, reason: string}} the outcome.
     */
    putRecord(record) {
        if (!this.available) return { ok: false, reason: "store-not-configured" };
        if (record === null || typeof record !== "object" || typeof record.id !== "string" || record.id.length === 0) {
            return { ok: false, reason: "a record requires an id" };
        }
        const target = this.recordFile(record.id);
        if (!target.ok) return target;
        return writeJsonAtomic(target.file, record);
    }

    /**
     * Read one record.
     *
     * A missing record and an unreadable one are reported DIFFERENTLY: `not-found` means the id is absent,
     * while any other error carries the real reason. Collapsing both into "not-found" would let a
     * permissions problem look exactly like a record that was reclaimed, which is the distinction a caller
     * deciding whether an event was retired needs.
     *
     * @param {string} id - the record id.
     * @returns {{ok: true, value: object} | {ok: false, reason: string}} the record or why it is unavailable.
     */
    getRecord(id) {
        if (!this.available) return { ok: false, reason: "store-not-configured" };
        const target = this.recordFile(id);
        if (!target.ok) return target;
        const read = readJson(target.file);
        if (read.ok) return read;
        // The classification uses the error CODE carried by the reader, not a pattern match on the message:
        // the message includes the path, so a path containing "ENOENT" would otherwise be misread.
        return read.missing ? { ok: false, reason: "not-found", code: read.code, missing: true } : read;
    }

    /** Every record, plus any unreadable files. */
    allRecords() {
        if (!this.available) return { records: [], problems: [], readable: false, reason: "store-not-configured" };
        const dir = this.eventsDir();
        if (!dir.ok) return { records: [], problems: [{ file: this.root, reason: dir.reason }], readable: false, reason: dir.reason };
        const records = [];
        const problems = [];
        let names;
        try {
            names = fs.readdirSync(dir.file);
        } catch (error) {
            // An events directory that does not exist yet is a genuinely empty store — that is the only
            // error treated as "nothing is here". Anything else (permissions, IO, a file where the
            // directory should be) means the records COULD NOT BE READ, which is not the same fact and must
            // never be reported as an empty store: a caller that believed it would publish over records it
            // never saw.
            const code = error && typeof error.code === "string" ? error.code : "";
            const missing = code === "ENOENT";
            if (missing) return { records, problems, readable: true, reason: "no records yet" };
            const reason = error instanceof Error ? error.message : String(error);
            return { records, problems: [{ file: dir.file, reason }], readable: false, reason };
        }
        for (const name of names) {
            if (!name.endsWith(".json")) continue;
            const read = readJson(path.join(dir.file, name));
            if (read.ok && read.value !== null && typeof read.value === "object" && typeof read.value.id === "string") records.push(read.value);
            else problems.push({ file: path.join(dir.file, name), reason: read.ok ? "not a record" : read.reason });
        }
        return { records, problems, readable: true, reason: problems.length > 0 ? `${problems.length} unreadable record(s)` : "ok" };
    }

    /**
     * Confirm one event's NOTIFICATION.
     *
     * This is a compare-and-set on the notification axis alone: it says the controller has dealt with
     * being told, and deliberately says nothing about the business state. A pending question stays
     * answerable after its notification is confirmed, which is exactly the distinction an earlier
     * three-file design lost.
     *
     * @param {string} id - the record id.
     * @param {string} [confirmedAt] - when.
     * @returns {{ok: true, record: object, changed: boolean} | {ok: false, reason: string}} the outcome.
     */
    confirmNotification(id, confirmedAt = new Date().toISOString()) {
        const current = this.getRecord(id);
        if (!current.ok) return current;
        if (current.value.notification === NOTIFICATION.CONFIRMED) {
            return { ok: true, record: current.value, changed: false };
        }
        const next = { ...current.value, notification: NOTIFICATION.CONFIRMED, confirmedAt };
        const written = this.putRecord(next);
        if (!written.ok) return written;
        return { ok: true, record: next, changed: true };
    }

    /**
     * Move one question's BUSINESS state to a terminal value, if it is still pending.
     *
     * A compare-and-set rather than an overwrite, so the first terminal outcome wins and a second one is
     * reported as already decided instead of replacing it. `answer` is only recorded on the transition.
     *
     * @param {string} id - the record id.
     * @param {object} outcome - `{business, answer?, terminalAt?}`.
     * @returns {{ok: true, record: object, changed: boolean} | {ok: false, reason: string}} the outcome.
     */
    setBusinessOutcome(id, outcome) {
        const current = this.getRecord(id);
        if (!current.ok) return current;
        const record = current.value;
        if (isTerminalBusiness(record)) {
            return { ok: true, record, changed: false };
        }
        const next = {
            ...record,
            business: outcome.business,
            terminalAt: outcome.terminalAt ?? new Date().toISOString(),
            ...(outcome.answer === undefined ? {} : { answer: outcome.answer })
        };
        const written = this.putRecord(next);
        if (!written.ok) return written;
        return { ok: true, record: next, changed: true };
    }

    /**
     * Remove records that are finished, within configured bounds.
     *
     * A record is reclaimable only when the notification is confirmed AND the business state is terminal
     * AND it is older than `maxAgeMs` AND it is outside the newest `maxEvents`. Anything still pending or
     * unconfirmed is NEVER removed, however old or however far over the bound the store has grown,
     * because such a record is still owed to someone: erasing it to satisfy a limit would silently drop
     * work. A record that cannot be removed is reported and REMAINS — since one record is one file, a
     * failed removal leaves that record whole rather than half of it.
     *
     * Reclaiming does not lower the sequence high-water mark, which lives in the meta file, so a caller's
     * cursor keeps meaning what it meant.
     *
     * @param {object} bounds - `{maxAgeMs, maxEvents}`.
     * @returns {{removed: ReadonlyArray<string>, failed: ReadonlyArray<object>, retained: number, pending: number, unconfirmed: number}} the outcome.
     */
    reclaim({ maxAgeMs, maxEvents }) {
        if (!this.available) return { removed: [], failed: [], retained: 0, pending: 0, unconfirmed: 0, reason: "store-not-configured" };
        const now = Date.now();
        const scan = this.allRecords();
        // Reclaiming over records that could not be read would remove nothing and report a tidy store.
        // The failure is surfaced instead, so a caller can tell "nothing was due" from "nothing was seen".
        if (!scan.readable) return { removed: [], failed: [], retained: 0, pending: 0, unconfirmed: 0, reason: scan.reason };
        const { records } = scan;
        const removed = [];
        const failed = [];
        let retained = 0;
        let pending = 0;
        let unconfirmed = 0;
        const byController = new Map();
        for (const record of records) {
            const key = typeof record.controller === "string" ? record.controller : "";
            if (!byController.has(key)) byController.set(key, []);
            byController.get(key).push(record);
        }
        for (const list of byController.values()) {
            const eligible = [];
            for (const record of list) {
                if (record.notification !== NOTIFICATION.CONFIRMED) { unconfirmed += 1; continue; }
                if (!isTerminalBusiness(record)) { pending += 1; continue; }
                eligible.push(record);
            }
            const ordered = eligible
                .map((record) => {
                    const parsed = Date.parse(typeof record.terminalAt === "string" ? record.terminalAt : record.createdAt ?? "");
                    return { record, time: Number.isFinite(parsed) ? parsed : now };
                })
                .sort((a, b) => b.time - a.time);
            ordered.forEach((entry, index) => {
                const tooOld = now - entry.time > maxAgeMs;
                const beyondWindow = index >= maxEvents;
                if (!(tooOld && beyondWindow)) { retained += 1; return; }
                const target = this.recordFile(entry.record.id);
                try {
                    if (!target.ok) throw new Error(target.reason);
                    fs.rmSync(target.file, { force: true });
                    removed.push(entry.record.id);
                } catch (error) {
                    failed.push({ id: entry.record.id, reason: error instanceof Error ? error.message : String(error) });
                    retained += 1;
                }
            });
        }
        return { removed, failed, retained, pending, unconfirmed };
    }

    /**
     * Whether the store can actually be written to, checked at startup.
     *
     * @returns {{ok: true} | {ok: false, reason: string}} the outcome.
     */
    probeWritable() {
        if (!this.available) return { ok: false, reason: "store-not-configured" };
        const probe = path.join(this.root, `.probe-${randomUUID()}`);
        try {
            fs.mkdirSync(this.root, { recursive: true });
            fs.writeFileSync(probe, "ok", { encoding: "utf8", flag: "wx" });
            fs.rmSync(probe, { force: true });
            return { ok: true };
        } catch (error) {
            return { ok: false, reason: error instanceof Error ? error.message : String(error) };
        }
    }
}
