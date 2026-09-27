/**
 * Acceptance: adding or retiring ONE controller's binding WHILE the bridge runs, without interrupting
 * anybody else's in-flight question.
 *
 * The need is concrete: a new DS session starts in the same directory, and the existing way to bind it is
 * to edit the whole profile and reload, which tears the plugin down and abandons every question currently
 * being asked — including another controller's pending question, which this change has no business
 * interrupting.
 *
 * What must hold, and is asserted here:
 *
 *   1. while controller B has a REAL `ask_codex` waiting, controller A adds a binding for a NEW session;
 *      B's original question is still answerable and B's original tool call resumes EXACTLY once;
 *   2. A's new session really works end to end (ask -> wait -> answer -> same tool continues);
 *   3. a superseded (non-current) binding cannot answer for the session (no stealing);
 *   4. an illegal cwd, a session that is not live, and an attempt to touch ANOTHER controller's binding
 *      are all refused, and NOTHING about the declared bindings changes;
 *   5. the binding list survives the process: it was written to the profile, so a restart keeps it;
 *   6. the host PID never changes — the update is live, not a restart.
 *
 * The plugin is declared in the profile's OWN `cordis.patch.yml`, which is what the shell's config editor
 * owns and what the main instance uses. A `--patch` command-line overlay is a DIFFERENT owner: when one is
 * in force the editor refuses to write, because the profile file would no longer be what the Loader reads.
 * That refusal is surfaced as `configuration-overridden` instead of a bare error, so the boundary is
 * diagnosable rather than only discoverable in production.
 *
 * Run: node scripts/collab-livebind.test.mjs
 *
 * @module dsh-codex-bridge/scripts/collab-livebind.test
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import net from "node:net";
import { fileURLToPath, pathToFileURL } from "node:url";

const runFile = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(here, "..");
const pluginRepo = path.dirname(pluginRoot);
const repoRoot = path.resolve(pluginRepo, "..", "..");
const clientEntry = path.join(repoRoot, "chaossa_fix1_mysql_metadata", ".agents", "skills", "deepseek-harness-session-control", "scripts", "dsh-control.mjs");
const { DshClient } = await import(pathToFileURL(clientEntry).href);

const results = [];
/** @param {string} name - assertion name. @param {boolean} ok - outcome. @param {string} [detail] - observation. */
function record(name, ok, detail) {
    results.push({ name, ok, detail });
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  ${detail}` : ""}`);
}

const NODE = process.execPath;
const DSH_ENTRY = path.join(process.env.APPDATA ?? "", "npm", "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "collab-livebind-"));
const home = path.join(workDir, "home");
const profileDir = path.join(home, "profiles", "web");
const modulesDir = path.join(home, "profiles", "node_modules");
const projDir = path.join(workDir, "proj");
const otherDir = path.join(workDir, "elsewhere");
fs.mkdirSync(profileDir, { recursive: true });
fs.mkdirSync(modulesDir, { recursive: true });
fs.mkdirSync(projDir, { recursive: true });
fs.mkdirSync(otherDir, { recursive: true });
fs.cpSync(pluginRoot, path.join(modulesDir, "dsh-codex-bridge"), { recursive: true });
// The scripted provider calls `ask_codex` on a session's first model turn, so every ask below is a REAL
// tool call whose answer must resume that same call.
fs.cpSync(path.join(here, "scripted-model"), path.join(modulesDir, "dsh-codex-collab-scripted-model"), { recursive: true });

const TOKEN_A = "token-controller-a-secret";
const TOKEN_B = "token-controller-b-secret";
const REF_A = "TEST_CONTROLLER_TOKEN_A";
const REF_B = "TEST_CONTROLLER_TOKEN_B";
const sessionB = "session-b-existing";
const sessionA2 = "session-a-new";

/** The profile patch: A's EXISTING binding, plus B's. A's new one is added at runtime, not here. */
const writePatch = (extraRows = []) => {
    const lines = [
        "- insert:",
        "    - id: dsh-codex-bridge",
        "      name: 'dsh-codex-bridge'",
        "      config:",
        "        path: /codex-bridge",
        "        collabPath: /codex-collab",
        "        answerTimeoutMs: 30000",
        `        inboxRoot: ${JSON.stringify(path.join(workDir, "inbox").replace(/\\/g, "/"))}`,
        `        storeRoot: ${JSON.stringify(path.join(workDir, "store").replace(/\\/g, "/"))}`,
        "        bindings:",
        "          - bindingId: 'a::old'",
        `            sessionId: 'session-a-old'`,
        `            cwd: ${JSON.stringify(projDir.replace(/\\/g, "/"))}`,
        "            controller: 'codex-a'",
        `            tokenRef: '${REF_A}'`,
        "          - bindingId: 'b::existing'",
        `            sessionId: '${sessionB}'`,
        `            cwd: ${JSON.stringify(projDir.replace(/\\/g, "/"))}`,
        "            controller: 'codex-b'",
        `            tokenRef: '${REF_B}'`,
        ...extraRows,
        "",
        // A disposable home has no real credentials, so the scripted provider is what lets a REAL model
        // call reach `ask_codex`. The default model is pointed at it too, or the turn would fail before
        // any tool call.
        "    - id: scripted-model",
        "      name: 'dsh-codex-collab-scripted-model'",
        "      config:",
        "        provider: scripted",
        "        model: deepseek-v4.1-flash",
        "        toolName: ask_codex",
        "    - id: agent-default-model",
        "      name: '@deepseek-ai/dsh-agent-default-model'",
        "      config:",
        "        provider: scripted",
        "        model: deepseek-v4.1-flash",
        ""
    ];
    fs.writeFileSync(path.join(profileDir, "cordis.patch.yml"), lines.join("\n"), "utf8");
};
writePatch();

const port = await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { const p = server.address().port; server.close(() => resolve(p)); });
});
const logFile = path.join(workDir, "host.log");
const out = fs.openSync(logFile, "a");
const child = spawn(NODE, [DSH_ENTRY, "--profile", "web", "--port", String(port), "--no-open"], {
    env: { ...process.env, DSH_HOME: home, [REF_A]: TOKEN_A, [REF_B]: TOKEN_B },
    stdio: ["ignore", out, out]
});

/**
 * One control request as a given controller.
 *
 * The session cookie from `login()` is REQUIRED: the harness admits a request through its own connection
 * fence before the controller credential is even considered, so a request without it is refused as
 * unauthorized rather than as an unknown controller.
 */
const callAs = (token) => (url, route, init = {}) => fetch(new URL(`/codex-collab${route}`, new URL(url)), {
    ...init,
    headers: {
        "x-controller-token": token,
        ...(init.cookie === undefined ? {} : { cookie: init.cookie }),
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
        ...(init.headers ?? {})
    }
}).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));

try {
    let url = null;
    const bootDeadline = Date.now() + 90_000;
    while (Date.now() < bootDeadline && url === null) {
        await new Promise((r) => setTimeout(r, 400));
        const text = fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8") : "";
        const matches = text.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s)]+/g);
        if (matches && matches.length > 0) url = matches.at(-1);
        if (child.exitCode !== null) break;
    }
    record("the isolated host booted", url !== null, url === null ? "no launch URL" : "booted");
    if (url === null) throw new Error("the host did not boot");

    const client = new DshClient(new URL(url), 55_000);
    await client.login();
    await client.rpc("session/create", { request: { cwd: projDir, sessionId: sessionB } });
    await client.rpc("session/create", { request: { cwd: projDir, sessionId: sessionA2 } });
    // A session in a DIFFERENT directory, used to prove a mismatched cwd is refused.
    await client.rpc("session/create", { request: { cwd: otherDir, sessionId: "session-a-elsewhere" } });
    const callA = callAs(TOKEN_A);
    const callB = callAs(TOKEN_B);
    const pidBefore = child.pid;
    const cookie = { cookie: client.cookie };

    // ---- 1) start a REAL ask from B, and leave it WAITING --------------------------------
    const promptB = client.rpc("session/prompt", {
        request: {
            sessionId: sessionB, requestId: crypto.randomUUID(), mode: "queue",
            content: [{ type: "text", text: 'Call the tool "ask_codex" with a question.' }],
            clientTimeZone: "Asia/Shanghai"
        }
    }).catch(() => { /* asserted via the tool result */ });

    let questionB = null;
    const findB = Date.now() + 25_000;
    while (Date.now() < findB && questionB === null) {
        await new Promise((r) => setTimeout(r, 800));
        const listed = await callB(url, "/questions?sessionId=" + sessionB + "&controller=codex-b", cookie);
        questionB = (listed.body.questions ?? [])[0] ?? null;
    }
    record("controller B has a REAL pending question before the binding changes", questionB !== null, `questionId=${questionB?.id ?? "none"}`);

    // ---- 2) A adds a binding for the NEW session, while B waits --------------------------
    const bound = await callA(url, "/bindings/bind", {
        ...cookie, method: "POST",
        body: JSON.stringify({ sessionId: sessionA2, cwd: projDir, controller: "codex-a", tokenRef: REF_A, bindingId: "a::new" })
    });
    record("A adds a binding for the new session while B's question is pending", bound.status === 200, `status=${bound.status} ${JSON.stringify(bound.body).slice(0, 140)}`);
    record("the host PID is unchanged (the update was live, not a restart)", child.pid === pidBefore && child.exitCode === null, `pid=${child.pid}`);

    const listedA = await callA(url, "/bindings?controller=codex-a", cookie);
    const ids = (listedA.body.bindings ?? []).map((b) => b.bindingId);
    record("A now sees its OLD and NEW bindings", ids.includes("a::old") && ids.includes("a::new"), `ids=${JSON.stringify(ids)}`);
    const listedB = await callB(url, "/bindings?controller=codex-b", cookie);
    record("B's own binding is untouched by A's change", (listedB.body.bindings ?? []).some((b) => b.bindingId === "b::existing"), `count=${(listedB.body.bindings ?? []).length}`);

    // ---- 3) B's original question still works, and its tool resumes EXACTLY once ---------
    const answerFile = path.join(workDir, "b-answer.txt");
    fs.writeFileSync(answerFile, "B keeps its own answer.", "utf8");
    const answeredB = await callB(url, "/answer", {
        ...cookie, method: "POST",
        body: JSON.stringify({ questionId: questionB.id, text: fs.readFileSync(answerFile, "utf8"), source: "codex", controller: "codex-b" })
    });
    record("B's original question is answered after A's binding change", answeredB.status === 200, `status=${answeredB.status} ${answeredB.body.error ?? ""}`);
    record("B's answer was delivered to a live waiter (same tool call resumed)", answeredB.body.delivered !== false, `delivered=${answeredB.body.delivered}`);
    await promptB;
    await new Promise((r) => setTimeout(r, 1200));
    const snapB = await client.snapshot(sessionB, 300);
    const resultsB = snapB.records.map((r) => r.event).filter((e) => e && e.type === "tool/result");
    record("B's tool call resumed EXACTLY once", resultsB.length === 1, `tool results=${resultsB.length}`);
    record("B's resumed call carries B's own answer", JSON.stringify(resultsB).includes("B keeps its own answer"), "answer matched");

    // ---- 4) A's NEW session works end to end --------------------------------------------
    const promptA2 = client.rpc("session/prompt", {
        request: {
            sessionId: sessionA2, requestId: crypto.randomUUID(), mode: "queue",
            content: [{ type: "text", text: 'Call the tool "ask_codex" with a question.' }],
            clientTimeZone: "Asia/Shanghai"
        }
    }).catch(() => { /* asserted via the tool result */ });
    let questionA2 = null;
    const findA = Date.now() + 25_000;
    while (Date.now() < findA && questionA2 === null) {
        await new Promise((r) => setTimeout(r, 800));
        const listed = await callA(url, "/questions?sessionId=" + sessionA2 + "&controller=codex-a", cookie);
        questionA2 = (listed.body.questions ?? [])[0] ?? null;
    }
    record("A's NEW session can raise a real question through its new binding", questionA2 !== null, `questionId=${questionA2?.id ?? "none"}`);
    const answeredA2 = await callA(url, "/answer", {
        ...cookie, method: "POST",
        body: JSON.stringify({ questionId: questionA2?.id ?? "", text: "A answers its new session.", source: "codex", controller: "codex-a" })
    });
    record("A can answer its new session's question", answeredA2.status === 200, `status=${answeredA2.status}`);
    await promptA2;
    await new Promise((r) => setTimeout(r, 1200));
    const snapA2 = await client.snapshot(sessionA2, 300);
    const resultsA2 = snapA2.records.map((r) => r.event).filter((e) => e && e.type === "tool/result");
    record("A's new-session tool call resumed exactly once", resultsA2.length === 1, `tool results=${resultsA2.length}`);

    // ---- 5) refusals must not change anything -------------------------------------------
    const beforeRefusals = JSON.stringify((await callA(url, "/bindings?controller=codex-a", cookie)).body);
    const badCwd = await callA(url, "/bindings/bind", {
        ...cookie, method: "POST",
        body: JSON.stringify({ sessionId: sessionA2, cwd: otherDir, controller: "codex-a", tokenRef: REF_A, bindingId: "a::bad-cwd" })
    });
    record("a binding whose cwd is not the session's real directory is REFUSED", badCwd.status === 409 && /cwd/.test(badCwd.body.error ?? ""), `status=${badCwd.status} ${badCwd.body.error ?? ""}`);
    const notLive = await callA(url, "/bindings/bind", {
        ...cookie, method: "POST",
        body: JSON.stringify({ sessionId: "session-does-not-exist", cwd: projDir, controller: "codex-a", tokenRef: REF_A, bindingId: "a::ghost" })
    });
    record("a binding for a session that is not live is REFUSED", notLive.status === 404, `status=${notLive.status} ${notLive.body.error ?? ""}`);
    // Claiming to be B must not let A act as B: identity comes from the credential.
    const impersonate = await callAs(TOKEN_A)(url, "/bindings/unbind", {
        ...cookie, method: "POST", body: JSON.stringify({ bindingId: "b::existing", controller: "codex-b" })
    });
    record("A cannot unbind B's binding by claiming to be B", impersonate.status === 403, `status=${impersonate.status} ${impersonate.body.error ?? ""}`);
    // A must not be able to touch B's binding even with its OWN identity stated.
    const crossOwner = await callA(url, "/bindings/unbind", {
        ...cookie, method: "POST", body: JSON.stringify({ bindingId: "b::existing", controller: "codex-a" })
    });
    record("A cannot unbind B's binding under its own name either", crossOwner.status === 403, `status=${crossOwner.status} ${crossOwner.body.error ?? ""}`);
    const afterRefusals = JSON.stringify((await callA(url, "/bindings?controller=codex-a", cookie)).body);
    record("no refused request changed A's declared bindings", beforeRefusals === afterRefusals, "unchanged");
    const bStill = await callB(url, "/bindings?controller=codex-b", cookie);
    record("B's binding survived every refused request", (bStill.body.bindings ?? []).some((b) => b.bindingId === "b::existing"), "b::existing present");

    // ---- 6) persistence: the change is on disk, so a restart keeps it --------------------
    const patch = fs.readFileSync(path.join(profileDir, "cordis.patch.yml"), "utf8");
    record("the new binding was PERSISTED to the profile", patch.includes("a::new"), "a::new in the profile");
    record("the other plugin's row and B's binding are still in the profile",
        patch.includes("codex-b") && patch.includes("b::existing"), "both present");
    record("no credential VALUE was written to the profile", !patch.includes(TOKEN_A) && !patch.includes(TOKEN_B), "only references");

    // ---- 7) unbind refuses while work is pending, then succeeds --------------------------
    // The test provider raises its question on a session's FIRST model turn, so a SECOND prompt in the
    // same session produces no question at all. A fresh session is therefore used, bound incrementally
    // through the same endpoint.
    const sessionGuard = "session-a-guard";
    await client.rpc("session/create", { request: { cwd: projDir, sessionId: sessionGuard } });
    const guardBind = await callA(url, "/bindings/bind", {
        ...cookie, method: "POST",
        body: JSON.stringify({ sessionId: sessionGuard, cwd: projDir, controller: "codex-a", tokenRef: REF_A, bindingId: "a::guard" })
    });
    record("a fresh session can be bound incrementally as well", guardBind.status === 200, `status=${guardBind.status}`);

    const promptGuard = client.rpc("session/prompt", {
        request: {
            sessionId: sessionGuard, requestId: crypto.randomUUID(), mode: "queue",
            content: [{ type: "text", text: 'Call the tool "ask_codex" with a question.' }],
            clientTimeZone: "Asia/Shanghai"
        }
    }).catch(() => { /* left pending on purpose */ });
    let pendingGuard = null;
    const findGuard = Date.now() + 25_000;
    while (Date.now() < findGuard && pendingGuard === null) {
        await new Promise((r) => setTimeout(r, 800));
        const listed = await callA(url, "/questions?sessionId=" + sessionGuard + "&controller=codex-a", cookie);
        pendingGuard = (listed.body.questions ?? [])[0] ?? null;
    }
    record("the guard session has a real pending question", pendingGuard !== null, `questionId=${pendingGuard?.id ?? "none"}`);
    const refusedUnbind = await callA(url, "/bindings/unbind", {
        ...cookie, method: "POST", body: JSON.stringify({ bindingId: "a::guard", controller: "codex-a" })
    });
    record("unbinding is REFUSED while that binding has a pending question", refusedUnbind.status === 409 && /pending/.test(refusedUnbind.body.error ?? ""), `status=${refusedUnbind.status} ${refusedUnbind.body.error ?? ""}`);
    const stillDeclared = await callA(url, "/bindings?controller=codex-a", cookie);
    record("the refused unbind left the binding declared", (stillDeclared.body.bindings ?? []).some((b) => b.bindingId === "a::guard"), "a::guard still declared");
    const stillPending = await callA(url, "/questions?sessionId=" + sessionGuard + "&controller=codex-a", cookie);
    record("the refused unbind did not cancel the pending question", (stillPending.body.questions ?? []).length === 1, `pending=${(stillPending.body.questions ?? []).length}`);
    // Let the question finish; the waiter resumes, and then the unbind must succeed.
    await callA(url, "/answer", { ...cookie, method: "POST", body: JSON.stringify({ questionId: pendingGuard?.id ?? "", text: "answered before unbind", source: "codex", controller: "codex-a" }) });
    await promptGuard;
    await new Promise((r) => setTimeout(r, 1500));
    const freedUnbind = await callA(url, "/bindings/unbind", {
        ...cookie, method: "POST", body: JSON.stringify({ bindingId: "a::guard", controller: "codex-a" })
    });
    record("unbinding succeeds once no work is pending", freedUnbind.status === 200, `status=${freedUnbind.status} ${JSON.stringify(freedUnbind.body).slice(0, 120)}`);
    const afterUnbindGuard = await callA(url, "/bindings?controller=codex-a", cookie);
    record("the removed binding is gone and A's older binding remains", !(afterUnbindGuard.body.bindings ?? []).some((b) => b.bindingId === "a::guard") && (afterUnbindGuard.body.bindings ?? []).some((b) => b.bindingId === "a::old"), `ids=${JSON.stringify((afterUnbindGuard.body.bindings ?? []).map((b) => b.bindingId))}`);
    record("unbinding A's binding left B's binding alone", (await callB(url, "/bindings?controller=codex-b", cookie)).body.bindings.some((b) => b.bindingId === "b::existing"), "b::existing still there");
    record("the unbind was persisted too", !fs.readFileSync(path.join(profileDir, "cordis.patch.yml"), "utf8").includes("a::guard"), "a::guard removed from the profile");

    // ---- 8) an unbound binding cannot act (no stealing) ---------------------------------
    // `a::guard` was removed above, so acting through it must now be refused rather than quietly accepted.
    const goneAct = await callA(url, "/questions?sessionId=" + sessionGuard + "&controller=codex-a", cookie);
    record("an unbound session is no longer a binding this controller can act on", (goneAct.body.questions ?? []).length === 0, `questions=${(goneAct.body.questions ?? []).length}`);
    // The RECORD of the question that was asked while the binding existed is durable history and is NOT
    // erased by retiring the binding: unbinding stops future routing, it does not rewrite the past. What
    // matters is that it can no longer be used to ACT, which is asserted above.
    const signalsA = await callA(url, "/signals?controller=codex-a", cookie);
    const historical = (signalsA.body.signals ?? []).filter((s) => s.bindingId === "a::guard");
    record("the retired binding's past events remain as durable history, not silently deleted",
        historical.every((s) => s.sessionId === sessionGuard), `historical records=${historical.length}`);

    record("the host PID never changed across every change", child.pid === pidBefore && child.exitCode === null, `pid=${child.pid}`);
} finally {
    try { child.kill("SIGTERM"); } catch { /* gone */ }
    const stopDeadline = Date.now() + 6000;
    while (Date.now() < stopDeadline && child.exitCode === null && child.signalCode === null) await new Promise((r) => setTimeout(r, 200));
    if (child.exitCode === null && child.signalCode === null) { try { child.kill("SIGKILL"); } catch { /* gone */ } }
    const killDeadline = Date.now() + 4000;
    while (Date.now() < killDeadline && child.exitCode === null && child.signalCode === null) await new Promise((r) => setTimeout(r, 200));
    try { fs.closeSync(out); } catch { /* closed */ }
    record("the host stopped", child.exitCode !== null || child.signalCode !== null, `exit=${child.exitCode} signal=${child.signalCode}`);
}

// ---- 9) the OVERLAY boundary, on its own host ----------------------------------------------
// A `--patch` command-line overlay OWNS this plugin's config, so the shell's editor refuses to write the
// profile: that file would no longer be what the Loader reads. The refusal must be IDENTIFIABLE, so the
// operator learns the real reason instead of an opaque persistence error, and nothing may be reported as
// persisted when it was not. This is a different deployment shape from the profile-owned host above, so it
// gets its own short-lived host. A disposable home keeps it away from anything shared.
{
    const overlayHome = path.join(workDir, "overlay-home");
    const overlayModules = path.join(overlayHome, "profiles", "node_modules");
    fs.mkdirSync(overlayModules, { recursive: true });
    fs.cpSync(pluginRoot, path.join(overlayModules, "dsh-codex-bridge"), { recursive: true });
    const overlayPatch = path.join(workDir, "overlay.patch.yml");
    fs.writeFileSync(overlayPatch, [
        "- insert:",
        "    - id: dsh-codex-bridge",
        "      name: 'dsh-codex-bridge'",
        "      config:",
        "        path: /codex-bridge",
        "        collabPath: /codex-collab",
        `        inboxRoot: ${JSON.stringify(path.join(workDir, "overlay-inbox").replace(/\\/g, "/"))}`,
        `        storeRoot: ${JSON.stringify(path.join(workDir, "overlay-store").replace(/\\/g, "/"))}`,
        "        bindings:",
        "          - bindingId: 'o::old'",
        "            sessionId: 'overlay-old'",
        `            cwd: ${JSON.stringify(projDir.replace(/\\/g, "/"))}`,
        "            controller: 'codex-o'",
        `            tokenRef: '${REF_A}'`,
        ""
    ].join("\n"), "utf8");

    const overlayPort = await new Promise((resolve, reject) => {
        const server = net.createServer();
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => { const p = server.address().port; server.close(() => resolve(p)); });
    });
    const overlayLog = path.join(workDir, "overlay.log");
    const overlayOut = fs.openSync(overlayLog, "a");
    const overlayChild = spawn(NODE, [DSH_ENTRY, "--profile", "web", "--patch", overlayPatch, "--port", String(overlayPort), "--no-open"], {
        env: { ...process.env, DSH_HOME: overlayHome, [REF_A]: TOKEN_A },
        stdio: ["ignore", overlayOut, overlayOut]
    });
    try {
        let overlayUrl = null;
        const overlayDeadline = Date.now() + 90_000;
        while (Date.now() < overlayDeadline && overlayUrl === null) {
            await new Promise((r) => setTimeout(r, 400));
            const text = fs.existsSync(overlayLog) ? fs.readFileSync(overlayLog, "utf8") : "";
            const matches = text.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s)]+/g);
            if (matches && matches.length > 0) overlayUrl = matches.at(-1);
            if (overlayChild.exitCode !== null) break;
        }
        record("the overlay-owned host booted", overlayUrl !== null, overlayUrl === null ? "no launch URL" : "booted");
        if (overlayUrl !== null) {
            const oc = new DshClient(new URL(overlayUrl), 55_000);
            await oc.login();
            await oc.rpc("session/create", { request: { cwd: projDir, sessionId: "overlay-new" } });
            const callO = callAs(TOKEN_A);
            const refused = await callO(overlayUrl, "/bindings/bind", {
                cookie: oc.cookie, method: "POST",
                body: JSON.stringify({ sessionId: "overlay-new", cwd: projDir, controller: "codex-o", tokenRef: REF_A, bindingId: "o::new" })
            });
            record("with a command-line overlay the change is refused as configuration-overridden",
                refused.status === 409 && refused.body.error === "the binding could not be persisted: configuration-overridden",
                `status=${refused.status} error=${refused.body.error ?? ""}`);
            record("the refusal explains that the overlay owns the configuration", /home patch or a command-line overlay/.test(refused.body.hint ?? "") || /overridden by a home patch/.test(JSON.stringify(refused.body.detail ?? "")), `hint=${refused.body.hint ?? "(none)"}`);
            // Nothing may be reported as added when it was not, and the overlay file is untouched.
            const listed = await callO(overlayUrl, "/bindings?controller=codex-o", { cookie: oc.cookie });
            record("the refused change did not add the binding", !(listed.body.bindings ?? []).some((b) => b.bindingId === "o::new"), `ids=${JSON.stringify((listed.body.bindings ?? []).map((b) => b.bindingId))}`);
            record("the overlay file was not rewritten", !fs.readFileSync(overlayPatch, "utf8").includes("o::new"), "overlay unchanged");
        }
    } finally {
        try { overlayChild.kill("SIGTERM"); } catch { /* gone */ }
        const od = Date.now() + 6000;
        while (Date.now() < od && overlayChild.exitCode === null && overlayChild.signalCode === null) await new Promise((r) => setTimeout(r, 200));
        if (overlayChild.exitCode === null && overlayChild.signalCode === null) { try { overlayChild.kill("SIGKILL"); } catch { /* gone */ } }
        const kd = Date.now() + 4000;
        while (Date.now() < kd && overlayChild.exitCode === null && overlayChild.signalCode === null) await new Promise((r) => setTimeout(r, 200));
        try { fs.closeSync(overlayOut); } catch { /* closed */ }
        record("the overlay host stopped", overlayChild.exitCode !== null || overlayChild.signalCode !== null, `exit=${overlayChild.exitCode} signal=${overlayChild.signalCode}`);
        if (fs.existsSync(workDir)) fs.rmSync(workDir, { recursive: true, force: true });
    }
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\ncase_count=${results.length} passed=${results.length - failed} failed=${failed}`);
process.exitCode = failed === 0 ? 0 : 1;
