/**
 * The bridge's own durable store.
 *
 * Why this exists instead of the Session log. This harness refuses to READ a session log containing an
 * event type it does not know unless the event envelope carries `ignorable: true`, and `Session.append`
 * exposes no way to set that marker (it accepts only `sourceEventSeqs` and `surfaceOp`). Out-of-repo
 * plugin event names are outside the generated known-type set by construction, so writing a custom event
 * makes that session log uninterpretable — `session/list` and `session/query` then fail permanently.
 * That was reproduced on a real stop/restart, not theorised. The session log therefore CANNOT hold this
 * plugin's records, and this store is the single authoritative place they live.
 *
 * Design rules that keep it from becoming a second writable truth:
 *
 *  - ONE store owns each fact. A signal, a question, and a confirmation are each written here once and
 *    read back from here; nothing is mirrored into the session log and nothing is re-derived elsewhere.
 *  - Every record is one file, written to a temporary name and atomically renamed, so a reader never
 *    sees a partial record and two writers cannot interleave inside one name.
 *  - Writes are keyed by stable identity, so re-recording the same fact is idempotent and never creates
 *    a duplicate.
 *  - Secrets never go in: records carry identity and references only.
 *
 * Layout, all beneath one configured root:
 *
 *   signals/<controller>/<signalId>.json          one event, unconfirmed
 *   confirmations/<controller>/<signalId>.json    the separate act of confirming that event
 *   questions/<bindingId>/<questionId>.json       one question's state machine
 *
 * @module dsh-codex-bridge/store
 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

/** Only these characters may appear in a path segment, so no id can escape the store root. */
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

/**
 * Turn a record id into a filename-safe name.
 *
 * Ids legitimately contain characters that are legal inside a path segment but NOT inside a filename on
 * Windows: a binding id such as `codex::a` contains `:`, which the filesystem reads as an
 * alternate-data-stream separator, so writing `<id>.json` fails with a misleading `ENOENT`. The mapping
 * is deterministic and INJECTIVE — `_` is escaped as `__`, and every other unsafe character as `_` plus
 * its 4-digit hex code point — so two different ids can never share a file, and a lookup stays a pure
 * function of the id. The id inside the record is unchanged.
 *
 * Exported so every surface that names a file after an id (the store, and the notification inbox) uses
 * ONE mapping instead of each inventing its own.
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
    // A reserved DOS device name or an empty name would still be unwise as a bare filename.
    return out.length === 0 || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(out) ? `_${out}` : out;
}

/** The internal alias, kept so call sites read as "the file name for this id". */
const fileNameOf = safeFileName;

/**
 * Resolve a path beneath the root, refusing anything that could escape it.
 *
 * Ids come from configuration and from generated identities, never from a caller's raw string, but this
 * check is the belt to that pair of braces: a segment that is not plainly safe is refused rather than
 * joined, so a malformed id cannot write outside the store.
 *
 * @param {string} root - the store root.
 * @param {...string} segments - path segments to join.
 * @returns {{ok: true, file: string} | {ok: false, reason: string}} the resolved path.
 */
function resolveInside(root, ...segments) {
    if (typeof root !== "string" || root.length === 0) return { ok: false, reason: "no-store-root" };
    for (const segment of segments) {
        if (typeof segment !== "string" || !SAFE_SEGMENT.test(segment)) {
            return { ok: false, reason: `unsafe store segment ${JSON.stringify(segment)}` };
        }
    }
    // The FIRST segment is this module's own fixed domain name ("signals"/"questions"/etc.) and is left
    // as written; every later segment except the last is an ID used as a DIRECTORY, which has the same
    // platform limits as a file name (`codex::1` cannot be a directory on Windows either).
    const encoded = segments.map((segment, index) => (index === 0 || index === segments.length - 1 ? segment : `d-${fileNameOf(segment)}`));
    const file = path.join(root, ...encoded);
    const relative = path.relative(root, file);
    if (relative.startsWith("..") || path.isAbsolute(relative)) return { ok: false, reason: "store path escapes its root" };
    return { ok: true, file };
}

/**
 * Join already-readable directory names beneath the root, refusing anything that escapes it.
 *
 * Used when enumerating what is on disk: the names come from `readdir`, so they are already the encoded
 * form and must not be encoded again. The containment check still applies, so a symlink or a crafted
 * entry cannot lead outside the store.
 *
 * @param {string} root - the store root.
 * @param {...string} segments - already-safe directory names.
 * @returns {{ok: true, file: string} | {ok: false, reason: string}} the resolved path.
 */
function joinRaw(root, ...segments) {
    if (typeof root !== "string" || root.length === 0) return { ok: false, reason: "no-store-root" };
    for (const segment of segments) {
        // A name straight from readdir cannot contain a separator or a parent reference.
        if (typeof segment !== "string" || segment.length === 0 || segment.includes("/") || segment.includes("\\") || segment === "." || segment === "..") {
            return { ok: false, reason: `unsafe listed segment ${JSON.stringify(segment)}` };
        }
    }
    const file = path.join(root, ...segments);
    const relative = path.relative(root, file);
    if (relative.startsWith("..") || path.isAbsolute(relative)) return { ok: false, reason: "store path escapes its root" };
    return { ok: true, file };
}

/**
 * Write one JSON record atomically.
 *
 * Written to a temporary name in the SAME directory and then renamed, so a concurrent reader sees either
 * the previous complete record or the new one, never a half-written file. Re-writing the same identity
 * replaces the record in place, which is what makes a retry idempotent instead of duplicative.
 *
 * @param {string} file - destination path.
 * @param {unknown} value - the record.
 * @returns {{ok: true} | {ok: false, reason: string}} the outcome.
 */
export function writeRecord(file, value) {
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
 * Read one JSON record.
 *
 * @param {string} file - the record path.
 * @returns {{ok: true, value: unknown} | {ok: false, reason: string}} the record, or why it is unavailable.
 */
export function readRecord(file) {
    try {
        return { ok: true, value: JSON.parse(fs.readFileSync(file, "utf8")) };
    } catch (error) {
        return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
}

/** Read every record in a directory, reporting unreadable files instead of skipping them silently. */
export function readRecords(dir) {
    const records = [];
    const problems = [];
    let names;
    try {
        names = fs.readdirSync(dir);
    } catch {
        return { records, problems };
    }
    for (const name of names) {
        if (!name.endsWith(".json")) continue;
        const file = path.join(dir, name);
        const read = readRecord(file);
        if (read.ok) records.push(read.value);
        else problems.push({ file, reason: read.reason });
    }
    return { records, problems };
}

/** The bridge's durable store: the single place its records live. */
export class CollabStore {
    /**
     * @param {string} root - store root, from configuration.
     */
    constructor(root) {
        this.root = typeof root === "string" ? root : "";
        this.available = this.root.length > 0;
    }

    /** Record one signal, keyed by its stable id. */
    putSignal(signal) {
        if (!this.available) return { ok: false, reason: "store-not-configured" };
        const target = resolveInside(this.root, "signals", signal.controller, `${fileNameOf(signal.id)}.json`);
        if (!target.ok) return target;
        return writeRecord(target.file, signal);
    }

    /**
     * Every recorded signal, across all controllers, plus any unreadable files.
     *
     * Directory names are encoded, so the records — not the directory names — are the source of each
     * signal's identity. Walking every directory keeps a binding or controller whose encoded name does
     * not round-trip from losing its events.
     */
    allSignals() {
        if (!this.available) return { signals: [], problems: [] };
        const signals = [];
        const problems = [];
        let directories;
        try {
            directories = fs.readdirSync(path.join(this.root, "signals"), { withFileTypes: true });
        } catch {
            return { signals, problems };
        }
        for (const entry of directories) {
            if (!entry.isDirectory()) continue;
            const dir = joinRaw(this.root, "signals", entry.name);
            if (!dir.ok) continue;
            const read = readRecords(dir.file);
            signals.push(...read.records);
            problems.push(...read.problems);
        }
        return { signals, problems };
    }

    /** Record the separate act of confirming one event. */
    putConfirmation(controller, signalId, detail) {
        if (!this.available) return { ok: false, reason: "store-not-configured" };
        const target = resolveInside(this.root, "confirmations", controller, `${fileNameOf(signalId)}.json`);
        if (!target.ok) return target;
        return writeRecord(target.file, { signalId, controller, ...detail });
    }

    /** Whether one event has been confirmed. */
    isConfirmed(controller, signalId) {
        if (!this.available) return false;
        const target = resolveInside(this.root, "confirmations", controller, `${fileNameOf(signalId)}.json`);
        return target.ok && fs.existsSync(target.file);
    }

    /** Every confirmation for one controller. */
    confirmationsFor(controller) {
        if (!this.available) return { confirmed: new Set(), problems: [] };
        // The controller is an ID used as a DIRECTORY, so it must be resolved with a trailing file
        // segment; resolving it as a leaf would name a file, not the directory to enumerate.
        const dir = resolveInside(this.root, "confirmations", controller, "probe.json");
        if (!dir.ok) return { confirmed: new Set(), problems: [] };
        const read = readRecords(path.dirname(dir.file));
        return { confirmed: new Set(read.records.map((record) => record.signalId).filter((id) => typeof id === "string")), problems: read.problems };
    }

    /** Record one question's current state. */
    putQuestion(bindingId, question) {
        if (!this.available) return { ok: false, reason: "store-not-configured" };
        const target = resolveInside(this.root, "questions", bindingId, `${fileNameOf(question.id)}.json`);
        if (!target.ok) return target;
        return writeRecord(target.file, question);
    }

    /** One question's record, or why it is unavailable. */
    getQuestion(bindingId, questionId) {
        if (!this.available) return { ok: false, reason: "store-not-configured" };
        const target = resolveInside(this.root, "questions", bindingId, `${fileNameOf(questionId)}.json`);
        if (!target.ok) return target;
        return readRecord(target.file);
    }

    /** Every question, across all bindings, plus any unreadable files. */
    allQuestions() {
        if (!this.available) return { questions: [], problems: [] };
        const questions = [];
        const problems = [];
        let directories;
        try {
            directories = fs.readdirSync(path.join(this.root, "questions"), { withFileTypes: true });
        } catch {
            return { questions, problems };
        }
        for (const entry of directories) {
            if (!entry.isDirectory()) continue;
            const dir = joinRaw(this.root, "questions", entry.name);
            if (!dir.ok) continue;
            const read = readRecords(dir.file);
            questions.push(...read.records);
            problems.push(...read.problems);
        }
        return { questions, problems };
    }

    /**
     * Reclaim storage for records that are finished, within a configured bound.
     *
     * Retention is deliberately narrow, because deleting the wrong thing loses a fact a controller was
     * owed:
     *
     *  - only a signal that the store ALSO records as confirmed is a candidate. An unconfirmed event is
     *    never removed, no matter how old it is or how far over the cap it pushes the store: the caller
     *    has not dealt with it yet, so it is still owed, and erasing it to satisfy a limit would silently
     *    drop a message — exactly what retention must not do;
     *  - among confirmed events, one is reclaimed only when it is BOTH older than `maxAgeMs` AND beyond
     *    the newest `maxEvents`, so a burst of recent confirmations is never discarded to satisfy the cap;
     *  - the matching question record is reclaimed with it, since an answered or cancelled question is
     *    terminal and no longer needs to be re-read.
     *
     * What is removed is REPORTED, and what could not be removed is reported too, so a full store cannot
     * look like a tidy one. Confirmed-but-retained events keep working for idempotency: an event that is
     * still on disk is still recognized as already confirmed.
     *
     * @param {object} options - retention bounds.
     * @param {number} options.maxAgeMs - minimum age before a CONFIRMED event may be reclaimed.
     * @param {number} options.maxEvents - how many confirmed events are always retained, newest first.
     * @returns {{removed: ReadonlyArray<string>, failed: ReadonlyArray<string>, retained: number, unconfirmed: number}} the outcome.
     */
    reclaim({ maxAgeMs, maxEvents }) {
        if (!this.available) return { removed: [], failed: [], retained: 0, unconfirmed: 0 };
        const now = Date.now();
        const { signals } = this.allSignals();
        // Group by controller: confirmations are per controller, so a signal from one is never retained or
        // reclaimed on the strength of another's confirmations.
        const byController = new Map();
        for (const signal of signals) {
            if (signal === null || typeof signal !== "object" || typeof signal.id !== "string") continue;
            const key = typeof signal.controller === "string" ? signal.controller : "";
            if (!byController.has(key)) byController.set(key, []);
            byController.get(key).push(signal);
        }
        const removed = [];
        const failed = [];
        let retained = 0;
        let unconfirmed = 0;
        for (const [controller, list] of byController) {
            const { confirmed } = this.confirmationsFor(controller);
            const confirmedList = list.filter((signal) => confirmed.has(signal.id));
            unconfirmed += list.length - confirmedList.length;
            const ordered = confirmedList
                .map((signal) => {
                    const parsed = Date.parse(typeof signal.at === "string" ? signal.at : "");
                    return { signal, time: Number.isFinite(parsed) ? parsed : now };
                })
                .sort((a, b) => b.time - a.time);
            ordered.forEach((entry, index) => {
                const tooOld = now - entry.time > maxAgeMs;
                const beyondCap = index >= maxEvents;
                if (!(tooOld && beyondCap)) {
                    // Kept: either recent, or within the guaranteed newest window.
                    retained += 1;
                    return;
                }
                const signal = entry.signal;
                const signalFile = resolveInside(this.root, "signals", controller, `${fileNameOf(signal.id)}.json`);
                const confirmFile = resolveInside(this.root, "confirmations", controller, `${fileNameOf(signal.id)}.json`);
                const questionFile = typeof signal.bindingId === "string" && typeof signal.reference === "string"
                    ? resolveInside(this.root, "questions", signal.bindingId, `${fileNameOf(signal.reference.replace("collab-question:", ""))}.json`)
                    : { ok: false, reason: "not a question" };
                try {
                    // The confirmation record is removed LAST: while it exists the event is still known to
                    // be confirmed, so a crash mid-reclaim cannot resurrect it as outstanding work.
                    if (signalFile.ok) fs.rmSync(signalFile.file, { force: true });
                    if (questionFile.ok) fs.rmSync(questionFile.file, { force: true });
                    if (confirmFile.ok) fs.rmSync(confirmFile.file, { force: true });
                    removed.push(signal.id);
                } catch (error) {
                    // A record that could not be reclaimed stays on disk and is reported, so the store
                    // never claims to be bounded while it is not.
                    failed.push({ id: signal.id, reason: error instanceof Error ? error.message : String(error) });
                    retained += 1;
                }
            });
        }
        return { removed, failed, retained, unconfirmed };
    }

    /**
     * Whether the store can actually be written to.
     *
     * Checked at startup so a broken store is reported immediately rather than at the first transfer
     * that mattered. A read-only or uncreatable root is a real failure: the bridge must not accept a
     * notification it cannot durably record.
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
