/**
 * Focused behaviour tests for which references the usage panel lists as accounts.
 *
 * The panel is only useful if one row is one account. This pins that: a discovered reference is
 * listed once per distinct key, and a repeated key does not become a second row. That case is
 * reachable without any misconfiguration, because the credential store resolves from the process
 * environment as well as from `.credentials.yaml` — a leftover `<PREFIX>_1` variable holding the
 * base key produced a duplicate CommandCode row on this machine.
 *
 * The production entry is exercised directly: `apply()` is called with a credential service and a
 * web server stub, then the registered route handler is invoked and its JSON body inspected. Only
 * the account list is asserted, so `fetch` is stubbed to fail and no network call is made.
 *
 * The module imports `@deepseek-ai/dsh-credentials` and `@deepseek-ai/schemastery`, which only
 * resolve inside a DSH install. The plugin is therefore staged into a temporary directory whose
 * `node_modules` points at the install's, so this runs the repository source rather than the
 * installed copy.
 *
 * Run: node scripts/collect-refs.test.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const packageRoot = path.dirname(here);

/** The DSH install's `profiles/node_modules`, which carries the two imports above. */
function installNodeModules() {
    const candidates = [
        process.env.DSH_HOME ? path.join(process.env.DSH_HOME, "profiles", "node_modules") : null,
        path.join(os.homedir(), ".dsh", "profiles", "node_modules"),
        process.env.APPDATA ? path.join(process.env.APPDATA, "dsh-desktop", "harness", "profiles", "node_modules") : null
    ].filter(Boolean);
    for (const candidate of candidates) {
        if (fs.existsSync(path.join(candidate, "@deepseek-ai", "dsh-credentials"))) return candidate;
    }
    return null;
}

/** Stage the repository plugin beside a `node_modules` link so its DSH imports resolve. */
function stagePlugin(modules) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "usage-refs-test-"));
    const target = path.join(dir, "dsh-opencode-go-usage");
    fs.mkdirSync(target, { recursive: true });
    fs.cpSync(path.join(packageRoot, "lib"), path.join(target, "lib"), { recursive: true });
    fs.copyFileSync(path.join(packageRoot, "package.json"), path.join(target, "package.json"));
    fs.symlinkSync(modules, path.join(dir, "node_modules"), "junction");
    return { dir, entry: path.join(target, "lib", "index.js") };
}

/**
 * A ctx with just what `apply` touches. `resolve` is backed by a plain map, so a reference is
 * "configured" exactly when it has an entry — which is also how a process environment variable
 * shows up to the real service.
 */
function fakeContext(secrets) {
    const state = { route: null };
    return {
        state,
        ctx: {
            credentials: {
                resolve: async (ref) => {
                    const value = secrets[String(ref)];
                    return value === undefined ? void 0 : { value: value };
                }
            },
            webServer: {
                register: (route) => {
                    state.route = route;
                    return () => {};
                }
            },
            effect: (fn) => fn(),
            logger: { warn() {}, error() {}, info() {} }
        }
    };
}

/** Drive the real route handler and return the parsed body. */
async function snapshotAccounts(secrets, config = {}) {
    const { ctx, state } = fakeContext(secrets);
    const { apply, Config } = await import(entryUrl);
    const resolved = Config({
        refs: [],
        sampleEveryMs: 0,
        cacheMs: 0,
        historyPath: path.join(os.tmpdir(), "usage-refs-test-history.jsonl"),
        ...config
    });
    apply(ctx, resolved);
    assert.ok(state.route, "apply must register the usage route");
    let body = "";
    await state.route.handler({ method: "GET" }, {
        writeHead() {},
        end(chunk) { body += chunk ?? ""; }
    });
    return JSON.parse(body);
}

const names = (payload) => payload.accounts.map((row) => row.account);

let failures = 0;
async function test(title, fn) {
    try {
        await fn();
        console.log("  ok   " + title);
    } catch (error) {
        failures++;
        console.log("  FAIL " + title + "\n       " + error.message);
    }
}

const modules = installNodeModules();
if (!modules) {
    console.log("  SKIP no DSH install with @deepseek-ai/dsh-credentials was found");
    process.exit(0);
}
const staged = stagePlugin(modules);
const entryUrl = "file:///" + staged.entry.replace(/\\/g, "/");

// No network: readAccount turns a failed fetch into row.error and still reports the account.
const realFetch = globalThis.fetch;
globalThis.fetch = async () => {
    throw new Error("network disabled in this test");
};

try {
    await test("a discovered key that repeats an earlier one is not listed twice", async () => {
        const payload = await snapshotAccounts({
            COMMANDCODE_API_KEY: "key-base",
            COMMANDCODE_API_KEY_1: "key-base", // the leftover environment variable: same key
            COMMANDCODE_API_KEY_2: "key-second"
        });
        const rows = names(payload).filter((name) => name.startsWith("COMMANDCODE"));
        assert.deepEqual(rows, ["COMMANDCODE_API_KEY", "COMMANDCODE_API_KEY_2"]);
    });

    await test("the surviving rows keep their own routes", async () => {
        const payload = await snapshotAccounts({
            COMMANDCODE_API_KEY: "key-base",
            COMMANDCODE_API_KEY_1: "key-base",
            COMMANDCODE_API_KEY_2: "key-second"
        });
        const byName = new Map(payload.accounts.map((row) => [row.account, row.route]));
        assert.equal(byName.get("COMMANDCODE_API_KEY"), "commandcode");
        assert.equal(byName.get("COMMANDCODE_API_KEY_2"), "commandcode-2");
    });

    await test("a distinct discovered key is still discovered", async () => {
        const payload = await snapshotAccounts({
            COMMANDCODE_API_KEY: "key-base",
            COMMANDCODE_API_KEY_3: "key-third"
        });
        const rows = names(payload).filter((name) => name.startsWith("COMMANDCODE"));
        assert.deepEqual(rows, ["COMMANDCODE_API_KEY", "COMMANDCODE_API_KEY_3"]);
    });

    await test("the OpenCode side repeats no key either", async () => {
        const payload = await snapshotAccounts({
            OPENCODE_API_KEY_1: "op-key-one",
            OPENCODE_API_KEY_2: "op-key-one", // duplicates account 1
            OPENCODE_API_KEY_3: "op-key-three"
        }, { refs: ["OPENCODE_API_KEY_1"] });
        const rows = names(payload).filter((name) => name.startsWith("OPENCODE"));
        assert.deepEqual(rows, ["OPENCODE_API_KEY_1", "OPENCODE_API_KEY_3"]);
    });

    await test("a configured reference stays listed even with no key", async () => {
        const payload = await snapshotAccounts({ COMMANDCODE_API_KEY: "key-base" }, {
            commandcodeRefs: ["COMMANDCODE_API_KEY_MISSING"]
        });
        assert.ok(names(payload).includes("COMMANDCODE_API_KEY_MISSING"));
        const row = payload.accounts.find((entry) => entry.account === "COMMANDCODE_API_KEY_MISSING");
        assert.equal(row.error, "missing credential");
    });

    await test("a configured duplicate still keeps its own row", async () => {
        // Configured references are an explicit list: they keep their order and are never dropped,
        // so the de-duplication only ever applies to what discovery adds.
        const payload = await snapshotAccounts({ COMMANDCODE_API_KEY: "key-base" }, {
            commandcodeRefs: ["COMMANDCODE_API_KEY", "COMMANDCODE_API_KEY_ALIAS"]
        });
        const rows = names(payload).filter((name) => name.startsWith("COMMANDCODE"));
        assert.deepEqual(rows, ["COMMANDCODE_API_KEY", "COMMANDCODE_API_KEY_ALIAS"]);
    });
} finally {
    globalThis.fetch = realFetch;
    fs.rmSync(staged.dir, { recursive: true, force: true });
}

console.log(failures === 0 ? "\n  collect-refs: all cases passed" : "\n  collect-refs: " + failures + " case(s) failed");
process.exit(failures === 0 ? 0 : 1);
