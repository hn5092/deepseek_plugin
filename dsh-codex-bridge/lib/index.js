import { randomUUID } from "node:crypto";
import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import {
    ANSWER_SOURCES,
    answerVerdict,
    assertSingleOwner,
    bindingsOf,
    controllerIdentities,
    identifyController,
    isKnownController,
    matchBinding,
    normalizeBinding,
    pendingQuestions,
    questionStateOf,
    sameDirectory
} from "./collab.js";
import { deliverableSignals, waitOutcome } from "./signals.js";
import { inboxDirFor, readSignals } from "./inbox.js";
import { BridgeState, QUESTION_STATE, signalView } from "./state.js";

/** Cordis plugin name; the profile patch row id stays independent of it. */
export const name = "codex-bridge";

/**
 * Host services the bridge needs.
 *
 * `tools` registers the model-facing tools; `connection` supplies the shell's real admission fence;
 * `credentials` resolves each controller's credential REFERENCE to its value (the bridge stores no
 * secret itself); `sessionController`/`agents` keep message delivery and live-session lookup working;
 * `configEditor` is the shell's OWN owner for persisting plugin configuration, used so a binding can be
 * added or retired at runtime without this plugin inventing a second, writable binding store.
 * Every service read here is declared, because Cordis throws on an undeclared access.
 */
export const inject = ["webServer", "sessionController", "agents", "tools", "connection", "credentials", "configEditor"];

/** Refuse oversized request bodies instead of buffering them. */
const MAX_BODY_BYTES = 256 * 1024;
/** Longest accepted message. A bridge is for instructions, not for shipping files. */
const MAX_TEXT_CHARS = 100_000;
/** Bound on one admission, so a wedged session cannot hang the caller's curl. */
const DELIVERY_TIMEOUT_MS = 30_000;
/** Only a loopback caller may drive a session by default. */
const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/**
 * The durable event types this plugin owns.
 *
 * These names are used ONLY as labels inside the plugin's own store. They are deliberately NOT written
 * into the Session log: this harness refuses to read a session log containing an event type it does not
 * know unless the event carries an `ignorable` marker, and `Session.append` exposes no way to set that
 * marker, so a custom event written there would make the session permanently unreadable (verified on a
 * real stop/restart: `session "..." contains event type "collab/notify" ... refusing to interpret the
 * log`). Plugin state therefore lives in this plugin's own durable store, never in the session log.
 */
const EVENT_QUESTION = "collab/question";
const EVENT_ANSWER = "collab/answer";
const EVENT_CANCEL = "collab/cancel";

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
     *
     * This list is VOLATILE on purpose. A controller that starts a new session must be able to add or
     * retire one binding WITHOUT the plugin being torn down and re-applied, because a remount would
     * abandon every in-flight question — including other controllers' pending questions, which are not
     * this controller's to interrupt. A volatile field is committed into the running instance by the
     * Loader instead of triggering a restart, so the change takes effect live and in-flight work
     * survives. The on-disk configuration is still the one authority: the value is written through the
     * shell's own config editor, and this instance reads the committed value.
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
    })).default([]).volatile(),
    /**
     * Controller identities: which credential reference authenticates which control party.
     *
     * These are declared SEPARATELY from `bindings`, because a credential belongs to the controller and not
     * to any one session. Retiring a controller's last binding must not retire the controller: if identity
     * came from `bindings`, that party would become unauthenticatable and could never bind again with the
     * same credential. Kept volatile for the same reason as `bindings` — a controller may be added or
     * re-pointed while the bridge runs, and that must not tear down anyone's in-flight questions.
     *
     * A deployment written before this list existed still works: identities are also derived from the
     * declared bindings, so an upgrade cannot lock out a controller that is already bound.
     */
    controllers: z.array(z.object({
        controller: z.string(),
        tokenRef: z.string()
    })).default([]).volatile(),
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
    /**
     * Root of this plugin's own durable store.
     *
     * It cannot be the Session log: this harness refuses to read a log containing an event type it does
     * not know unless the event carries `ignorable: true`, and `Session.append` cannot set that marker,
     * so a custom event there makes the session unreadable. Defaults to the inbox root, since the file
     * inbox is already the durable notification surface the operator approved.
     */
    storeRoot: z.string().default(""),
    /** How long a signal may be retained before it becomes prunable. */
    inboxMaxAgeMs: z.number().default(7 * 24 * 60 * 60 * 1000),
    /** How many signals one inbox always keeps, newest first. */
    inboxMaxEvents: z.number().default(500)
});

/**
 * Validate the retention bounds.
 *
 * These are the numbers that decide when a finished record may be reclaimed, so a nonsensical value is
 * refused at startup rather than silently producing a store that either grows forever or starts
 * discarding work: an age must be a finite non-negative integer, and the retained window must be at
 * least one record. `maxEvents: 0` would make every finished record reclaimable the moment it was
 * confirmed, which is not a retention policy.
 *
 * @param {{inboxMaxAgeMs: unknown, inboxMaxEvents: unknown}} config - the plugin configuration.
 * @returns {{ok: true} | {ok: false, reason: string}} the verdict.
 */
export function validateRetention({ inboxMaxAgeMs, inboxMaxEvents }) {
    if (!Number.isSafeInteger(inboxMaxAgeMs) || inboxMaxAgeMs < 0) {
        return { ok: false, reason: `inboxMaxAgeMs must be a non-negative integer, got ${String(inboxMaxAgeMs)}` };
    }
    if (!Number.isSafeInteger(inboxMaxEvents) || inboxMaxEvents < 1) {
        return { ok: false, reason: `inboxMaxEvents must be an integer of at least 1, got ${String(inboxMaxEvents)}` };
    }
    return { ok: true };
}
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

    // A nonsensical retention bound is refused outright: it decides when finished records may be
    // reclaimed, and silently accepting a negative age or an empty retained window would produce a store
    // that either never bounds itself or discards work.
    const retentionCheck = validateRetention(config);
    if (!retentionCheck.ok) {
        throw new Error(`codex-bridge: refusing to start: ${retentionCheck.reason}`);
    }

    /**
     * The declared bindings, as a LIVE value.
     *
     * The config field is volatile, so the Loader commits a new list into this same instance rather than
     * remounting the plugin. Everything below therefore reads through `currentBindings()` instead of
     * closing over a snapshot taken at apply time — otherwise a newly bound session would be written to
     * disk and still be invisible to the running instance.
     */
    const currentBindings = () => {
        const raw = config.bindings;
        // A volatile field arrives as a reference with a `get()`; an ordinary one arrives as the value.
        const list = raw && typeof raw.get === "function" ? raw.get() : raw;
        return Array.isArray(list) ? list : [];
    };

    /** The declared controller identities, read live for the same reason `bindings` is. */
    const currentControllers = () => {
        const raw = config.controllers;
        const list = raw && typeof raw.get === "function" ? raw.get() : raw;
        return Array.isArray(list) ? list : [];
    };

    /**
     * The effective bindings, rebuilt whenever the configuration changes.
     *
     * `let` rather than `const` is the whole point: the volatile update commits a new list into THIS
     * instance, so the binding set has to be re-derived in place. Every caller below reads `bindings` at
     * call time, so reassigning here is what makes an incrementally added binding visible to the tools and
     * the routes without a remount.
     */
    let bindings = [];
    /**
     * The effective controller identities, rebuilt with the bindings.
     *
     * This is the authority for authentication. It is derived from the declared `controllers` list AND the
     * bindings, so a controller keeps its identity after its last binding is retired, while a deployment
     * that predates the list still authenticates through its bindings.
     */
    let identities = [];
    const rebuildBindings = () => {
        const next = [];
        for (const raw of currentBindings()) {
            const normalized = normalizeBinding(raw);
            if (normalized.ok) next.push(normalized.binding);
            else ctx.logger.warn("codex-bridge: ignoring invalid binding (%s): %o", normalized.reason, raw);
        }
        // One session may have exactly one effective answer owner. Two owners would make an answer
        // ambiguous and could produce two terminal outcomes for one tool call, so an ambiguous session is
        // refused outright — its bindings are dropped, leaving it with NO answer owner rather than two. A
        // handover is expressed by marking the predecessor `current: false`.
        const ownership = assertSingleOwner(next);
        if (!ownership.ok) {
            ctx.logger.error("codex-bridge: %s; refusing every binding for that session", ownership.reason);
            for (let i = next.length - 1; i >= 0; i -= 1) {
                if (next[i].sessionId === ownership.sessionId) next.splice(i, 1);
            }
        }
        bindings = next;
        // Identities are rebuilt AFTER the bindings, so a binding dropped for a double-owner conflict can
        // still contribute its identity (an ambiguous session has no answer owner, but its controller is
        // still a known party).
        identities = controllerIdentities(currentControllers(), currentBindings());
        return bindings;
    };
    rebuildBindings();

    // A volatile config change is delivered as an event on the owning fiber. Rebuilding here is what
    // carries an incremental bind/unbind into the running plugin, and it deliberately does NOT touch any
    // waiter: in-flight questions belong to whoever asked them and are not this change's to interrupt.
    ctx.on("loader/volatile-update", (paths) => {
        const touched = (name) => Array.isArray(paths) && paths.some((entry) => Array.isArray(entry) && entry[0] === name);
        if (!touched("bindings") && !touched("controllers")) return;
        rebuildBindings();
        // A binding may name a credential reference this instance has not seen yet, so the cache is
        // refreshed from the live list. The resolution is asynchronous but nothing waits on it: a request
        // that arrives first is simply refused as unauthenticated, which is the safe direction.
        void loadControllerSecrets();
        ctx.logger.info("codex-bridge: bindings updated live (%d declared)", bindings.length);
    });

    /**
     * The collaboration state owner.
     *
     * Every fact this bridge keeps is ONE record with two independent axes — whether the controller has
     * confirmed being told, and whether the work itself is finished — and that owner is responsible for
     * the record, its transitions, its identity and its file projection. This host half only routes
     * requests into it and renders what it reports; it keeps no state of its own that could disagree.
     *
     * See `lib/state.js` for why one record replaced three files, and why the session log is not used.
     */
    const state = new BridgeState({
        storeRoot: config.storeRoot.length > 0 ? config.storeRoot : config.inboxRoot,
        inboxRoot: config.inboxRoot,
        logger: ctx.logger,
        // The validated bounds are injected ONCE, here, so the owner judges expiry and reclamation by the
        // operator's configuration from its very first read — not by a default until some later path runs.
        retention: { maxAgeMs: config.inboxMaxAgeMs, maxEvents: config.inboxMaxEvents }
    });
    /** The configured inbox root, or null when file signalling is not configured. */
    const inboxRoot = config.inboxRoot.length > 0 ? config.inboxRoot : null;
    /** Resolvers waiting on ANY bound session, so one new signal can wake several waits. */
    const signalWaiters = new Set();
    state.onChange = () => { for (const wake of [...signalWaiters]) wake(); };

    if (state.store.available) {
        const probe = state.store.probeWritable();
        if (!probe.ok) ctx.logger.error("codex-bridge: the durable store is not writable (%s); transfers will be refused rather than lost", probe.reason);
    }

    /**
     * Load the authoritative records BEFORE anything can write.
     *
     * This runs at the top of `apply`, ahead of registering the tools, the native-event observer and the
     * routes, because those are all producers: a producer that ran against an empty cache could publish
     * into it and then overwrite a durable record it never read. The failure this prevents is concrete —
     * after a restart the model's `notify_controller` call or a native event can arrive before the
     * controller's first GET, and a cache that was never loaded would then lose an existing confirmation.
     *
     * A store that cannot be read is NOT treated as empty. Continuing with empty state would rewrite
     * records from an empty basis, so production is refused outright and the writes report that the
     * bridge is not ready instead of silently acting on state it does not have.
     */
    const initialLoad = state.load();
    let stateReady = initialLoad.ok;
    if (!initialLoad.ok) {
        ctx.logger.error(
            "codex-bridge: refusing to serve: the durable store could not be loaded (%s, %d record(s) read); production is disabled until it can be read",
            initialLoad.reason, initialLoad.loaded
        );
    } else {
        ctx.logger.info("codex-bridge: loaded %d record(s) from the durable store before exposing any producer", initialLoad.loaded);
    }
    /** @type {{ok: boolean, loaded: number, problems: ReadonlyArray<object>, reason?: string}} */
    let loaded = initialLoad;

    /**
     * Refuse a production write while the authoritative state is not loaded.
     *
     * @returns {{ok: true} | {ok: false, reason: string}} whether production may proceed.
     */
    const requireReady = () => (stateReady ? { ok: true } : { ok: false, reason: `store-not-loaded:${loaded.reason ?? "unknown"}` });

    /**
     * The question state a controller reads, derived from the ONE record.
     *
     * The fold in `collab.js` works on typed events; a record is converted to that same shape so the
     * identical rules apply to a live question and to one read back after a restart.
     *
     * @param {string} questionId - the question.
     * @returns {{status: string, answer?: object, reason?: string}} the state.
     */
    const stateOfQuestion = (questionId) => {
        const record = state.get(questionId);
        if (record === null || record.kind !== "question") return { status: "unknown", reason: "question-not-recorded" };
        if (record.business === "answered") return { status: "answered", answer: record.answer ?? { text: "", source: "codex" } };
        if (record.business === "cancelled") return { status: "cancelled", reason: record.cancelReason ?? "cancelled" };
        if (record.business === "expired") return { status: "cancelled", reason: "expired" };
        return { status: "pending" };
    };

    // ---- controller-facing view -------------------------------------------------------------

    /** Every question this process knows about, with its folded state, for one binding. */
    const listForBinding = (binding) => {
        return state.all()
            .filter((record) => record.sessionId === binding.sessionId && record.kind === "question")
            .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))
            .map((record) => ({
                id: record.id,
                sessionId: record.sessionId,
                cwd: record.cwd,
                seq: record.seq,
                askedAt: record.createdAt,
                question: record.question ?? record.text ?? "",
                bindingId: record.bindingId,
                state: stateOfQuestion(record.id)
            }));
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
        // References come from the IDENTITIES, not from the bindings: a controller whose last binding was
        // retired — or one that has not bound anything yet — must still be able to authenticate, and its
        // secret would otherwise never be resolved.
        const refs = [...new Set(identities.map((entry) => entry.tokenRef).filter((ref) => typeof ref === "string" && ref.length > 0))];
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
                    reason: { type: "string" },
                    deliveryWarning: { type: "string" }
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
            // A question is a producer like any other, so it too is refused while the authoritative state
            // could not be loaded: asking into an unread state would record a question against an empty
            // basis and could hide an existing one.
            const readiness = requireReady();
            if (!readiness.ok) {
                return { status: "rejected", questionId: "", reason: readiness.reason };
            }
            // ONE call records the question as a single atomic record carrying both axes: the business
            // state starts `pending` and the notification starts `outstanding`. The owner persists before
            // it publishes, so a question that could not be recorded is never asked at all.
            const published = state.publish({
                kind: "question",
                bindingId: bound.binding.bindingId,
                controller: bound.binding.controller,
                sessionId,
                cwd,
                text: question,
                reference: `collab-question`,
                sourceIdentity: typeof args.detail === "string" ? { detail: args.detail } : {}
            });
            if (!published.ok) {
                return { status: "rejected", questionId: "", reason: `question-not-recorded:${published.reason}` };
            }
            const questionId = published.record.id;
            // The record's question text is what a controller reads; keep it on the record itself.
            state.store.putRecord({ ...published.record, question });
            const record = state.get(questionId) ?? published.record;
            // The record is durable. If its FILE could not be written, the controller can still be reached
            // through the API, so the question is NOT withdrawn — but the tool reports the degraded
            // delivery instead of pretending the notification was reliable.
            const fileWarning = published.fileError === undefined
                ? null
                : `question-signal-file-not-delivered:${published.fileError}`;
            if (fileWarning !== null) {
                ctx.logger.warn("codex-bridge: question %s recorded but its notification file failed: %s", questionId, published.fileError);
            }

            const timeoutMs = Number.isFinite(args.timeoutMs) && args.timeoutMs > 0
                ? Math.min(args.timeoutMs, config.answerTimeoutMs)
                : config.answerTimeoutMs;

            /** Settles this call exactly once, whatever ends it. */
            let disposeWaiter = () => {};
            const answer = await new Promise((resolve) => {
                let settled = false;
                /** @param {object} value - the outcome to settle with. */
                const settle = (value) => {
                    if (settled) return;
                    settled = true;
                    disposeWaiter();
                    clearTimeout(timer);
                    exec.signal?.removeEventListener?.("abort", onAbort);
                    resolve(value);
                };
                const timer = setTimeout(() => {
                    // A bounded wait. Timing out is a real business outcome, not merely a dropped promise:
                    // the record is marked `expired` so a later answer is recognizably too late and a
                    // restart can see that this question was never answered. Recording the outcome and
                    // settling the wait are ONE call, so the timeout also runs retention at this terminal
                    // boundary rather than waiting for a confirmation that may never come.
                    state.settleBusiness(questionId, { business: "expired" });
                    settle({ status: "interrupted", reason: "answer-timeout" });
                }, timeoutMs);
                const onAbort = () => {
                    // Cancellation is likewise a durable business outcome, so a late answer is refused
                    // rather than looking like the first answer to a live question.
                    state.settleBusiness(questionId, { business: "cancelled" });
                    settle({ status: "interrupted", reason: "cancelled" });
                };
                if (exec.signal) {
                    if (exec.signal.aborted) { onAbort(); return; }
                    exec.signal.addEventListener?.("abort", onAbort, { once: true });
                }
                disposeWaiter = state.registerWaiter(questionId, settle);
            });

            return {
                questionId,
                status: answer.status,
                ...(typeof answer.answer === "string" ? { answer: answer.answer } : {}),
                ...(typeof answer.source === "string" ? { source: answer.source } : {}),
                ...(typeof answer.reason === "string" ? { reason: answer.reason } : {}),
                // A degraded notification is reported in the RESULT, so the model can see that the
                // controller's file inbox is not working even though the question itself is fine.
                ...(fileWarning === null ? {} : { deliveryWarning: fileWarning })
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
     * @param {string} [input.issuedAt] - the ORIGINAL issue time of a retried event, from its envelope.
     * @param {string} input.at - ISO timestamp.
     * @returns {{eventId: string, signalId: string, raised: object}} the produced identities.
     */
    const produceNotification = async ({ agent, binding, kind, text, goalId, requestId, issuedAt, at }) => {
        // A caller that retries names the SAME event. Inside the retention window the record is still here
        // and the retry is idempotent WITHOUT the caller having to supply anything. Beyond that window the
        // record is gone for good, and then:
        //
        //   - the caller MAY present the original issue time, and is told the event expired;
        //   - the caller may NOT present just the bare string, because that would mint a fresh event that
        //     merely reuses an old identifier and would meet a controller as new work;
        //   - the caller must NOT substitute the retry's own time, which is why `issuedAt` travels from
        //     the envelope rather than being invented here.
        //
        // A NEW notification carries no `requestId` at all and lets the server allocate its identity, so an
        // ordinary caller never has to write an internal sequence number.
        const knownId = typeof requestId === "string" && requestId.length > 0
            ? `notify-${binding.bindingId}-${requestId}-${kind}`
            : undefined;
        const published = state.publish({
            kind: kind === "error" ? "error" : "delivery",
            bindingId: binding.bindingId,
            controller: binding.controller,
            sessionId: binding.sessionId,
            cwd: binding.cwd,
            text,
            ...(knownId === undefined ? {} : { id: knownId }),
            // The envelope's original time is the ONLY accepted issue time for a retried id.
            ...(issuedAt === undefined ? {} : { issuedAt }),
            ...(at === undefined ? {} : { at }),
            sourceIdentity: {
                ...(goalId === undefined ? {} : { goalId }),
                ...(requestId === undefined ? {} : { requestId })
            }
        });
        if (!published.ok) {
            ctx.logger.error("codex-bridge: notification for %s could not be published: %s", binding.sessionId, published.reason);
            return {
                eventId: knownId ?? "",
                signalId: "",
                raised: { ok: false, reason: published.reason },
                fileError: `${published.expired === true ? "event-expired" : published.rejected === true ? "event-id-not-retryable" : "record-not-persisted"}:${published.reason}`
            };
        }
        // The DURABLE record is what makes the event recoverable, and the FILE is only how a controller
        // may be notified. They are reported separately on purpose: a successful durable write is not
        // invalidated by a failed notification file, and a caller must be able to tell which failed.
        return {
            eventId: knownId ?? published.record.id,
            signalId: published.record.id,
            raised: { ok: true, signal: signalView(published.record), duplicate: published.duplicate },
            fileError: published.fileError
        };
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
                description: "Optional identity of an event being RETRIED. Omit it for a new notification and the server allocates the identity."
            },
            issuedAt: {
                type: "string",
                description: "Required when retrying a requestId: the ORIGINAL issue time from that event's envelope. Never the time of the retry."
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
            // A producer is refused while authoritative state could not be loaded, so a restart cannot
            // record into, and thereby overwrite, state it never read.
            const readiness = requireReady();
            if (!readiness.ok) {
                return { ok: false, reason: readiness.reason };
            }
            const at = new Date().toISOString();
            const produced = await produceNotification({
                agent: agent.session,
                binding: bound.binding,
                kind,
                text: typeof args.text === "string" ? args.text : "",
                ...(typeof args.goalId === "string" && args.goalId.length > 0 ? { goalId: args.goalId } : {}),
                ...(typeof args.requestId === "string" && args.requestId.length > 0 ? { requestId: args.requestId } : {}),
                // A retry must present the event's ORIGINAL issue time; the schema requires it alongside
                // requestId and the owner refuses a retried id without one.
                ...(typeof args.issuedAt === "string" && args.issuedAt.length > 0 ? { issuedAt: args.issuedAt } : {}),
                at
            });
            // The tool's contract is to tell the MODEL the truth. Reporting success when the durable
            // record or the signal failed would let the session believe its controller was notified, so
            // each failure is propagated with its own reason instead of being collapsed into ok:true.
            if (!produced.raised.ok) {
                return { ok: false, reason: `notification-signal-not-raised:${produced.raised.reason}`, signalId: produced.signalId };
            }
            if (produced.fileError !== undefined) {
                return { ok: false, reason: `notification-file-not-delivered:${produced.fileError}`, signalId: produced.signalId };
            }
            return { ok: true, signalId: produced.signalId };
        }
    }));

    // ---- recovery: rebuild from the durable store ---------------------------------------------

    /**
     * Rebuild the in-memory view from this plugin's durable store.
     *
     * The store is the record and memory is only a cache of it. Without this, a restart left `registry`
     * and `signals` empty, so `wait-any` could not see events that were still on disk and `answer`
     * reported an unknown question — the durable facts survived while the plugin behaved as if nothing
     * had happened. Recovery reads the store back:
     *
     *  - signals keep the identity they were recorded with, so an id means the same event after a restart
     *    as before it;
     *  - confirmations are subtracted, because a confirmed event is not owed to anyone again;
     *  - `sequence` resumes above the highest recovered value, so a cursor issued before the restart still
     *    selects only genuinely newer events instead of re-delivering the whole backlog;
     *  - questions are restored so a still-unanswered one stays answerable, while an answered or
     *    cancelled one is not.
     *
     * A question whose waiting tool call died with the previous process is NOT resurrected: it stays
     * readable as pending and the tool reports `interrupted` when it is re-run. Nothing is replayed
     * automatically, and no fake waiter is created.
     *
     * @returns {{signals: number, questions: number, cursor: number}} what was recovered.
     */
    const recoverFromEvents = () => {
        try {
            if (!state.store.available) return { ok: false, records: 0, questions: 0, cursor: 0, reason: "store-not-configured" };
            // Re-read the authoritative records and REPAIR the projection. Nothing is derived a second
            // time: the records ARE the state, so a restart cannot resurrect a record that reclamation has
            // removed, and a record that exists is visible with both of its axes intact.
            const reloaded = state.load();
            loaded = reloaded;
            stateReady = reloaded.ok;
            if (!reloaded.ok) {
                ctx.logger.error("codex-bridge: the durable store could not be reloaded (%s); production stays disabled", reloaded.reason);
                return { ok: false, records: reloaded.loaded, questions: 0, cursor: 0, reason: reloaded.reason };
            }
            const questions = state.all().filter((record) => record.kind === "question").length;
            // Repair the notification projection as a normal part of recovering: a record that is durable
            // but lost its file (a crash between the two writes, a previously unwritable inbox, a file
            // removed by hand) gets that file written again.
            let repaired = 0;
            for (const controller of new Set(state.all().map((record) => record.controller))) {
                const projection = state.project(controller);
                repaired += projection.repaired;
                if (projection.ghosts.length > 0) {
                    ctx.logger.warn("codex-bridge: %d inbox file(s) for %s have no record and are not delivered", projection.ghosts.length, controller);
                }
            }
            const meta = state.store.readMeta();
            const cursor = meta.ok ? meta.meta.nextSeq - 1 : 0;
            ctx.logger.info("codex-bridge: recovered %d record(s), %d question(s) from the durable store (cursor=%d, projection-repaired=%d)",
                reloaded.loaded, questions, cursor, repaired);
            return { ok: true, records: reloaded.loaded, questions, cursor };
        } catch (error) {
            // Recovery failing must not take the host down, but it MUST disable production: continuing on
            // state that could not be read is how a record gets overwritten from an empty basis.
            stateReady = false;
            ctx.logger.warn("codex-bridge: recovery from the durable store failed: %s", messageOf(error));
            return { ok: false, records: 0, questions: 0, cursor: 0, reason: messageOf(error) };
        }
    };

    // ---- native completion and terminal failure become signals -------------------------------

    /**
     * Report NATIVE completion and ABNORMAL END as signals.
     *
     * Two native facts are authoritative here, and neither is "the turn ended":
     *
     *  - `goal/change` with a `complete` phase is the harness's own statement that a Goal finished. That
     *    is a real completed result, so it becomes a `delivery` — with the Goal identity attached, so the
     *    controller can tie the result back to the work it asked for.
     *  - `turn/end` with a terminal `error` is a genuine abnormal stop and becomes an `error`, so the
     *    controller hears about it even if the model never got to call the tool.
     *
     * A normal `turn/end` produces NOTHING: the turn ending says nothing about whether the business
     * result is complete, which is exactly why the session's own `notify_controller` exists for the
     * cases the harness does not know about.
     */
    ctx.on("session/event", (session, event) => {
        try {
            if (event === null || event === undefined) return;
            const sessionId = session && typeof session.id === "string" ? session.id : "";
            if (sessionId.length === 0) return;
            const headerCwd = session.header && typeof session.header.cwd === "string" ? session.header.cwd : "";
            const bound = matchBinding({ sessionId, cwd: headerCwd }, bindings);
            if (!bound.allowed) return;

            /** @type {{kind: "delivery"|"error", text: string, goalId?: string, requestId?: string}|null} */
            let report = null;
            if (event.type === "goal/change") {
                const goal = event.data && event.data.goal;
                // Only a completed Goal is a delivery; paused, blocked and cleared are not "done".
                if (goal && goal.phase === "complete") {
                    const goalId = typeof goal.id === "string" ? goal.id : undefined;
                    report = {
                        kind: "delivery",
                        text: typeof goal.objective === "string" ? goal.objective : "Goal complete",
                        ...(goalId === undefined ? {} : { goalId }),
                        // Identity comes from the Goal and its completion, so a re-read of the same
                        // completion is the same event rather than a second delivery.
                        requestId: `goal-complete-${goalId ?? "unknown"}-${typeof goal.revision === "number" ? goal.revision : 0}`
                    };
                }
            } else if (event.type === "turn/end") {
                const reason = event.data && event.data.reason;
                if (reason && reason.kind === "error") {
                    const message = reason.error && typeof reason.error.message === "string" ? reason.error.message : "";
                    const requestId = typeof event.data.requestId === "string" ? event.data.requestId : undefined;
                    report = {
                        kind: "error",
                        text: message,
                        ...(requestId === undefined ? {} : { requestId: `turn-error-${requestId}` })
                    };
                }
            }
            if (report === null) return;

            // DEFERRED deliberately: `session/event` is emitted from inside the session's own append, and
            // appending from within an observer re-enters the publisher ("session append cannot reenter
            // while another append is being published") and takes the whole host down. Recording the
            // notification on a later tick leaves the append that triggered us to finish first.
            const pending = report;
            // A native event is a producer too: it is not allowed to record while authoritative state could
            // not be loaded, because that is exactly the restart window where the model or the harness can
            // act before the controller's first read.
            if (!requireReady().ok) {
                ctx.logger.warn("codex-bridge: a native %s event was not recorded because the store is not loaded", event.type);
                return;
            }
            // The ORIGINAL time of the native event becomes the issue time of the retried identity. It is
            // taken from the event the harness recorded — its own `time` — and NEVER from the moment this
            // observer happens to run: substituting "now" would let a retry of an already-reclaimed event
            // slip past the expiry check.
            //
            // Deduplication is only offered when the event really carries that time. Without it an identity
            // could not be retried safely, so the event is published under a SERVER-allocated id instead of
            // being given a fabricated timestamp: better a fresh, honest event than one whose identity
            // claims a time that never happened.
            const hasEventTime = typeof event.time === "number" && Number.isFinite(event.time);
            const eventTime = hasEventTime ? new Date(event.time).toISOString() : undefined;
            const eventSeq = typeof event.seq === "number" ? `seq${event.seq}` : undefined;
            setImmediate(() => {
                produceNotification({
                    agent: session,
                    binding: bound.binding,
                    kind: pending.kind,
                    text: pending.text,
                    ...(pending.goalId === undefined ? {} : { goalId: pending.goalId }),
                    // A retryable identity needs both an original time and a distinct sequence; otherwise the
                    // server allocates the id and the event is simply new.
                    ...(hasEventTime && eventSeq !== undefined && pending.requestId !== undefined
                        ? { requestId: `${pending.requestId}:${eventSeq}`, issuedAt: eventTime }
                        : {}),
                    at: new Date().toISOString()
                }).catch((error) => ctx.logger.warn("codex-bridge: could not report a native event: %s", messageOf(error)));
            });
        } catch (error) {
            ctx.logger.warn("codex-bridge: could not report a native event: %s", messageOf(error));
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
        // Fold in any durable events this process has not seen yet — including everything recorded before
        // a restart — so a reader never sees an emptied view while the facts sit in the session log.
        recoverFromEvents();

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
        const identity = identifyController(offered, identities, resolveControllerSecret);
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
                if (!isKnownController(identities, controller)) {
                    send(response, 403, { error: "not your binding: controller-not-bound" });
                    return;
                }
                send(response, 200, { bindings: bindingsOf(bindings, controller) });
                return;
            }

            // ---- incremental binding, WITHOUT remounting the plugin --------------------------------
            //
            // A controller that starts a new session needs its binding added, and a controller that has
            // retired a session needs it gone. Doing that by editing the profile and reloading the plugin
            // would tear the plugin down and abandon every in-flight question — including OTHER
            // controllers' pending questions, which this change has no business interrupting. Both routes
            // therefore persist through the shell's own config editor, whose volatile commit reaches THIS
            // running instance without a restart.
            if (request.method === "POST" && (route === "/bindings/bind" || route === "/bindings/unbind")) {
                const body = await readBody(request);
                if (body === null) { send(response, 413, { error: "request body too large" }); return; }
                let parsed;
                try { parsed = JSON.parse(body.length === 0 ? "{}" : body); }
                catch { send(response, 400, { error: "body must be JSON" }); return; }
                // The credential already resolved the controller; a stated name must agree with it. Identity
                // is NEVER taken from the body, so a caller cannot act as another controller by asking.
                if (!claimAgrees(parsed.controller)) {
                    send(response, 403, { error: "stated controller does not match the presented credential" });
                    return;
                }
                const acting = controller;

                /**
                 * Persist a new declared-binding list through the shell's config owner.
                 *
                 * `nextControllers` may also be supplied, so a binding can be written together with the
                 * identity it needs IN ONE EDIT. That ordering matters: an identity is registered before the
                 * binding that relies on it, so the stored configuration can never contain a binding whose
                 * controller cannot be authenticated.
                 */
                const persist = async (nextRaw, nextControllers) => {
                    const entry = ctx.fiber && ctx.fiber.entry ? ctx.fiber.entry : null;
                    if (entry === null || typeof ctx.configEditor?.edit !== "function") {
                        return { ok: false, reason: "the configuration owner is unavailable, so the change cannot be persisted" };
                    }
                    try {
                        // Only THIS plugin's row is edited; the editor derives the next raw config from the
                        // current one, so other plugins' rows and every unrelated field are carried through
                        // untouched.
                        await ctx.configEditor.edit(entry, (current) => ({
                            ...current,
                            ...(nextControllers === undefined ? {} : { controllers: nextControllers }),
                            bindings: nextRaw
                        }));
                        return { ok: true };
                    } catch (error) {
                        const reason = messageOf(error);
                        // The shell refuses to persist when a HOME PATCH or command-line overlay owns this
                        // plugin's effective configuration: the profile file would no longer be what the
                        // Loader reads, so writing it would silently do nothing. That is a real deployment
                        // constraint rather than a transient failure, and the caller is told which one it is
                        // instead of receiving a bare error.
                        if (/overridden by a home patch or command-line overlay/.test(reason)) {
                            return { ok: false, reason: "configuration-overridden", detail: reason };
                        }
                        return { ok: false, reason };
                    }
                };

                if (route === "/bindings/bind") {
                    const candidate = {
                        bindingId: typeof parsed.bindingId === "string" ? parsed.bindingId : undefined,
                        sessionId: typeof parsed.sessionId === "string" ? parsed.sessionId : undefined,
                        cwd: typeof parsed.cwd === "string" ? parsed.cwd : undefined,
                        // The controller is the AUTHENTICATED one, never the one in the body.
                        controller: acting,
                        tokenRef: typeof parsed.tokenRef === "string" ? parsed.tokenRef : undefined,
                        current: true
                    };
                    const normalized = normalizeBinding(candidate);
                    if (!normalized.ok) { send(response, 400, { error: normalized.reason }); return; }
                    const added = normalized.binding;

                    // The session must really exist AND its actual directory must be the one declared. A
                    // binding whose cwd is merely well-formed would answer for the wrong project.
                    if (typeof parsed.tokenRef !== "string" || parsed.tokenRef.trim().length === 0) {
                        send(response, 400, { error: "binding requires a tokenRef so this controller can be authenticated" });
                        return;
                    }
                    const live = ctx.agents && typeof ctx.agents.get === "function" ? ctx.agents.get(added.sessionId) : null;
                    if (live === null || live === undefined) {
                        send(response, 404, { error: "session-not-live", sessionId: added.sessionId, hint: "a binding may only be added for a session the shell currently knows" });
                        return;
                    }
                    const actualCwd = live.session && live.session.header && typeof live.session.header.cwd === "string" ? live.session.header.cwd : "";
                    if (actualCwd.length === 0 || !sameDirectory(actualCwd, added.cwd)) {
                        send(response, 409, { error: "cwd-does-not-match-the-session", sessionId: added.sessionId, expected: added.cwd });
                        return;
                    }

                    const mine = bindingsOf(bindings, acting);
                    // Re-adding the same binding is idempotent rather than an error: a retry after a lost
                    // response must not be told it is doing something wrong.
                    const same = mine.find((entry) => entry.bindingId === added.bindingId);
                    if (same !== undefined && same.sessionId === added.sessionId && same.cwd === added.cwd && same.tokenRef === added.tokenRef) {
                        send(response, 200, { ok: true, idempotent: true, binding: same });
                        return;
                    }
                    if (mine.some((entry) => entry.bindingId === added.bindingId)) {
                        send(response, 409, { error: "binding-id-already-declared", bindingId: added.bindingId });
                        return;
                    }
                    // A session may have exactly ONE current owner. Claiming a session that another live
                    // binding already owns is refused rather than silently taking it over.
                    const owners = bindings.filter((entry) => entry.sessionId === added.sessionId && entry.current !== false);
                    if (owners.length > 0) {
                        send(response, 409, { error: "session-already-has-an-answer-owner", sessionId: added.sessionId, owner: owners[0].controller });
                        return;
                    }

                    // The new declaration is THIS controller's bindings plus everything else, unchanged.
                    const nextRaw = [...currentBindings(), { bindingId: added.bindingId, sessionId: added.sessionId, cwd: added.cwd, controller: acting, tokenRef: added.tokenRef, current: true }];
                    // The identity is registered in the SAME edit as the binding, and BEFORE it in the
                    // written document: a stored binding whose controller cannot be authenticated would be
                    // unroutable, and this is the step that makes a controller with zero bindings able to
                    // bind its first one again.
                    const alreadyKnown = controllerIdentities(currentControllers(), []).some((entry) => entry.controller === acting);
                    const nextControllers = alreadyKnown ? undefined : [...currentControllers(), { controller: acting, tokenRef: added.tokenRef }];
                    const written = await persist(nextRaw, nextControllers);
                    if (!written.ok) { send(response, written.reason === "configuration-overridden" ? 409 : 500, { error: `the binding could not be persisted: ${written.reason}`, ...(written.detail === undefined ? {} : { detail: written.detail, hint: "this deployment owns the plugin config from a home patch or a command-line overlay, so it must be changed there" }) }); return; }
                    // The volatile commit may land just after the editor resolves; the reply is about what was
                    // PERSISTED, and the effective set is re-derived on the update event.
                    send(response, 200, { ok: true, binding: added, declared: nextRaw.length, identityRegistered: nextControllers !== undefined });
                    return;
                }

                // unbind
                const targetId = typeof parsed.bindingId === "string" ? parsed.bindingId.trim() : "";
                if (targetId.length === 0) { send(response, 400, { error: "bindingId is required" }); return; }
                const mine = bindingsOf(bindings, acting);
                const target = mine.find((entry) => entry.bindingId === targetId);
                if (target === undefined) {
                    // Not this controller's binding. The same answer is given whether it belongs to someone
                    // else or does not exist, so the endpoint cannot be used to probe another's bindings.
                    send(response, 403, { error: "not your binding", bindingId: targetId });
                    return;
                }

                // Refuse while the binding still has live work. Removing it would strand a question whose
                // asker is waiting, and silently cancelling someone's in-flight business is exactly what
                // this endpoint must not do.
                const pending = pendingQuestions(listForBinding(target), undefined);
                if (pending.length > 0) {
                    send(response, 409, { error: "binding-has-pending-questions", bindingId: targetId, pending: pending.length, hint: "answer or let them expire before unbinding" });
                    return;
                }
                const stillRunning = agentIsRunning(target.sessionId);
                if (stillRunning.running === true) {
                    send(response, 409, { error: "session-is-running", bindingId: targetId, hint: "unbinding would abandon the turn in progress" });
                    return;
                }

                // Only this binding is dropped; every other row — this controller's and other controllers'
                // — is carried through verbatim.
                const nextRaw = currentBindings().filter((entry, index) => {
                    const normalized = normalizeBinding(entry);
                    if (!normalized.ok) return true;
                    return !(normalized.binding.controller === acting && normalized.binding.bindingId === targetId);
                });
                if (nextRaw.length === currentBindings().length) {
                    send(response, 409, { error: "binding-not-removable", bindingId: targetId, hint: "the declared row could not be identified unambiguously" });
                    return;
                }
                const written = await persist(nextRaw);
                if (!written.ok) { send(response, written.reason === "configuration-overridden" ? 409 : 500, { error: `the change could not be persisted: ${written.reason}`, ...(written.detail === undefined ? {} : { detail: written.detail, hint: "this deployment owns the plugin config from a home patch or a command-line overlay, so it must be changed there" }) }); return; }
                send(response, 200, { ok: true, removed: targetId, declared: nextRaw.length });
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
                if (!isKnownController(identities, controller)) {
                    send(response, 403, { error: `not your binding: controller-not-bound` });
                    return;
                }
                // Every read of what this controller is owed goes through the projection owner, so the view
                // is reconciled with the durable records (a missing file is repaired, a confirmed or
                // reclaimed record is not delivered, a file with no record is reported) instead of each
                // route re-deriving it and drifting.
                const projection = state.project(controller);
                const deliverable = deliverableSignals(projection.outstanding, controller, acknowledged);
                send(response, 200, {
                    signals: deliverable,
                    cursor: deliverable.length > 0 ? deliverable[deliverable.length - 1].seq : null,
                    ...(projection.ghosts.length > 0 ? { unrecordedFiles: projection.ghosts.length } : {})
                });
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
                if (!isKnownController(identities, controller)) {
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
                // The files view reports what is ACTUALLY owed, not what happens to be on disk: a record
                // that is confirmed or reclaimed is not delivered even if its file lingers, and a file with
                // no record at all is a ghost that is reported but never delivered. All three read
                // surfaces share this one reconciliation, so they cannot disagree with each other.
                const projection = state.project(controller);
                const problems = [...snapshot.problems];
                send(response, 200, {
                    configured: true,
                    signals: projection.outstanding,
                    problems: [
                        ...problems,
                        ...projection.ghosts.map((ghost) => ({ file: ghost.id, reason: "no durable record for this inbox file; not delivered" }))
                    ],
                    ...(projection.confirmedFromFiles > 0 ? { filteredConfirmed: projection.confirmedFromFiles } : {}),
                    ...(projection.ghosts.length > 0 ? { ghosts: projection.ghosts.length } : {})
                });
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
                if (!isKnownController(identities, controller)) {
                    send(response, 403, { error: "not your binding: controller-not-bound" });
                    return;
                }
                const known = state.get(signalId);
                if (known === null) {
                    // A record that was issued and then reclaimed is reported as retired rather than as
                    // simply unknown, so a caller can tell "never existed" from "was already finished and
                    // has been reclaimed", and does not treat the latter as fresh work.
                    send(response, 410, { error: `signal "${signalId}" is unknown or has been retired`, signalId });
                    return;
                }
                // Only the binding that owns the event may confirm it: one controller cannot retire
                // another's event, and a superseded binding cannot retire its successor's.
                if (known.controller !== controller) {
                    send(response, 403, { error: "not your event" });
                    return;
                }
                // Confirmation is a compare-and-set on the NOTIFICATION axis alone, recorded durably, so
                // every view (memory, the file inbox, and a process restarted against the same store)
                // agrees on what has been dealt with. It deliberately does NOT touch the business state: a
                // question that has not been answered stays answerable after its notification is
                // confirmed. A repeat is the same outcome rather than a second fact.
                const confirmed = state.confirm(signalId);
                if (!confirmed.ok) {
                    // Without a durable record the event would reappear after any restart, so the
                    // confirmation is refused rather than reported as successful.
                    send(response, 503, { error: `the confirmation could not be recorded: ${confirmed.reason}`, signalId });
                    return;
                }
                // Confirmation is the moment a record becomes reclaimable, so retention runs here — the one
                // boundary where the notification has provably been dealt with. It removes only records
                // that are confirmed AND terminal AND past both bounds, so a pending question is never
                // touched, and its outcome is reported rather than assumed.
                const reclaimed = state.reclaim();
                if (reclaimed.failed.length > 0) {
                    ctx.logger.warn("codex-bridge: %d record(s) could not be reclaimed and remain on disk", reclaimed.failed.length);
                }
                send(response, 200, {
                    ok: true,
                    confirmed: true,
                    idempotent: !confirmed.changed,
                    signalId,
                    business: confirmed.record.business,
                    ...(confirmed.fileNote === undefined ? {} : { fileNote: confirmed.fileNote })
                });
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
                if (!isKnownController(identities, controller)) {
                    send(response, 403, { error: "not your binding: controller-not-bound" });
                    return;
                }
                /** Read the current outcome across ALL of this controller's bindings. */
                const current = () => waitOutcome({
                    // A delivery is a production-declared completion, so it is wake-worthy like any other
                    // event. There is no caller-supplied "deliveryComplete" switch here: letting the
                    // CONSUMER declare whether the producer finished inverted the contract, and meant a
                    // controller could not be woken by the very event it exists to receive.
                    //
                    // The projection owner supplies the signals so an event that is confirmed (or has no
                    // durable record) is never handed out as new work, no matter what is on disk.
                    signals: state.project(controller).outstanding,
                    controller,
                    acknowledged: [...acknowledged],
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
                const meta = state.get(questionId);
                if (meta === null || meta.kind !== "question") {
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
                const currentState = stateOfQuestion(questionId);
                const verdict = answerVerdict(currentState, { text, source });
                if (verdict.action === "reject" || verdict.action === "conflict") {
                    send(response, 409, { error: verdict.reason, action: verdict.action, questionId });
                    return;
                }
                if (verdict.action === "idempotent") {
                    // The identical answer again is the same outcome, not a second delivery.
                    send(response, 200, { ok: true, idempotent: true, questionId, answer: currentState.answer });
                    return;
                }
                // The answer is the question's terminal BUSINESS fact, applied as a compare-and-set so the
                // first answer wins: a second, different answer is refused rather than overwriting it. The
                // owner persists it, settles this process's live waiter with THAT recorded result, and only
                // then runs retention — so the winner is saved, the tool call receives what was actually
                // recorded rather than what was hoped for, and the reclaim cannot outrun either.
                const applied = state.settleBusiness(questionId, {
                    business: QUESTION_STATE.ANSWERED,
                    answer: { id: questionId, text, source, at: new Date().toISOString() }
                }, { status: "answered", answer: text, source });
                if (!applied.ok) {
                    send(response, 503, { error: `the answer could not be recorded: ${applied.reason}`, questionId });
                    return;
                }
                if (applied.changed === false) {
                    // It became terminal between the fold above and the compare-and-set: report the outcome
                    // that actually won instead of applying this one.
                    send(response, 409, { error: "question-already-decided", action: "conflict", questionId, answer: applied.record.answer });
                    return;
                }
                // The record snapshot comes from the transition itself, so a reclaim that removed the
                // record immediately afterwards cannot make this response read `unknown`.
                const delivered = applied.delivered;
                // A tool cannot be resumed across a restart, so an answer to a question whose waiter died
                // with the previous process is still recorded and reported as NOT delivered — the truth,
                // rather than an implication that a continuation happened.
                send(response, 200, { ok: true, questionId, delivered, answer: { text, source }, ...(delivered ? {} : { note: "recorded; no live waiting tool call in this process" }) });
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
                // A producer is refused while authoritative state could not be loaded, so it cannot record
                // into an unread basis.
                const readiness = requireReady();
                if (!readiness.ok) {
                    send(response, 503, { error: "the bridge is not ready to accept events", detail: readiness.reason });
                    return;
                }
                const agent = ctx.agents.get(sessionId);
                if (agent === undefined || agent === null) {
                    send(response, 409, { error: "session-not-live", sessionId });
                    return;
                }
                // The SAME producer the DS tool uses, so the passive route cannot drift from it. A retry
                // must present the ORIGINAL issue time: the envelope's time, never a fresh one, or the
                // expiry check could be bypassed by retrying.
                const produced = await produceNotification({
                    agent: agent.session,
                    binding: matched.binding,
                    kind,
                    text: typeof body.text === "string" ? body.text : "",
                    ...(typeof body.goalId === "string" && body.goalId.length > 0 ? { goalId: body.goalId } : {}),
                    ...(typeof body.requestId === "string" && body.requestId.length > 0 ? { requestId: body.requestId } : {}),
                    ...(typeof body.issuedAt === "string" && body.issuedAt.length > 0 ? { issuedAt: body.issuedAt } : {}),
                    at: new Date().toISOString()
                });
                // The durable event is already written, so a failing FILE projection is reported rather
                // than hidden behind a 200: the caller must know its controller may not be reliably
                // notified, and the stable event id makes its retry safe.
                if (produced.fileError !== undefined) {
                    send(response, 502, {
                        error: "the notification could not be fully delivered",
                        sessionId, kind, signalId: produced.signalId, detail: produced.fileError,
                        hint: "a durable record and a retry, if any, are safe: the event id is stable so no second business event is created"
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
        // waiter so a blocked caller returns instead of hanging on a disposed bridge. Waiter functions are
        // pure in-memory and are never recovered, so a disposed process reports `interrupted` rather than
        // pretending a tool call survived it.
        for (const [id, settle] of [...state.waiters]) {
            state.waiters.delete(id);
            settle({ status: "interrupted", reason: "bridge-disposed" });
        }
        for (const wake of [...signalWaiters]) wake();
        signalWaiters.clear();
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
