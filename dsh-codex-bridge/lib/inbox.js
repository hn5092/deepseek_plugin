/**
 * File inbox: a recoverable notification projection of the plugin's signals.
 *
 * The controller may be a process that cannot hold an HTTP wait open, so the same events are also
 * published as files. Two properties make that safe:
 *
 *  - each event is ONE uniquely named file, written to a temp name and then `rename`d into place, so
 *    two writers can never overwrite one `done.txt` and a reader can never observe a half-written file;
 *  - the directory is per controller, so one binding's events are not even visible to another.
 *
 * The files are a NOTIFICATION PROJECTION, not a source of truth: the session log and the plugin's own
 * events remain authoritative, and a file's presence never means "approved", "tests passed" or "run
 * this command". Payloads carry identity and a reference to where the truth lives, never secrets or
 * full private context.
 *
 * Watching is deliberately advisory. A watcher can miss events (scan/subscribe races, coalesced
 * notifications), so a reader always re-reads the actual directory state, and the API closes the race
 * by scanning BEFORE it starts observing and again after.
 *
 * @module dsh-codex-bridge/inbox
 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { safeFileName } from "./store.js";

/** Only these characters may appear in a controller's directory name, so a controller cannot escape. */
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Signals are small by design: identity plus a reference, never a payload dump. */
const MAX_SIGNAL_BYTES = 16 * 1024;

/**
 * Resolve one controller's inbox directory.
 *
 * The controller id becomes a single path segment and must match a conservative pattern, so a caller
 * cannot make the bridge write outside the configured root.
 *
 * @param {string} root - configured inbox root.
 * @param {string} controller - controller id.
 * @returns {{ok: true, dir: string} | {ok: false, reason: string}} the directory, or why it is refused.
 */
export function inboxDirFor(root, controller) {
    if (typeof root !== "string" || root.length === 0) return { ok: false, reason: "no-inbox-root" };
    if (typeof controller !== "string" || !SAFE_SEGMENT.test(controller)) {
        return { ok: false, reason: "controller id must be a single safe path segment" };
    }
    return { ok: true, dir: path.join(root, controller) };
}

/**
 * Publish one signal as a file.
 *
 * Written to a temporary name and then renamed, so the published file appears complete or not at all.
 * A repeat of the same signal id rewrites the same final name with identical content, which keeps
 * duplicate notifications harmless rather than creating a second event.
 *
 * @param {string} dir - this controller's inbox directory.
 * @param {object} signal - a normalized signal.
 * @returns {{ok: true, file: string} | {ok: false, reason: string}} the published path, or why it failed.
 */
export function publishSignal(dir, signal) {
    const text = JSON.stringify(signal);
    if (Buffer.byteLength(text, "utf8") > MAX_SIGNAL_BYTES) return { ok: false, reason: "signal too large for the inbox" };
    try {
        fs.mkdirSync(dir, { recursive: true });
        // The id is encoded with the SAME injective mapping the durable store uses: an id such as
        // `sig-notify-codex::1-...` contains `:`, which Windows reads as an alternate-data-stream
        // separator, so using the raw id here would fail with a misleading ENOENT.
        const finalName = `${safeFileName(signal.id)}.json`;
        const tempName = `.${safeFileName(signal.id)}.${randomUUID()}.tmp`;
        const tempPath = path.join(dir, tempName);
        const finalPath = path.join(dir, finalName);
        fs.writeFileSync(tempPath, text, { encoding: "utf8", flag: "wx" });
        // Same-directory rename is atomic on the platforms this runs on, so a reader never sees a
        // partial file and two writers cannot interleave inside one name.
        fs.renameSync(tempPath, finalPath);
        return { ok: true, file: finalPath };
    } catch (error) {
        return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
}

/**
 * Read every signal currently present in one controller's inbox.
 *
 * The directory is read fresh on every call — that is what makes a missed watch notification
 * harmless — and a file that is unreadable or malformed is reported rather than silently skipped, so a
 * corrupt event cannot look like "nothing to do".
 *
 * @param {string} dir - this controller's inbox directory.
 * @returns {{signals: Array<object>, problems: Array<object>}} the readable signals and any problems.
 */
export function readSignals(dir) {
    const signals = [];
    const problems = [];
    let names;
    try {
        names = fs.readdirSync(dir);
    } catch {
        // A missing directory is an empty inbox, not a failure to report events.
        return { signals, problems };
    }
    for (const name of names) {
        if (!name.endsWith(".json")) continue;
        const file = path.join(dir, name);
        try {
            const text = fs.readFileSync(file, "utf8");
            const parsed = JSON.parse(text);
            if (parsed === null || typeof parsed !== "object" || typeof parsed.id !== "string") {
                problems.push({ file, reason: "not-a-signal" });
                continue;
            }
            signals.push({ ...parsed, file });
        } catch (error) {
            problems.push({ file, reason: error instanceof Error ? error.message : String(error) });
        }
    }
    return { signals, problems };
}

/**
 * Confirm (acknowledge) one event.
 *
 * Confirmation is a separate act from delivery, so a file is removed only when the caller says it has
 * dealt with that event. Removing by exact signal id keeps the operation idempotent: confirming twice
 * is the same outcome, and confirming one event cannot touch another.
 *
 * @param {string} dir - this controller's inbox directory.
 * @param {string} signalId - the event id to confirm.
 * @returns {{ok: true, removed: boolean}} whether a file was removed.
 */
export function confirmSignal(dir, signalId) {
    // The id is only ever turned into a FILE NAME through the shared encoder, so it does not need to
    // satisfy the stricter directory-id pattern — an id containing `:` is perfectly valid and common
    // (`sig-notify-codex::1-...`), and rejecting it here would silently leave the event unconfirmed.
    if (typeof signalId !== "string" || signalId.length === 0) return { ok: true, removed: false };
    try {
        const file = path.join(dir, `${safeFileName(signalId)}.json`);
        if (!fs.existsSync(file)) return { ok: true, removed: false };
        fs.rmSync(file, { force: true });
        return { ok: true, removed: true };
    } catch {
        return { ok: true, removed: false };
    }
}

/**
 * Watch one controller's inbox, closing the scan/subscribe race.
 *
 * The contract is: scan the ACTUAL directory first, then establish the watcher, then scan again. Any
 * event that arrived in the gap is therefore caught by the second scan rather than lost, and the
 * watcher itself is only a prompt to re-read — never the record.
 *
 * @param {string} dir - this controller's inbox directory.
 * @param {(snapshot: {signals: Array<object>, problems: Array<object>}) => void} onSnapshot - called with each fresh reading.
 * @returns {() => void} a disposer that stops watching.
 */
export function watchInbox(dir, onSnapshot) {
    fs.mkdirSync(dir, { recursive: true });
    const emit = () => onSnapshot(readSignals(dir));
    // 1) backlog first, so an event that predates the wait is delivered immediately.
    emit();
    // 2) then observe, and 3) re-scan so anything landing in between is not missed.
    let watcher = null;
    try {
        watcher = fs.watch(dir, { persistent: false }, () => emit());
    } catch {
        // Watching is advisory; a platform that cannot watch still works via the caller's polling.
        watcher = null;
    }
    emit();
    return () => {
        try { watcher?.close(); } catch { /* already closed */ }
    };
}

// Retention is NOT implemented here. An inbox file is a projection of a durable signal, so whether an
// event may be reclaimed is a question about the SIGNAL's authority — is it confirmed, is it terminal,
// how old is it — which only the store that owns those records can answer. A directory-level prune that
// decides by file age alone would delete events a controller had not confirmed yet, dropping owed
// messages to satisfy a cap. See `CollabStore.reclaim`.
