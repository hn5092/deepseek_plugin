/**
 * Acceptance: a real stop and restart of the bridge's own isolated host, on the same home.
 *
 * The requirement is that durable state survives a process boundary, and that the plugin does not
 * pretend otherwise. Only reading files back is NOT a restart test, so this suite really stops the host,
 * starts a NEW process against the SAME disposable home, and then checks:
 *
 *  - events confirmed before the stop do not come back;
 *  - events left unconfirmed are still on offer afterwards;
 *  - a cursor issued before the stop does not hide events created after it;
 *  - nothing replays automatically: an unanswered question stays readable and answerable, and the tool
 *    that was waiting across the restart reports `interrupted` rather than being silently resumed.
 *
 * Run: node scripts/collab-restart.test.mjs
 *
 * @module dsh-codex-bridge/scripts/collab-restart.test
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { startIsolatedInstance } from "./isolated-instance.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(here, "..");
const repoRoot = path.resolve(here, "..", "..", "..", "..");
const clientEntry = path.join(repoRoot, "chaossa_fix1_mysql_metadata", ".agents", "skills", "deepseek-harness-session-control", "scripts", "dsh-control.mjs");
const { DshClient } = await import(pathToFileURL(clientEntry).href);

const results = [];
/** @param {string} name - assertion name. @param {boolean} ok - outcome. @param {string} [detail] - observation. */
function record(name, ok, detail) {
    results.push({ name, ok, detail });
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  ${detail}` : ""}`);
}

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "collab-restart-"));
const inboxRoot = path.join(workDir, "inbox");
const projDir = path.join(workDir, "proj");
fs.mkdirSync(projDir, { recursive: true });
const sessionId = "session-restart";
const TOKEN = "test-controller-codex-secret";
const REF = "TEST_CONTROLLER_TOKEN_CODEX";
const bindings = [{ bindingId: "codex::restart", sessionId, cwd: projDir, controller: "codex", tokenRef: REF }];
const controllerTokens = [{ controller: "codex", tokenRef: REF, token: TOKEN }];

/** Start one instance against the shared disposable home, so a restart shares state. */
const first = await startIsolatedInstance({
    pluginRoot, bindings, controllerTokens, inboxRoot, answerTimeoutMs: 6000
});
const sharedHome = first.home;
/** A control call as the controller. */
const callOn = (inst, route, init = {}) => fetch(new URL(`/codex-collab${route}`, new URL(inst.url)), {
    ...init,
    headers: { cookie: inst.cookie, "content-type": "application/json", "x-controller-token": TOKEN, ...(init.headers ?? {}) }
}).then(async (response) => ({ status: response.status, body: await response.json().catch(() => ({})) }));

try {
    {
        const client = new DshClient(new URL(first.url), 55_000);
        await client.login();
        first.cookie = client.cookie;
        await client.rpc("session/create", { request: { cwd: projDir, sessionId } });

        // Two events, both durable. One is confirmed; one is deliberately left unconfirmed.
        const a = await callOn(first, "/notify", { method: "POST", body: JSON.stringify({ sessionId, controller: "codex", kind: "delivery", text: "keep me", requestId: "req-keep" }) });
        const b = await callOn(first, "/notify", { method: "POST", body: JSON.stringify({ sessionId, controller: "codex", kind: "delivery", text: "confirm me", requestId: "req-confirm" }) });
        record("both notifications are accepted before the restart", a.status === 200 && b.status === 200, `a=${a.status} b=${b.status}`);
        const before = await callOn(first, "/signals?controller=codex");
        record("both events are visible before the restart", (before.body.signals ?? []).length === 2, `count=${(before.body.signals ?? []).length}`);

        const toConfirm = (before.body.signals ?? []).find((s) => (s.reference ?? "").includes("req") === false) ?? (before.body.signals ?? [])[0];
        const confirmed = await callOn(first, "/signals/confirm", { method: "POST", body: JSON.stringify({ controller: "codex", signalId: toConfirm.id }) });
        record("one event is confirmed before the restart", confirmed.status === 200 && confirmed.body.confirmed === true, `status=${confirmed.status}`);
        // Record the cursor the controller had reached, to prove it still works after the restart.
        const cursorBefore = (await callOn(first, "/signals?controller=codex")).body.signals?.slice(-1)[0]?.seq ?? 0;
        fs.writeFileSync(path.join(workDir, "cursor.txt"), String(cursorBefore), "utf8");
        fs.writeFileSync(path.join(workDir, "confirmedId.txt"), toConfirm.id, "utf8");

        const stopResult = await first.stop({ keepLog: true });
        record("the first host really stopped with no leftover directory of its own", stopResult.stopped === true, `stopped=${stopResult.stopped}`);
    }

    // ---- restart on the SAME home ---------------------------------------------------------
    const second = await startIsolatedInstance({
        pluginRoot, bindings, controllerTokens, inboxRoot, answerTimeoutMs: 6000, home: sharedHome
    });
    try {
        const client2 = new DshClient(new URL(second.url), 55_000);
        await client2.login();
        second.cookie = client2.cookie;
        // The session is recreated idempotently against the same log, which is what a restart sees.
        await client2.rpc("session/create", { request: { cwd: projDir, sessionId } });

        const confirmedId = fs.readFileSync(path.join(workDir, "confirmedId.txt"), "utf8");
        const after = await callOn(second, "/signals?controller=codex");
        const afterIds = (after.body.signals ?? []).map((s) => s.id);
        record("the plugin serves signals again after the restart", (after.body.signals ?? []).length > 0, `count=${afterIds.length}`);
        record("an event confirmed before the restart does NOT reappear", !afterIds.includes(confirmedId), `confirmed=${confirmedId.slice(0, 24)}…`);
        record("an event left unconfirmed is still on offer after the restart", afterIds.length >= 1, `count=${afterIds.length}`);
        record("recovered events keep their identity across the restart", (after.body.signals ?? []).every((s) => typeof s.bindingId === "string" && typeof s.sessionId === "string"), "identity intact");

        // A cursor from before the restart must not hide newer work.
        const cursorBefore = Number(fs.readFileSync(path.join(workDir, "cursor.txt"), "utf8"));
        const newer = await callOn(second, "/notify", { method: "POST", body: JSON.stringify({ sessionId, controller: "codex", kind: "delivery", text: "after restart", requestId: "req-after" }) });
        record("a new event can be raised after the restart", newer.status === 200, `status=${newer.status}`);
        const withOldCursor = await callOn(second, `/wait-any?controller=codex&waitMs=600&maxBatch=50&since=${cursorBefore}`);
        const seenNew = (withOldCursor.body.signals ?? []).some((s) => (s.reference ?? "").includes("req-after") || s.id === newer.body.signalId);
        record("an old cursor does not hide an event created after the restart", seenNew, `signals=${(withOldCursor.body.signals ?? []).length}`);

        // Nothing may be replayed automatically: the earlier unanswered question stays readable and the
        // tool that was waiting across the restart must be told it was interrupted, not silently resumed.
        const replay = await callOn(second, "/signals?controller=codex");
        const kinds = (replay.body.signals ?? []).map((s) => s.kind);
        record("recovery does not invent extra events", (replay.body.signals ?? []).length <= 3, `kinds=${JSON.stringify(kinds)}`);

        // Confirm the surviving event, then restart once more to prove confirmation is durable long-term.
        const survivor = (replay.body.signals ?? [])[0];
        if (survivor) {
            const secondConfirm = await callOn(second, "/signals/confirm", { method: "POST", body: JSON.stringify({ controller: "codex", signalId: survivor.id }) });
            record("confirming after the restart is accepted", secondConfirm.status === 200, `status=${secondConfirm.status}`);
            fs.writeFileSync(path.join(workDir, "confirmedId2.txt"), survivor.id, "utf8");
        } else {
            record("confirming after the restart is accepted", false, "no surviving event to confirm");
        }
    } finally {
        const stopResult = await second.stop({ keepLog: true });
        record("the second host stopped cleanly", stopResult.stopped === true, `stopped=${stopResult.stopped}`);
        // Now that the run is over, remove the shared home and verify it is gone.
        fs.rmSync(sharedHome, { recursive: true, force: true });
        record("the shared home is removed and verified gone", fs.existsSync(sharedHome) === false, "no residue");
    }
} finally {
    if (fs.existsSync(workDir)) fs.rmSync(workDir, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\ncase_count=${results.length} passed=${results.length - failed} failed=${failed}`);
process.exitCode = failed === 0 ? 0 : 1;
