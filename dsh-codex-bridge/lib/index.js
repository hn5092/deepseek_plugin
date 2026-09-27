import { randomUUID } from "node:crypto";
import z from "@deepseek-ai/schemastery";
import { z as zod } from "zod";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import {
    ANSWER_SOURCES,
    answerVerdict,
    assertSingleOwner,
    bindingsOf,
    identifyController,
    isKnownController,
    matchBinding,
    normalizeBinding,
    pendingQuestions,
    questionStateOf
} from "./collab.js";
import { deliverableSignals, normalizeSignal, recoverSignals, signalVerdict, waitOutcome } from "./signals.js";
import { confirmSignal, inboxDirFor, publishSignal, readSignals } from "./inbox.js";

/** Cordis plugin name; the profile patch row id stays independent of it. */
export const name = "codex-bridge";

/**
 * Host services the bridge needs.
 *
 * `tools` registers the model-facing question tool; `sessionProjections` folds the collaboration
 * events into readable state (the same seam `dsh-permission-presets` uses for its own durable event);
 * `connection` supplies the shell's real admission fence; `sessionController`/`agents` keep the
 * existing message delivery working. Every service read here is declared, because Cordis throws on an
 * undeclared access.
 */
export const inject = ["webServer", "sessionController", "agents", "tools", "sessionProjections", "connection", "credentials"];

/** Refuse oversized request bodies instead of buffering them. */
const MAX_BODY_BYTES = 256 * 1024;
/** Longest accepted message. A bridge is for instructions, not for shipping files. */
const MAX_TEXT_CHARS = 100_000;
/** Bound on one admission, so a wedged session cannot hang the caller's curl. */
const DELIVERY_TIMEOUT_MS = 30_000;
/** Only a loopback caller may drive a session by default. */
const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/** The durable event types this plugin owns. */
const EVENT_QUESTION = "collab/question";
const EVENT_ANSWER = "collab/answer";
const EVENT_CANCEL = "collab/cancel";
const EVENT_NOTIFY = "collab/notify";
const EVENT_CONFIRM = "collab/confirm";

/** The projection key folding those events. */
const PROJECTION_KEY = "collabQuestions";

export const Config = z.object({
    /** Route prefix. Changing it means changing the caller's URL too. */
    path: z.string().default("/codex-bridge"),
    /**
     * Delivery mode while the addressed Session is busy. Matches the composer's
     * `ui-conversation.busyEnter` preference: `queue` waits for the running turn, `steer`
     * interrupts it.
     */
    busyMode: z.union([z.const("queue"), z.const("steer")]).default("steer"),
    /** Label recorded as the message source, so a bridged turn is distinguishable in the transcript. */
    sourceLabel: z.string().default("codex-bridge"),
    /** Refuse to deliver into a Session whose id is not currently known. */
    requireKnownSession: z.boolean().default(true),
    /**
     * Collaboration bindings: which Session, in which directory, is controlled by which party. A
     * controller receives and answers only its own bindings, and identity is never inferred from a
     * title or from which window happens to be open. One controller may own MANY bindings across
     * different directories — the (controller, sessionId) pair is the identity, so sessions in
     * different projects are never merged into one.
     */
    bindings: z.array(z.object({
        bindingId: z.string(),
        sessionId: z.string(),
        cwd: z.string(),
        controller: z.string(),
        /**
         * Credential reference that identifies this controller. The secret itself lives in the
         * credentials service and is never part of configuration, the session, or the repository.
         */
        tokenRef: z.string(),
        /** False marks a binding superseded by a handover, so an old owner can no longer answer. */
        current: z.boolean().default(true)
    })).default([]),
    /**
     * Default bound on how long an ask waits for a controller before returning `interrupted`.
     * A bounded wait is deliberate: a tool call must never pin a turn forever.
     */
    answerTimeoutMs: z.number().default(600_000),
    /** Route prefix for the collaboration control surface. */
    collabPath: z.string().default("/codex-collab"),
    /**
     * Root of the file-signal inbox: one directory per controller. A local run path, so it is
     * configuration rather than code, and only a validated controller id may become a directory name.
     */
    inboxRoot: z.string().default(""),
    /** How long a signal may be retained before it becomes prunable. */
    inboxMaxAgeMs: z.number().default(7 * 24 * 60 * 60 * 1000),
    /** How many signals one inbox always keeps, newest first. */
    inboxMaxEvents: z.number().default(500)
});

function messageOf(error) {
    return error instanceof Error ? error.message : String(error);
}

/** Read a request body with a hard byte ceiling. */
function readBody(request) {
    return new Promise((resolve, reject) => {
        let size = 0;
        const chunks = [];
        request.on("data", (chunk) => {
            size += chunk.length;
            if (size > MAX_BODY_BYTES) {
                reject(new Error("request body too large"));
                request.destroy();
                return;
            }
            chunks.push(chunk);
        });
        request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        request.on("error", reject);
    });
}

/** @param {import("node:http").ServerResponse} response - the response. @param {number} status - code. @param {unknown} body - JSON body. */
function send(response, status, body) {
    const text = JSON.stringify(body, null, 2);
    response.writeHead(status, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        "content-length": Buffer.byteLength(text)
    });
    response.end(text);
}

/**
 * Local bridge between a DSH Session and an external controller (Codex).
 *
 * Two directions, one state owner:
 *
 *  - INTO a session, the existing `POST /send` still reuses `sessionController.prompt`, so a bridged
 *    message is indistinguishable from a typed one.
 *  - OUT of a session, the model-facing `ask_codex` tool records a durable `collab/question` event and
 *    waits (bounded) for a controller's answer. A controller polls `GET /questions` and answers with
 *    `POST /answer`; the tool returns that answer as an ordinary tool result, so the SAME call
 *    continues and nothing already executed is replayed.
 *
 * The Session log is the record of every question and answer. In-memory state holds only the LIVE
 * waiters, so a host restart cannot resurrect a fake promise: an unanswered question stays readable
 * and the caller is told to resume it by identity instead.
 */
export function apply(ctx, config) {
    const base = config.path.replace(/\/+$/, "");
    const collabBase = config.collabPath.replace(/\/+$/, "");

    /** Declared bindings, validated once at startup so a typo cannot silently widen access. */
    const bindings = [];
    for (const raw of config.bindings || []) {
        const normalized = normalizeBinding(raw);
        if (normalized.ok) bindings.push(normalized.binding);
        else ctx.logger.warn("codex-bridge: ignoring invalid binding (%s): %o", normalized.reason, raw);
    }
    // One session may have exactly one effective answer owner. Two owners would make an answer
    // ambiguous and could produce two terminal outcomes for one tool call, so an ambiguous session is
    // refused outright — its bindings are dropped, leaving it with NO answer owner rather than two. A
    // handover is expressed by marking the predecessor `current: false`.
    const ownership = assertSingleOwner(bindings);
    if (!ownership.ok) {
        const ambiguous = ownership.sessionId;
        ctx.logger.error("codex-bridge: %s; refusing every binding for that session", ownership.reason);
        for (let i = bindings.length - 1; i >= 0; i -= 1) {
            if (bindings[i].sessionId === ambiguous) bindings.splice(i, 1);
        }
    }

    /** Live waiters only: `questionId` -> resolver. Not a record; the log is the record. */
    const waiters = new Map();
    /** Question metadata needed to serve a controller: id -> {sessionId, cwd, question, seq, askedAt}. */
    const registry = new Map();
    /** Monotonic sequence so a controller's cursor is meaningful. */
    let sequence = 0;

    /**
     * Signals raised by this process, keyed by signal id.
     *
     * The signal is a NOTIFICATION projection of an event that already exists in the session log or in
     * this plugin's own question registry; it is never a second writable source of truth. Identity is
     * the id, so a repeat of the same event is the same signal and cannot be delivered twice.
     */
    const signals = new Map();
    /** Resolvers waiting on ANY bound session, so one new signal can wake several waits. */
    const signalWaiters = new Set();

    /** The configured inbox root, or null when file signalling is not configured. */
    const inboxRoot = typeof config.inboxRoot === "string" && config.inboxRoot.length > 0 ? config.inboxRoot : null;

    /**
     * Confirmed event ids, read from the authoritative session events.
     *
     * Confirmation is recorded as a durable event rather than as a client-supplied list, so every view
     * (the memory projection, the file inbox, and a view rebuilt after a restart) agrees on what has
     * been dealt with. Reading it from the log on each call is what makes a confirmation survive a
     * restart without a second writable truth.
     *
     * @returns {Set<string>} the confirmed event ids.
     */
    const durableConfirmed = () => {
        const confirmed = new Set();
        try {
            // Read through the injected agent registry rather than any other service, so this uses the
            // same live-Agent view the rest of the bridge does.
            const live = ctx.agents.list();
            for (const agent of live) {
                const events = agent && agent.session && agent.session.snapshotEvents ? agent.session.snapshotEvents() : null;
                if (!Array.isArray(events)) continue;
                for (const event of events) {
                    if (event && event.type === EVENT_CONFIRM && event.data && typeof event.data.signalId === "string") {
                        confirmed.add(event.data.signalId);
                    }
                }
            }
        } catch {
            // An unreadable log means "nothing known confirmed", never "everything confirmed".
        }
        return confirmed;
    };

    /**
     * Secrets resolved once at startup, keyed by credential reference.
     *
     * Kept in memory only for the life of the instance, never written to the session, a log or Git.
     * Resolving once also means a request never triggers a credential read on the hot path.
     */
    const controllerSecrets = new Map();

    /** Load every declared controller credential from the shell's credential owner. */
    const loadControllerSecrets = async () => {
        const refs = [...new Set(bindings.map((entry) => entry.tokenRef).filter((ref) => typeof ref === "string" && ref.length > 0))];
        for (const ref of refs) {
            try {
                const resolved = await ctx.credentials.resolve(credentialRef(ref));
                const value = resolved && typeof resolved.value === "string" ? resolved.value : "";
                if (value.length > 0) controllerSecrets.set(ref, value);
                else ctx.logger.warn("codex-bridge: controller credential %s is not configured; that controller cannot authenticate", ref);
            } catch (error) {
                ctx.logger.warn("codex-bridge: controller credential %s could not be resolved: %s", ref, messageOf(error));
            }
        }
    };

    /**
     * Resolve a controller's credential reference to its secret, from the startup cache.
     *
     * The bridge never stores a secret of its own: the reference is configuration, the value lives in
     * the credentials service, and nothing resolved here is logged, echoed or persisted. An
     * unresolvable reference yields null, which makes that controller unauthenticatable rather than
     * silently acceptable.
     *
     * @param {string} ref - credential reference name declared on a binding.
     * @returns {string|null} the secret, or null when it cannot be resolved.
     */
    const resolveControllerSecret = (ref) => {
        const cached = controllerSecrets.get(ref);
        return typeof cached === "string" && cached.length > 0 ? cached : null;
    };

    // Load the declared controller credentials now, and expose the load for the readiness gate below.
    // Until this resolves, controllerSecrets is empty and every collaboration request is refused as
    // unidentified — the fail-closed direction, never the permissive one.
    let secretsReady = false;
    const secretsLoaded = loadControllerSecrets().then(() => { secretsReady = true; });
    /** @returns {boolean} whether the credential cache has been populated. */
    const controllerAuthReady = () => secretsReady;

    /**
     * Record one signal and notify waiters.
     *
     * The optional file projection is published first, so a controller that is watching files sees the
     * event even if this process dies immediately afterwards; the in-memory copy then wakes live waits.
     * A duplicate id whose content differs is refused rather than silently retargeting a task.
     *
     * @param {object} raw - candidate signal.
     * @returns {{ok: true, signal: object, duplicate: boolean} | {ok: false, reason: string}} the result.
     */
    const raiseSignal = (raw) => {
        const normalized = normalizeSignal(raw);
        if (!normalized.ok) return normalized;
        const candidate = { ...normalized.signal, seq: sequence + 1 };
        const verdict = signalVerdict(signals.get(candidate.id) ?? null, candidate);
        if (verdict.action === "conflict") return { ok: false, reason: verdict.reason };
        // A repeat of the SAME identity adds no second event. Its file may still need republishing if an
        // earlier write failed, but that must never create another business event.
        if (verdict.action === "same") {
            const known = signals.get(candidate.id);
            const republish = republishSignal(known);
            return { ok: true, signal: known, duplicate: true, ...(republish.ok ? {} : { fileError: republish.reason }) };
        }
        sequence += 1;
        signals.set(candidate.id, candidate);
        // The in-memory record is authoritative for this process and always succeeds; the FILE is a
        // notification projection and CAN fail (a read-only root, a full disk). Its failure is reported
        // rather than swallowed, because the caller must not believe a controller was reliably notified.
        const file = republishSignal(candidate);
        for (const wake of [...signalWaiters]) wake();
        return { ok: true, signal: candidate, duplicate: false, ...(file.ok ? {} : { fileError: file.reason }) };
    };

    /**
     * Write one signal's file into its controller's inbox.
     *
     * Publishing is idempotent by event id: retrying after a failure overwrites the same final name and
     * never produces a second business event. A controller whose directory cannot be resolved (an
     * unsafe id, or no configured root) is reported as a failure rather than silently skipped.
     *
     * @param {object} signal - a normalized signal.
     * @returns {{ok: true, file: string} | {ok: false, reason: string}} the outcome.
     */
    const republishSignal = (signal) => {
        if (inboxRoot === null) return { ok: false, reason: "file-inbox-not-configured" };
        const dir = inboxDirFor(inboxRoot, signal.controller);
        if (!dir.ok) return { ok: false, reason: dir.reason };
        const published = publishSignal(dir.dir, signal);
        if (!published.ok) {
            // Visible in the plugin log as well, so an operator can see a broken inbox without reading
            // the response of whichever call happened to notice first.
            ctx.logger.warn("codex-bridge: signal %s could not be written to the inbox: %s", signal.id, published.reason);
        }
        return published;
    };

    // ---- durable events + projection --------------------------------------------------------

    // Fold this plugin's events into readable state through the shell's own projection seam, rather
    // than keeping a second writable truth beside the session log.
    ctx.sessionProjections.register({
        key: PROJECTION_KEY,
        stateVersion: 1,
        // The shell validates persisted state before it seeds a fold, so the schema must describe the
        // real shape: question id -> the facts folded from this plugin's events.
        stateSchema: zod.record(zod.string(), zod.object({
            asked: zod.boolean().optional(),
            seq: zod.number().nullable().optional(),
            question: zod.string().optional(),
            answer: zod.object({
                id: zod.string(),
                text: zod.string(),
                source: zod.string(),
                controller: zod.string().optional(),
                at: zod.string().optional()
            }).optional(),
            cancel: zod.object({
                id: zod.string(),
                reason: zod.string().optional()
            }).optional()
        }).passthrough()),
        init: () => ({}),
        apply: (state, event) => {
            if (event.type === EVENT_QUESTION) {
                const id = event.data && event.data.id;
                if (typeof id !== "string") return state;
                return { ...state, [id]: { ...(state[id] ?? {}), asked: true, seq: event.data.seq ?? null, question: event.data.question ?? "" } };
            }
            if (event.type === EVENT_ANSWER) {
                const id = event.data && event.data.id;
                if (typeof id !== "string") return state;
                return { ...state, [id]: { ...(state[id] ?? {}), answer: event.data } };
            }
            if (event.type === EVENT_CANCEL) {
                const id = event.data && event.data.id;
                if (typeof id !== "string") return state;
                return { ...state, [id]: { ...(state[id] ?? {}), cancel: event.data } };
            }
            return state;
        }
    });

    /**
     * The durable events recorded for one question, read from the Session log.
     *
     * The log is authoritative; the projection above is a convenience view. Reading the events gives
     * the fold in `collab.js` something real to work on, so the same rules apply to a live question and
     * to one read back after a restart.
     */
    const eventsFor = (sessionId, questionId) => {
        try {
            const agent = ctx.agents.get(sessionId);
            if (agent === undefined || agent === null) return null;
            const events = agent.session.snapshotEvents ? agent.session.snapshotEvents() : null;
            if (!Array.isArray(events)) return null;
            return events
                .filter((event) => event && (event.type === EVENT_QUESTION || event.type === EVENT_ANSWER || event.type === EVENT_CANCEL))
                .filter((event) => event.data && event.data.id === questionId);
        } catch {
            return null;
        }
    };

    /** @param {string} sessionId - session. @param {string} questionId - question. @returns {object} the folded state. */
    const stateOfQuestion = (sessionId, questionId) => {
        const events = eventsFor(sessionId, questionId);
        if (events === null) {
            // No live Agent: the question cannot be read from this process, which is not the same as
            // "pending". Reporting it as unknown keeps a restart from looking like a live question.
            return { status: "unknown", reason: "session-not-live" };
        }
        return questionStateOf(events);
    };

    // ---- controller-facing view -------------------------------------------------------------

    /** Every question this process knows about, with its folded state, for one binding. */
    const listForBinding = (binding) => {
        const out = [];
        for (const [id, meta] of registry) {
            if (meta.sessionId !== binding.sessionId) continue;
            out.push({
                id,
                sessionId: meta.sessionId,
                cwd: meta.cwd,
                seq: meta.seq,
                askedAt: meta.askedAt,
                question: meta.question,
                state: stateOfQuestion(meta.sessionId, id)
            });
        }
        return out;
    };

    // ---- the model-facing tool --------------------------------------------------------------

    ctx.tools.register(defineTool({
        name: "ask_codex",
        description: "Ask the controlling agent (Codex) a technical question and wait for its answer. Use when you need a decision or information that only the controller can provide; the answer arrives as this tool's result and work continues in this same call.",
        parameters: {
            question: {
                type: "string",
                required: true,
                description: "The specific technical question for the controller."
            },
            detail: {
                type: "string",
                description: "Optional supporting detail, such as the exact error or the file in question."
            },
            timeoutMs: {
                type: "number",
                description: "Optional bound on how long to wait. The configured default applies when omitted."
            }
        },
        output: {
            schema: {
                type: "object",
                additionalProperties: false,
                properties: {
                    status: { type: "string", required: true },
                    answer: { type: "string" },
                    source: { type: "string" },
                    questionId: { type: "string", required: true },
                    reason: { type: "string" }
                }
            },
            render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }]
        },
        async execute(args, exec) {
            const question = typeof args.question === "string" ? args.question : "";
            if (question.trim().length === 0) throw new Error("ask_codex requires a non-empty question");
            const agent = exec.agent;
            const sessionId = agent && agent.id;
            if (typeof sessionId !== "string" || sessionId.length === 0) {
                throw new Error("ask_codex requires a Session identity to bind the question");
            }
            const cwd = typeof agent.session?.header?.cwd === "string" ? agent.session.header.cwd : "";
            // Only a bound, controlled session may ask: an unbound session has no controller, and
            // inventing one would send its question to the wrong project.
            const bound = matchBinding({ sessionId, cwd }, bindings);
            if (!bound.allowed) {
                return { status: "rejected", questionId: "", reason: `not-a-controlled-session:${bound.reason}` };
            }
            const questionId = `collab-${randomUUID()}`;
            sequence += 1;
            // The binding id travels with the question so an answer can be matched to the exact binding,
            // not merely to a session: two bindings may legitimately raise the same local question id.
            const meta = { sessionId, cwd, seq: sequence, askedAt: new Date().toISOString(), question, bindingId: bound.binding.bindingId, controller: bound.binding.controller };
            registry.set(questionId, meta);
            // Durable first: the question is recorded before anyone can answer it, so the log is the
            // record even if this process dies while the tool is still waiting.
            agent.session.append(EVENT_QUESTION, { id: questionId, seq: sequence, question, bindingId: bound.binding.bindingId, controller: bound.binding.controller, ...(typeof args.detail === "string" ? { detail: args.detail } : {}) });
            // Raise the signal AFTER the durable record, so a controller woken by it can always read the
            // event it refers to. The signal carries identity and a reference, never the question body.
            raiseSignal({
                id: `sig-question-${questionId}`,
                controller: bound.binding.controller,
                bindingId: bound.binding.bindingId,
                sessionId,
                cwd,
                kind: "question",
                reference: `collab-question:${questionId}`,
                at: meta.askedAt
            });

            const timeoutMs = Number.isFinite(args.timeoutMs) && args.timeoutMs > 0
                ? Math.min(args.timeoutMs, config.answerTimeoutMs)
                : config.answerTimeoutMs;

            const answer = await new Promise((resolve) => {
                let settled = false;
                /** @param {object} value - the outcome to settle with. */
                const settle = (value) => {
                    if (settled) return;
                    settled = true;
                    waiters.delete(questionId);
                    clearTimeout(timer);
                    exec.signal?.removeEventListener?.("abort", onAbort);
                    resolve(value);
                };
                const timer = setTimeout(() => {
                    // Bounded wait: an unanswered question is left readable and reported, never pinned
                    // forever and never silently dropped.
                    settle({ status: "interrupted", reason: "answer-timeout" });
                }, timeoutMs);
                const onAbort = () => {
                    try { agent.session.append(EVENT_CANCEL, { id: questionId, reason: "caller-cancelled" }); } catch { /* the log may be gone */ }
                    settle({ status: "interrupted", reason: "cancelled" });
                };
                if (exec.signal) {
                    if (exec.signal.aborted) { onAbort(); return; }
                    exec.signal.addEventListener?.("abort", onAbort, { once: true });
                }
                waiters.set(questionId, { settle, sessionId });
            });

            return {
                questionId,
                status: answer.status,
                ...(typeof answer.answer === "string" ? { answer: answer.answer } : {}),
                ...(typeof answer.source === "string" ? { source: answer.source } : {}),
                ...(typeof answer.reason === "string" ? { reason: answer.reason } : {})
            };
        }
    }));

    /**
     * Record one notification durably and raise its signal.
     *
     * Shared by the DS-side tool and the passive `/notify` route, so both paths produce the same event,
     * the same identity fields and the same signal — one producer, not two implementations that can
     * drift. The durable event is the record; the signal and its file are notifications about it.
     *
     * @param {object} input - the notification.
     * @param {object} input.agent - the owning agent.
     * @param {object} input.binding - the binding that owns this session.
     * @param {string} input.kind - "delivery" or "error".
     * @param {string} input.text - short summary.
     * @param {string} [input.goalId] - Goal identity.
     * @param {string} [input.requestId] - request identity.
     * @param {string} input.at - ISO timestamp.
     * @returns {{eventId: string, signalId: string, raised: object}} the produced identities.
     */
    const produceNotification = async ({ agent, binding, kind, text, goalId, requestId, at }) => {
        // A stable event id: retrying the same notification (same binding, kind, goal and request at the
        // same instant is not the identity — the identity is derived from what the notification IS) must
        // not create a second business event. Callers that retry pass the same requestId, so that is the
        // natural identity when present; otherwise a fresh id is right because it is a new notification.
        const eventId = typeof requestId === "string" && requestId.length > 0
            ? `notify-${binding.bindingId}-${requestId}-${kind}`
            : `notify-${randomUUID()}`;
        const signalId = `sig-${eventId}`;
        sequence += 1;
        const record = {
            // `id` is the signal identity every rule keys on; `signalId` is the same value under the name
            // the durable event and the HTTP surface use, so both spellings agree rather than drifting.
            id: signalId,
            signalId,
            eventId,
            bindingId: binding.bindingId,
            controller: binding.controller,
            sessionId: binding.sessionId,
            cwd: binding.cwd,
            kind,
            seq: sequence,
            ...(goalId === undefined ? {} : { goalId }),
            ...(requestId === undefined ? {} : { requestId }),
            reference: `collab-notify:${binding.sessionId}:${at}`,
            at
        };
        // Raise the signal once. Its file projection is published as part of raising it, and the outcome
        // is returned so a caller learns the truth instead of assuming delivery.
        const raised = raiseSignal(record);
        // A signal that could not be raised means the controller will not be woken. The durable event is
        // still written below (so the fact is not lost), but the failure is propagated so no caller can
        // mistake this for a delivered notification.
        if (!raised.ok) {
            ctx.logger.error("codex-bridge: notification %s could not raise a signal: %s", signalId, raised.reason);
        }
        // The durable event carries the SAME identity, so a rebuild after a restart reconstructs this
        // event exactly — including its signalId and cursor — instead of inventing a new identity.
        agent.append(EVENT_NOTIFY, {
            signalId,
            eventId,
            bindingId: binding.bindingId,
            controller: binding.controller,
            sessionId: binding.sessionId,
            cwd: binding.cwd,
            kind,
            seq: record.seq,
            ...(goalId === undefined ? {} : { goalId }),
            ...(requestId === undefined ? {} : { requestId }),
            reference: record.reference,
            text,
            at
        });
        return { eventId, signalId, raised, fileError: raised.ok ? raised.fileError : `signal-not-raised:${raised.reason}` };
    };

    /** The DS-side producer for completion and failure.
     *
     * A delivery or an abnormal stop must be declared by the session that actually did the work, through
     * a formal caller — not inferred from an ordinary finished turn, and not fabricated by whoever is
     * watching. This tool is that caller: it records the notification durably and raises the signal the
     * controller waits on.
     *
     * `error` is also raised automatically when the loop ends a turn with a real terminal error (see the
     * `turn/end` listener below), so an abnormal stop is reported even if the model never gets to call
     * this tool.
     */
    ctx.tools.register(defineTool({
        name: "notify_controller",
        description: "Tell the controlling agent (Codex) that this session's business result is complete, or that it stopped abnormally. A finished turn alone is not a delivery; call this when the work is actually done or has failed.",
        parameters: {
            kind: {
                type: "string",
                required: true,
                description: "delivery for a completed result, error for an abnormal stop."
            },
            text: {
                type: "string",
                description: "Short summary of what completed, or what failed."
            },
            goalId: {
                type: "string",
                description: "Optional Goal identity this result belongs to."
            },
            requestId: {
                type: "string",
                description: "Optional request identity this result answers."
            }
        },
        output: {
            schema: {
                type: "object",
                additionalProperties: false,
                properties: {
                    ok: { type: "boolean", required: true },
                    signalId: { type: "string" },
                    reason: { type: "string" }
                }
            },
            render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }]
        },
        async execute(args, exec) {
            const kind = typeof args.kind === "string" ? args.kind : "";
            if (kind !== "delivery" && kind !== "error") {
                return { ok: false, reason: "kind must be delivery or error" };
            }
            const agent = exec.agent;
            const sessionId = agent && agent.id;
            if (typeof sessionId !== "string" || sessionId.length === 0) {
                return { ok: false, reason: "notify_controller requires a Session identity" };
            }
            const cwd = typeof agent.session?.header?.cwd === "string" ? agent.session.header.cwd : "";
            const bound = matchBinding({ sessionId, cwd }, bindings);
            if (!bound.allowed) {
                return { ok: false, reason: `not-a-controlled-session:${bound.reason}` };
            }
            const at = new Date().toISOString();
            const produced = await produceNotification({
                agent: agent.session,
                binding: bound.binding,
                kind,
                text: typeof args.text === "string" ? args.text : "",
                ...(typeof args.goalId === "string" && args.goalId.length > 0 ? { goalId: args.goalId } : {}),
                ...(typeof args.requestId === "string" && args.requestId.length > 0 ? { requestId: args.requestId } : {}),
                at
            });
            return { ok: true, signalId: produced.signalId };
        }
    }));

    // ---- real terminal failures become error signals -----------------------------------------

    /**
     * Report an ABNORMAL END of a turn as an `error` signal.
     *
     * A normal `turn/end` is explicitly NOT a delivery: the turn ending says nothing about whether the
     * business result is complete, which is why only the session's own `notify_controller` declares a
     * delivery. A turn that ends with a real terminal error, however, is a genuine abnormal stop, and
     * the controller must hear about it even if the model never got to call the tool. This is the
     * automatic half; the tool is the explicit half.
     */
    ctx.on("session/event", (session, event) => {
        try {
            if (event === null || event === undefined || event.type !== "turn/end") return;
            const reason = event.data && event.data.reason;
            if (reason === null || reason === undefined || reason.kind !== "error") return;
            const sessionId = session && typeof session.id === "string" ? session.id : "";
            if (sessionId.length === 0) return;
            const headerCwd = session.header && typeof session.header.cwd === "string" ? session.header.cwd : "";
            const bound = matchBinding({ sessionId, cwd: headerCwd }, bindings);
            if (!bound.allowed) return;
            const message = reason.error && typeof reason.error.message === "string" ? reason.error.message : "";
            const requestId = typeof event.data.requestId === "string" ? event.data.requestId : undefined;
            // Identity is derived from the failure itself, so a re-delivered turn/end for the SAME failed
            // turn raises the SAME signal instead of a second business event.
            //
            // DEFERRED deliberately: `session/event` is emitted from inside the session's own append, and
            // appending from within an observer re-enters the publisher ("session append cannot reenter
            // while another append is being published") and takes the whole host down. Recording the
            // notification on a later tick leaves the append that triggered us to finish first.
            setImmediate(() => {
                produceNotification({
                    agent: session,
                    binding: bound.binding,
                    kind: "error",
                    text: message,
                    ...(requestId === undefined ? {} : { requestId: `turn-error-${requestId}` }),
                    at: new Date().toISOString()
                }).catch((error) => ctx.logger.warn("codex-bridge: could not report a terminal turn failure: %s", messageOf(error)));
            });
        } catch (error) {
            ctx.logger.warn("codex-bridge: could not report a terminal turn failure: %s", messageOf(error));
        }
    });

    // ---- existing passive delivery ----------------------------------------------------------

    /** Sessions the shell currently knows about, used to reject typos instead of queueing into the void. */
    const knownSessions = async () => {
        try {
            const result = await ctx.sessionController.list({});
            const records = (result && (result.sessions || result.items)) || [];
            return records.map((record) => record.sessionId || record.id).filter((id) => typeof id === "string");
        } catch {
            return null;
        }
    };

    /** The Agent's own authoritative busy signal. */
    const agentIsRunning = (sessionId) => {
        try {
            const agent = ctx.agents && typeof ctx.agents.get === "function" ? ctx.agents.get(sessionId) : null;
            if (!agent) return { known: false, running: false };
            const status = typeof agent.status === "string" ? agent.status : null;
            if (status !== null) return { known: true, running: status === "running" };
            return { known: true, running: false };
        } catch {
            return { known: false, running: false };
        }
    };

    const deliver = async (sessionId, text) => {
        const requestId = `codex-bridge-${randomUUID()}`;
        const state = agentIsRunning(sessionId);
        const mode = state.running ? config.busyMode : "queue";
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(new Error("codex-bridge delivery timed out")), DELIVERY_TIMEOUT_MS);
        try {
            const value = await ctx.sessionController.prompt({
                requestId,
                sessionId,
                mode,
                content: [{ type: "text", text }],
                clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone
            }, controller.signal);
            return { requestId, mode, agentKnown: state.known, wasRunning: state.running, accepted: Boolean(value && value.accepted) };
        } finally {
            clearTimeout(timer);
        }
    };

    // ---- routes -----------------------------------------------------------------------------

    /**
     * Collaboration surface.
     *
     * Two independent gates, because they prove different things:
     *
     * 1. `connection.admit` proves the request speaks for THIS deployment's operator off the loopback
     *    interface. It is necessary but NOT sufficient — it maps every accepted request to the same
     *    `operator` peer, so it cannot tell one controller from another.
     * 2. A per-controller CREDENTIAL identifies WHICH controller is calling. The declared bindings name
     *    a credential reference for each controller, and the request must present the matching secret;
     *    the server then uses the controller it resolved, never a name the caller supplied.
     *
     * A `controller` field in a query or body is therefore treated as a claim that must agree with the
     * resolved identity, never as the identity itself. The secret is compared in memory only: it is
     * never logged, echoed, or written to the session.
     */
    const collabHandler = async (request, response) => {
        const admission = ctx.connection && typeof ctx.connection.admit === "function"
            ? ctx.connection.admit(request)
            : null;
        if (admission === null) {
            send(response, 503, { error: "the connecting service is unavailable; refusing to expose control unauthenticated" });
            return;
        }
        if ("rejection" in admission) {
            send(response, admission.rejection, { error: admission.rejection === 401 ? "unauthorized" : "forbidden" });
            return;
        }

        const url = new URL(request.url, "http://127.0.0.1");
        const route = url.pathname.slice(collabBase.length) || "/";
        // Wait for the credential cache before identifying anyone: a request that arrives during the
        // first milliseconds is answered 503 (retryable) rather than 401 (which would wrongly blame the
        // caller's credential).
        if (!controllerAuthReady()) {
            await secretsLoaded;
        }
        // The controller credential arrives in a dedicated header so it never lands in a URL, a log
        // line, or a referrer the way a query parameter would.
        const offered = typeof request.headers["x-controller-token"] === "string" ? request.headers["x-controller-token"] : "";
        const identity = identifyController(offered, bindings, resolveControllerSecret);
        if (!identity.ok) {
            send(response, 401, { error: identity.reason, hint: "present the controller credential in the x-controller-token header" });
            return;
        }
        const controller = identity.controller;
        /**
         * Refuse a request whose stated controller disagrees with the credential it presented.
         * @param {unknown} claimed - the controller name from a query or body.
         * @returns {boolean} whether the claim is absent or matches.
         */
        const claimAgrees = (claimed) => claimed === undefined || claimed === null || claimed === "" || claimed === controller;
        try {
            if (request.method === "GET" && route === "/bindings") {
                // A controller sees its OWN bindings, never a global list, so independent controllers
                // cannot discover each other's sessions. With no controller named, the declared count is
                // reported without identities.
                // The credential already resolved the controller; a stated name must agree with it.
                if (!claimAgrees(url.searchParams.get("controller"))) {
                    send(response, 403, { error: "stated controller does not match the presented credential" });
                    return;
                }
                if (controller.length === 0) {
                    send(response, 200, { count: bindings.length, controllers: [...new Set(bindings.map((b) => b.controller))] });
                    return;
                }
                if (!isKnownController(bindings, controller)) {
                    send(response, 403, { error: "not your binding: controller-not-bound" });
                    return;
                }
                send(response, 200, { bindings: bindingsOf(bindings, controller) });
                return;
            }

            if (request.method === "GET" && route === "/signals") {
                // The pure projection of what this controller is owed, independent of any wait.
                // The credential already resolved the controller; a stated name must agree with it.
                if (!claimAgrees(url.searchParams.get("controller"))) {
                    send(response, 403, { error: "stated controller does not match the presented credential" });
                    return;
                }
                const acknowledgedRaw = url.searchParams.get("acknowledged");
                const acknowledged = acknowledgedRaw === null ? [] : acknowledgedRaw.split(",").filter((id) => id.length > 0);
                if (!isKnownController(bindings, controller)) {
                    send(response, 403, { error: `not your binding: controller-not-bound` });
                    return;
                }
                // Durably confirmed events are excluded for every caller, not only for one that remembers
                // to send its own list, so all views agree on what has been dealt with.
                const deliverable = deliverableSignals([...signals.values()], controller, [...durableConfirmed(), ...acknowledged]);
                send(response, 200, { signals: deliverable, cursor: deliverable.length > 0 ? deliverable[deliverable.length - 1].seq : null });
                return;
            }

            if (request.method === "GET" && route === "/signals/files") {
                // Read the FILE projection directly. The directory is re-read every call, so a missed
                // watcher notification cannot hide an event.
                // The credential already resolved the controller; a stated name must agree with it.
                if (!claimAgrees(url.searchParams.get("controller"))) {
                    send(response, 403, { error: "stated controller does not match the presented credential" });
                    return;
                }
                if (!isKnownController(bindings, controller)) {
                    send(response, 403, { error: "not your binding: controller-not-bound" });
                    return;
                }
                if (inboxRoot === null) {
                    send(response, 200, { configured: false, signals: [], problems: [] });
                    return;
                }
                const dir = inboxDirFor(inboxRoot, controller);
                if (!dir.ok) {
                    send(response, 400, { error: dir.reason });
                    return;
                }
                const snapshot = readSignals(dir.dir);
                send(response, 200, { configured: true, signals: snapshot.signals, problems: snapshot.problems });
                return;
            }

            if (request.method === "POST" && route === "/signals/confirm") {
                // Confirmation is a separate act from delivery: only the caller's explicit confirmation
                // retires an event, and it is idempotent by identity.
                const raw = await readBody(request);
                let body;
                try {
                    body = raw.length > 0 ? JSON.parse(raw) : {};
                } catch {
                    send(response, 400, { error: "body is not JSON" });
                    return;
                }
                // The credential already resolved the controller; a stated name must agree with it.
                if (!claimAgrees(typeof body.controller === "string" ? body.controller : "")) {
                    send(response, 403, { error: "stated controller does not match the presented credential" });
                    return;
                }
                const signalId = typeof body.signalId === "string" ? body.signalId : "";
                if (!isKnownController(bindings, controller)) {
                    send(response, 403, { error: "not your binding: controller-not-bound" });
                    return;
                }
                const known = signals.get(signalId);
                if (known === undefined) {
                    send(response, 404, { error: `unknown signal "${signalId}"` });
                    return;
                }
                // Only the binding that owns the event may confirm it: one controller cannot retire
                // another's event, and a superseded binding cannot retire its successor's.
                if (known.controller !== controller) {
                    send(response, 403, { error: "not your event" });
                    return;
                }
                // Confirmation is DURABLE: it is written as an event on the owning session, so every view
                // (memory, files, and a view rebuilt after a restart) agrees and it survives a restart.
                // It is idempotent by event id, so a repeat is the same outcome.
                const already = durableConfirmed().has(signalId);
                if (!already) {
                    const agent = ctx.agents.get(known.sessionId);
                    if (agent === undefined || agent === null) {
                        send(response, 409, { error: "session-not-live", signalId, hint: "the confirmation could not be recorded; retry once the session is live" });
                        return;
                    }
                    agent.session.append(EVENT_CONFIRM, { signalId, controller, at: new Date().toISOString() });
                }
                // The file is a projection of the same fact, so removing it is part of the same act; a
                // failure to remove it is reported but cannot un-confirm the authoritative record.
                let fileNote = null;
                if (inboxRoot !== null) {
                    const dir = inboxDirFor(inboxRoot, controller);
                    if (dir.ok) confirmSignal(dir.dir, signalId);
                    else fileNote = dir.reason;
                }
                send(response, 200, { ok: true, confirmed: true, idempotent: already, signalId, ...(fileNote === null ? {} : { fileNote }) });
                return;
            }

            if (request.method === "GET" && route === "/wait-any") {
                // Wait across ALL of this controller's bound sessions; the first wakeworthy event wins.
                // Backlog returns immediately, so a controller that was away does not wait at all.
                // The credential already resolved the controller; a stated name must agree with it.
                if (!claimAgrees(url.searchParams.get("controller"))) {
                    send(response, 403, { error: "stated controller does not match the presented credential" });
                    return;
                }
                const sinceRaw = url.searchParams.get("since");
                const since = sinceRaw === null ? undefined : Number(sinceRaw);
                const waitMs = Math.min(Math.max(Number(url.searchParams.get("waitMs") ?? 30_000) || 30_000, 0), 120_000);
                const acknowledgedRaw = url.searchParams.get("acknowledged");
                const acknowledged = acknowledgedRaw === null ? [] : acknowledgedRaw.split(",").filter((id) => id.length > 0);
                const maxBatch = Math.min(Math.max(Number(url.searchParams.get("maxBatch") ?? 50) || 50, 1), 200);
                if (!isKnownController(bindings, controller)) {
                    send(response, 403, { error: "not your binding: controller-not-bound" });
                    return;
                }
                /** Read the current outcome across ALL of this controller's bindings. */
                const current = () => waitOutcome({
                    // A delivery is a production-declared completion, so it is wake-worthy like any other
                    // event. There is no caller-supplied "deliveryComplete" switch here: letting the
                    // CONSUMER declare whether the producer finished inverted the contract, and meant a
                    // controller could not be woken by the very event it exists to receive.
                    signals: [...signals.values()],
                    controller,
                    acknowledged: [...durableConfirmed(), ...acknowledged],
                    since,
                    maxBatch
                });
                const immediate = current();
                if (immediate.status === "signals") {
                    send(response, 200, { signals: immediate.signals, cursor: immediate.cursor, more: immediate.more, waited: false });
                    return;
                }
                const deadline = Date.now() + waitMs;
                let outcome = immediate;
                while (Date.now() < deadline && outcome.status === "empty") {
                    // A bounded wait, woken by a new signal rather than by polling each session in turn.
                    await new Promise((resolve) => {
                        let done = false;
                        /** @param {number} ms - how long to sleep at most. */
                        const finish = () => { if (!done) { done = true; signalWaiters.delete(wake); clearTimeout(timer); resolve(); } };
                        const wake = () => finish();
                        const timer = setTimeout(finish, 500);
                        signalWaiters.add(wake);
                    });
                    outcome = current();
                }
                if (outcome.status === "signals") send(response, 200, { signals: outcome.signals, cursor: outcome.cursor, more: outcome.more, waited: true });
                // A deadline is explicitly NOT an answer, an approval or a failure.
                else send(response, 200, { signals: [], waited: true, empty: true, reason: "no-new-events" });
                return;
            }

            if (request.method === "GET" && route === "/questions") {
                const sessionId = url.searchParams.get("sessionId") || "";
                // The credential already resolved the controller; a stated name must agree with it.
                if (!claimAgrees(url.searchParams.get("controller"))) {
                    send(response, 403, { error: "stated controller does not match the presented credential" });
                    return;
                }
                const sinceRaw = url.searchParams.get("since");
                const since = sinceRaw === null ? undefined : Number(sinceRaw);
                const matched = matchBinding({ sessionId, controller }, bindings);
                if (!matched.allowed) {
                    send(response, 403, { error: `not your binding: ${matched.reason}` });
                    return;
                }
                const pending = pendingQuestions(listForBinding(matched.binding), since);
                send(response, 200, {
                    questions: pending,
                    cursor: pending.length > 0 ? pending[pending.length - 1].seq : (Number.isFinite(since) ? since : null)
                });
                return;
            }

            if (request.method === "GET" && route === "/wait") {
                // Backlog first, then a bounded wait for new work. No permanent connection and no
                // unbounded queue: the caller gets a cursor and may reconnect at it.
                const sessionId = url.searchParams.get("sessionId") || "";
                // The credential already resolved the controller; a stated name must agree with it.
                if (!claimAgrees(url.searchParams.get("controller"))) {
                    send(response, 403, { error: "stated controller does not match the presented credential" });
                    return;
                }
                const sinceRaw = url.searchParams.get("since");
                const since = sinceRaw === null ? undefined : Number(sinceRaw);
                const waitMs = Math.min(Math.max(Number(url.searchParams.get("waitMs") ?? 30_000) || 30_000, 0), 120_000);
                const matched = matchBinding({ sessionId, controller }, bindings);
                if (!matched.allowed) {
                    send(response, 403, { error: `not your binding: ${matched.reason}` });
                    return;
                }
                const immediate = pendingQuestions(listForBinding(matched.binding), since);
                if (immediate.length > 0) {
                    send(response, 200, { questions: immediate, cursor: immediate[immediate.length - 1].seq, waited: false });
                    return;
                }
                const deadline = Date.now() + waitMs;
                let found = [];
                while (Date.now() < deadline && found.length === 0) {
                    await new Promise((resolve) => setTimeout(resolve, 250));
                    found = pendingQuestions(listForBinding(matched.binding), since);
                }
                send(response, 200, {
                    questions: found,
                    cursor: found.length > 0 ? found[found.length - 1].seq : (Number.isFinite(since) ? since : null),
                    waited: true
                });
                return;
            }

            if (request.method === "POST" && route === "/answer") {
                const raw = await readBody(request);
                let body;
                try {
                    body = raw.length > 0 ? JSON.parse(raw) : {};
                } catch {
                    send(response, 400, { error: "body is not JSON" });
                    return;
                }
                const questionId = typeof body.questionId === "string" ? body.questionId : "";
                const text = typeof body.text === "string" ? body.text : "";
                // A stated controller must agree with the credential, so a request that names one
                // controller while presenting another's credential is refused outright rather than
                // silently treated as the credential's owner.
                if (!claimAgrees(typeof body.controller === "string" ? body.controller : "")) {
                    send(response, 403, { error: "stated controller does not match the presented credential" });
                    return;
                }
                const meta = registry.get(questionId);
                if (meta === undefined) {
                    send(response, 404, { error: `unknown question "${questionId}"` });
                    return;
                }
                // Exact binding match: the question's OWN bindingId must be the caller's, so a controller
                // that owns a different binding cannot answer this question even for the same session,
                // and a superseded binding cannot answer for its successor.
                const matched = matchBinding(
                    { sessionId: meta.sessionId, cwd: meta.cwd, controller, bindingId: meta.bindingId },
                    bindings
                );
                if (!matched.allowed) {
                    send(response, 403, { error: `not your binding: ${matched.reason}` });
                    return;
                }
                // The source is written by the SERVER. A caller cannot label machine output as the human,
                // so any supplied value is ignored rather than trusted.
                const source = ANSWER_SOURCES[0];
                const state = stateOfQuestion(meta.sessionId, questionId);
                const verdict = answerVerdict(state, { text, source });
                if (verdict.action === "reject" || verdict.action === "conflict") {
                    send(response, 409, { error: verdict.reason, action: verdict.action, questionId });
                    return;
                }
                if (verdict.action === "idempotent") {
                    // The identical answer again is the same outcome, not a second delivery.
                    send(response, 200, { ok: true, idempotent: true, questionId, answer: state.answer });
                    return;
                }
                const agent = ctx.agents.get(meta.sessionId);
                if (agent === undefined || agent === null) {
                    // The Session is no longer live in this process: record nothing and tell the
                    // controller to resume by identity rather than pretend the answer landed.
                    send(response, 409, { error: "session-not-live", questionId, hint: "the question stays readable; resume it in a session that owns this id" });
                    return;
                }
                agent.session.append(EVENT_ANSWER, { id: questionId, text, source, controller: matched.binding.controller, at: new Date().toISOString() });
                const waiter = waiters.get(questionId);
                if (waiter !== undefined) {
                    // Resume the SAME tool call. Nothing already executed is replayed: the loop simply
                    // receives the tool result it was waiting for.
                    waiter.settle({ status: "answered", answer: text, source });
                }
                send(response, 200, { ok: true, questionId, delivered: waiter !== undefined, answer: { text, source } });
                return;
            }

            if (request.method === "POST" && route === "/notify") {
                const raw = await readBody(request);
                let body;
                try {
                    body = raw.length > 0 ? JSON.parse(raw) : {};
                } catch {
                    send(response, 400, { error: "body is not JSON" });
                    return;
                }
                const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
                // The credential already resolved the controller; a stated name must agree with it.
                if (!claimAgrees(typeof body.controller === "string" ? body.controller : "")) {
                    send(response, 403, { error: "stated controller does not match the presented credential" });
                    return;
                }
                const kind = typeof body.kind === "string" ? body.kind : "";
                const matched = matchBinding({ sessionId, controller }, bindings);
                if (!matched.allowed) {
                    send(response, 403, { error: `not your binding: ${matched.reason}` });
                    return;
                }
                if (kind !== "delivery" && kind !== "error") {
                    send(response, 400, { error: "kind must be delivery or error" });
                    return;
                }
                const agent = ctx.agents.get(sessionId);
                if (agent === undefined || agent === null) {
                    send(response, 409, { error: "session-not-live", sessionId });
                    return;
                }
                // The SAME producer the DS tool uses, so the passive route cannot drift from it.
                const produced = await produceNotification({
                    agent: agent.session,
                    binding: matched.binding,
                    kind,
                    text: typeof body.text === "string" ? body.text : "",
                    ...(typeof body.goalId === "string" && body.goalId.length > 0 ? { goalId: body.goalId } : {}),
                    ...(typeof body.requestId === "string" && body.requestId.length > 0 ? { requestId: body.requestId } : {}),
                    at: new Date().toISOString()
                });
                // The durable event is already written, so a failing FILE projection is reported rather
                // than hidden behind a 200: the caller must know its controller may not be reliably
                // notified, and the stable event id makes its retry safe.
                if (produced.fileError !== undefined) {
                    send(response, 502, {
                        error: "notification recorded and signalled, but its file projection failed",
                        sessionId, kind, signalId: produced.signalId, fileError: produced.fileError,
                        hint: "retry this same notification; the event id is stable so no second business event is created"
                    });
                    return;
                }
                send(response, 200, { ok: true, sessionId, kind, signalId: produced.signalId, bindingId: matched.binding.bindingId });
                return;
            }

            send(response, 404, { error: `no route for ${request.method} ${route}` });
        } catch (error) {
            send(response, 500, { error: messageOf(error) });
        }
    };

    /** The original passive route, unchanged in behaviour. */
    const handler = async (request, response) => {
        if (!isLoopback(request)) {
            send(response, 403, { error: "the bridge only accepts loopback callers" });
            return;
        }
        if (!sameOrigin(request)) {
            send(response, 403, { error: "cross-origin request refused" });
            return;
        }
        const url = new URL(request.url, "http://127.0.0.1");
        const route = url.pathname.slice(base.length) || "/";
        try {
            if ((request.method === "GET" || request.method === "HEAD") && route === "/health") {
                send(response, 200, {
                    ok: true,
                    bridge: "codex-bridge",
                    base,
                    collabBase,
                    busyMode: config.busyMode,
                    bindings: bindings.length,
                    inboxRoot: inboxRoot === null ? null : inboxRoot,
                    routes: [
                        "GET " + base + "/health",
                        "GET " + base + "/sessions",
                        "POST " + base + "/send",
                        "GET " + collabBase + "/bindings",
                        "GET " + collabBase + "/questions",
                        "GET " + collabBase + "/wait",
                        "POST " + collabBase + "/answer",
                        "POST " + collabBase + "/notify",
                        "GET " + collabBase + "/signals",
                        "GET " + collabBase + "/signals/files",
                        "POST " + collabBase + "/signals/confirm",
                        "GET " + collabBase + "/wait-any"
                    ]
                });
                return;
            }
            if ((request.method === "GET" || request.method === "HEAD") && route === "/sessions") {
                const ids = await knownSessions();
                send(response, 200, { sessions: ids === null ? [] : ids, available: ids !== null });
                return;
            }
            if (request.method === "POST" && route === "/send") {
                const raw = await readBody(request);
                let body;
                try {
                    body = raw.length > 0 ? JSON.parse(raw) : {};
                } catch {
                    send(response, 400, { error: "body is not JSON" });
                    return;
                }
                const sessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : "";
                const text = typeof body.text === "string" ? body.text : "";
                if (!sessionId) { send(response, 400, { error: "sessionId is required" }); return; }
                if (text.trim().length === 0) { send(response, 400, { error: "text must contain non-whitespace" }); return; }
                if (text.length > MAX_TEXT_CHARS) { send(response, 413, { error: `text exceeds ${MAX_TEXT_CHARS} characters` }); return; }
                if (config.requireKnownSession) {
                    const ids = await knownSessions();
                    if (ids !== null && !ids.includes(sessionId)) {
                        send(response, 404, { error: `unknown session "${sessionId}"`, hint: "GET " + base + "/sessions lists the ids this shell can reach" });
                        return;
                    }
                }
                const result = await deliver(sessionId, text);
                send(response, 200, { ok: true, sessionId, ...result });
                return;
            }
            send(response, 404, { error: `no route for ${request.method} ${route}` });
        } catch (error) {
            send(response, 500, { error: messageOf(error) });
        }
    };

    ctx.effect(() => ctx.webServer.register({ kind: "prefix", path: base, handler }), `codex-bridge: ${base}`);
    ctx.effect(() => ctx.webServer.register({ kind: "prefix", path: collabBase, handler: collabHandler }), `codex-bridge: ${collabBase}`);
    ctx.effect(() => () => {
        // End our own waits on disposal so no promise outlives the plugin, and release every signal
        // waiter so a blocked caller returns instead of hanging on a disposed bridge.
        for (const [id, waiter] of waiters) waiter.settle({ status: "interrupted", reason: "bridge-disposed" });
        waiters.clear();
        for (const wake of [...signalWaiters]) wake();
        signalWaiters.clear();
        registry.clear();
        signals.clear();
    }, "codex-bridge: drain waiters");
    ctx.logger.info("codex-bridge listening on %s and %s (%d bindings)", base, collabBase, bindings.length);
}

/** Loopback-only guard for the passive route. */
function isLoopback(request) {
    const address = request.socket && request.socket.remoteAddress;
    return typeof address === "string" && LOOPBACK.has(address);
}

/** Same-origin guard: a browser-supplied Origin must match the Host that served this route. */
function sameOrigin(request) {
    const origin = request.headers.origin;
    if (typeof origin !== "string" || origin.length === 0) return true;
    try {
        return new URL(origin).host === request.headers.host;
    } catch {
        return false;
    }
}
