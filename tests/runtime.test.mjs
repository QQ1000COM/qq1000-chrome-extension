import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const workerSource = fs.readFileSync(new URL("../script/service_worker_new.js", import.meta.url), "utf8");
const TOKEN_KEY = "cj-user-token";
const quietConsole = { log() {}, info() {}, warn() {}, error() {} };
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); };

function workerSection(start, end, globals = {}) {
    const from = workerSource.indexOf(start);
    const to = workerSource.indexOf(end, from + start.length);
    assert.ok(from >= 0 && to > from, `worker section exists: ${start}`);
    const context = vm.createContext({
        console: quietConsole, performance, Date, URL, URLSearchParams, AbortController,
        setInterval() {}, setTimeout, clearTimeout,
        loadAppConfig: async () => {},
        AppConfig: { env: "build", cdnHost: "https://tu.qq1000.com/plugin-static", apiHost: "https://tu.qq1000.com", versions: "5.79.2" },
        ...globals,
    });
    vm.runInContext(workerSource.slice(from, to), context);
    return context;
}

function loader(globals = {}) {
    const context = workerSection("class ModuleLoaderManager", "class RequestInterceptorManager", globals);
    return vm.runInContext("new ModuleLoaderManager()", context);
}

let bootstrapRun = 0;
async function bootstrap({ syncToken = "", localToken = "", holdFirstRead = false } = {}) {
    const originalSelf = globalThis.self;
    const originalChrome = globalThis.chrome;
    const state = { sync: syncToken ? { [TOKEN_KEY]: syncToken } : {}, local: localToken ? { [TOKEN_KEY]: localToken } : {} };
    const listeners = [];
    let firstRead;
    let release;
    const calls = [];
    globalThis.chrome = {
        runtime: { onMessage: { addListener() {} } },
        storage: {
            sync: { get: async () => {
                const result = { ...state.sync };
                if (holdFirstRead && !firstRead) {
                    firstRead = new Promise(resolve => { release = resolve; });
                    await firstRead;
                }
                return result;
            } },
            local: { get: async () => ({ ...state.local }) },
            onChanged: { addListener: listener => listeners.push(listener) },
        },
    };
    globalThis.self = { fetch: async (input, init) => { calls.push({ input, init }); return { status: 200 }; } };
    const module = await import(`../script/qq1000_network_bootstrap.mjs?runtime-test=${++bootstrapRun}`);
    return {
        module, calls,
        changeToken(value) {
            state.sync[TOKEN_KEY] = value;
            for (const listener of listeners) listener({ [TOKEN_KEY]: { newValue: value } }, "sync");
        },
        releaseRead: () => release?.(),
        restore() { globalThis.self = originalSelf; globalThis.chrome = originalChrome; },
    };
}

test("asset authentication uses the same local fallback as the popup", async () => {
    const app = await bootstrap({ localToken: "local-synthetic" });
    try {
        await self.fetch("https://tu.qq1000.com/plugin-static/module.js");
        assert.equal(app.calls[0].init.headers?.get("user-token"), "local-synthetic");
        await self.fetch(new URL("https://tu.qq1000.com/plugin-static/module.js"));
        assert.equal(app.calls[1].init.headers?.get("user-token"), "local-synthetic");
    } finally { app.restore(); }
});

test("a token read that overlaps a storage change cannot refill the cache with the old account", async () => {
    const app = await bootstrap({ syncToken: "old-synthetic", holdFirstRead: true });
    try {
        const pending = app.module.getUserToken();
        await settle();
        app.changeToken("new-synthetic");
        app.releaseRead();
        assert.equal(await pending, "new-synthetic");
        assert.equal(await app.module.getUserToken(), "new-synthetic");
    } finally { app.releaseRead(); app.restore(); }
});

test("failed script and stylesheet HTTP responses are neither cached nor injected", async () => {
    const injected = [];
    let responseOk = false;
    const manager = loader({
        fetch: async () => ({ ok: responseOk, status: responseOk ? 200 : 503, statusText: "Unavailable", text: async () => responseOk ? "window.syntheticLoaded=true;" : "<html>Unavailable</html>" }),
        chrome: { scripting: { executeScript: async options => injected.push(options), insertCSS: async options => injected.push(options) } },
    });
    manager.getFileVersion = async () => "?v=stable";
    const failed = await manager.loadRemoteScripts(7, 0, ["module.js"], "default");
    await manager.loadRemoteStyles(7, 0, ["module.css"], "default");
    assert.equal(failed.failCount, 1);
    assert.equal(injected.length, 0);
    assert.equal(manager.codeCache.size, 0);
    responseOk = true;
    const recovered = await manager.loadRemoteScripts(7, 0, ["module.js"], "default");
    assert.equal(recovered.successCount, 1);
    assert.equal(manager.codeCache.size, 1);
});

test("a failed business script is reported as a module load failure", async () => {
    const manager = loader();
    manager.pageLibsCache.set("7_0", {});
    manager.coreLibrariesLoaded.add("7_0");
    for (const method of ["loadLocalScripts", "loadLocalModules", "loadLocalStyles", "loadRemoteStyles"]) manager[method] = async () => {};
    manager.ensureCoreLibrariesReady = async () => true;
    manager.loadRemoteScripts = async () => ({ successCount: 0, failCount: 1, hasCriticalFailure: false });
    const result = await manager._doLoadModule(7, 0, { name: "synthetic", remoteScripts: ["module.js"] }, {}, 0);
    assert.equal(result.success, false);
});

test("an invalid cached module response is replaced by a valid downloaded configuration", async () => {
    let saved;
    const manager = loader({
        chrome: { storage: { local: { get: async () => ({ modelConfig: { code: 401 } }), set: async value => { saved = value; } } } },
        fetch: async () => ({ ok: true, json: async () => ({ modules: [{ name: "synthetic" }] }) }),
    });
    const config = await manager.getConfig();
    assert.equal(config.modules[0].name, "synthetic");
    assert.equal(saved.modelConfig.modules[0].name, "synthetic");
});

test("navigating an iframe invalidates its cached libraries and pending generation", () => {
    const manager = loader();
    manager.frameDocumentIds.set("7_23", "old-document");
    manager.coreLibrariesLoaded.add("7_23");
    manager.pageLibsCache.set("7_23", { hasVue: true });
    manager.handleMainFrameNavigation({ tabId: 7, frameId: 23, documentId: "new-document" });
    assert.equal(manager.isGenerationValid(7, 23, 0), false);
    assert.equal(manager.coreLibrariesLoaded.has("7_23"), false);
    assert.equal(manager.pageLibsCache.has("7_23"), false);
});

test("navigating the top frame also invalidates child-frame work from the previous page", () => {
    const manager = loader();
    manager.frameDocumentIds.set("7_0", "old-main");
    manager.frameDocumentIds.set("7_23", "old-child");
    manager.coreLibrariesLoaded.add("7_23");
    manager.handleMainFrameNavigation({ tabId: 7, frameId: 0, documentId: "new-main" });
    assert.equal(manager.isGenerationValid(7, 23, 0), false);
    assert.equal(manager.coreLibrariesLoaded.has("7_23"), false);
});

test("duplicate starts from the same document share the existing module load", async () => {
    const manager = loader();
    let finish;
    let starts = 0;
    manager.getConfig = async () => ({});
    manager.matchModule = () => ({ name: "synthetic" });
    manager.checkPermission = () => true;
    manager._doLoadModule = () => { starts++; return new Promise(resolve => { finish = resolve; }); };
    const sender = { tab: { id: 7 }, frameId: 0, documentId: "same-document" };
    const first = manager.handleStart({ url: "https://item.taobao.com/item.htm" }, sender);
    await settle();
    const second = manager.handleStart({ url: "https://item.taobao.com/item.htm" }, sender);
    await settle();
    assert.equal(starts, 1);
    finish({ success: true });
    assert.deepEqual(await first, await second);
});

test("failed configuration downloads keep the old version and are retried; success invalidates the in-memory version", async () => {
    const state = { versionInfo: { js_ver: 1, inj_ver: 1 }, interceptorConfig: { platforms: [] } };
    let failDownload = true;
    let downloads = 0;
    let invalidations = 0;
    const context = workerSection("class ConfigUpdateManager", "class MessageRouter", {
        self: { moduleLoaderManager: { clearConfigCache: () => { invalidations++; } } },
        chrome: { storage: { local: { get: async () => ({ ...state }), set: async values => Object.assign(state, values) } } },
        fetch: async url => ({ ok: true, json: async () => {
            if (url.endsWith("loadVer")) return { state: true, data: { js_ver: 2, inj_ver: 1 } };
            if (url.endsWith("loadConfigVer")) {
                downloads++;
                return failDownload ? { state: false, msg: "synthetic network failure" } : { state: true, data: { isOpen: true, version: { default: "2" } } };
            }
            throw new Error(`Unexpected test URL: ${url}`);
        } }),
    });
    const manager = vm.runInContext("new ConfigUpdateManager()", context);
    await manager.checkAndUpdateAll(false);
    assert.equal(state.versionInfo.js_ver, 1);
    failDownload = false;
    await manager.checkAndUpdateAll(false);
    assert.equal(downloads, 2);
    assert.equal(state.versionInfo.js_ver, 2);
    assert.equal(state.moduleVersionConfig.version.default, "2");
    assert.ok(invalidations > 0);
});

test("injected storage.set callbacks settle once and release their timeout after a response", async () => {
    let bridgeCode;
    const manager = loader({ chrome: {
        storage: { local: { get: async () => ({}) } },
        runtime: { getURL: path => `chrome-extension://synthetic/${path}`, getManifest: () => ({ version: "5.79.2" }) },
        scripting: { executeScript: async options => { bridgeCode = options.args[0]; } },
    } });
    await manager.injectChromeBridge(7, 0);
    const listeners = new Set();
    const timers = new Map();
    const sent = [];
    let nextTimer = 0;
    const window = {
        location: { origin: "https://item.taobao.com" },
        addEventListener: (_, listener) => listeners.add(listener),
        removeEventListener: (_, listener) => listeners.delete(listener),
        postMessage: message => sent.push(message),
    };
    vm.runInNewContext(bridgeCode, {
        window, console: quietConsole,
        setTimeout: fn => { const id = ++nextTimer; timers.set(id, fn); return id; },
        clearTimeout: id => timers.delete(id),
    });
    for (const area of ["local", "sync"]) {
        let callbacks = 0;
        window.chrome.storage[area].set({ synthetic: true }, () => { callbacks++; });
        const request = sent.at(-1);
        for (const listener of [...listeners]) listener({ source: window, origin: window.location.origin, data: { type: "chrome_storage_response", storageType: area, messageId: request.messageId, success: true } });
        for (const fn of [...timers.values()]) fn();
        assert.equal(callbacks, 1, area);
        assert.equal(timers.size, 0, area);
    }
});

test("configuration refresh messages expose a failed download to callers", async () => {
    const context = workerSection("async function handleMessage(", "async function handleChromeTabsCall(", {
        configUpdateManager: { checkAndUpdateAll: async () => false, init: async () => false },
    });
    const handler = vm.runInContext("handleMessage", context);
    for (const type of ["check_config_update", "force_update_config"]) {
        const result = await handler({ type }, {});
        assert.equal(result.success, false, type);
    }
});

test("the recovery status message serves only the top PDD merchant frame", async () => {
    let reads = 0;
    const context = workerSection("async function handleMessage(", "async function handleChromeTabsCall(", {
        pddHijackState: { getStatus: async () => { reads++; return { needsAttention: true, message: "请确认上次是否保存" }; } },
    });
    const handler = vm.runInContext("handleMessage", context);
    const message = { type: "qq1000:pdd-recovery-state" };
    const sender = { tab: { id: 7 }, frameId: 0, origin: "https://mms.pinduoduo.com" };
    const result = await handler(message, sender);
    assert.equal(result.success, true);
    assert.deepEqual(Object.keys(result.status).sort(), ["message", "needsAttention"]);
    assert.equal((await handler(message, { ...sender, frameId: 8 })).success, false);
    assert.equal((await handler(message, { ...sender, origin: "https://item.taobao.com" })).success, false);
    assert.equal(reads, 1);
});

test("authenticated proxy requests use the same effective account as static asset requests", async () => {
    let options;
    const context = workerSection("async function handleProxyApiRequest(", "const HEADER_PREFIX", {
        getUserToken: async () => "current-synthetic",
        chrome: { storage: { local: { get: (_, callback) => callback({ "cj-user-token": "stale-fallback" }) } } },
        fetch: async (_, init) => {
            options = init;
            return { status: 200, statusText: "OK", headers: { get: () => "application/json" }, json: async () => ({ state: true }) };
        },
    });
    const handler = vm.runInContext("handleProxyApiRequest", context);
    const result = await handler({ apiConfig: { url: "/plugin/api/user/info", needAuth: true } });
    assert.equal(result.success, true);
    assert.equal(options.headers["user-token"], "current-synthetic");
    assert.equal(options.redirect, "error");
});

test("interceptor code is injected into its sender frame and reports execution failures", async () => {
    let target;
    const context = workerSection("async function handleMessage(", "async function handleChromeTabsCall(", {
        chrome: { scripting: { executeScript: async options => {
            target = options.target;
            return [{ result: options.func(...options.args) }];
        } } },
    });
    const handler = vm.runInContext("handleMessage", context);
    const result = await handler({ type: "inject_script_to_main_world", code: "throw new Error('synthetic execution failure')" }, { tab: { id: 7 }, frameId: 23 });
    assert.equal(target.frameIds?.[0], 23);
    assert.equal(result.success, false);
    assert.match(result.error, /synthetic execution failure/);
});

test("a restarted worker removes orphan temporary header rules before allocating new rules", async () => {
    const rules = new Map([
        [10500, { id: 10500, action: { type: "modifyHeaders" } }],
        [910007, { id: 910007, action: { type: "block" } }],
    ]);
    const operations = [];
    const context = workerSection("const HEADER_PREFIX", "function isGbkCharset", {
        setTimeout: () => 1, clearTimeout() {},
        chrome: { declarativeNetRequest: {
            getSessionRules: async () => [...rules.values()],
            updateSessionRules: async update => {
                operations.push(update);
                for (const id of update.removeRuleIds || []) rules.delete(id);
                for (const rule of update.addRules || []) {
                    if (rules.has(rule.id)) throw new Error("Duplicate session rule");
                    rules.set(rule.id, rule);
                }
            },
        } },
    });
    const update = vm.runInContext("updateHeaderRules", context);
    const results = await Promise.all([1, 2].map(value => update({ url: "https://item.taobao.com/api", headers: { "kdcm-header-origin": "https://item.taobao.com", "x-synthetic": String(value) } })));
    assert.equal(rules.has(10500), false);
    assert.equal(rules.has(910007), true, "PDD submit rules are a separate lifecycle");
    assert.notEqual(results[0].ruleId, results[1].ruleId);
    assert.equal(operations[0].removeRuleIds[0], 10500);
});

test("failure to install required request headers fails the operation instead of silently sending incomplete headers", async () => {
    const context = workerSection("const HEADER_PREFIX", "function isGbkCharset", {
        setTimeout: () => 1, clearTimeout() {},
        chrome: { declarativeNetRequest: {
            getSessionRules: async () => [],
            updateSessionRules: async () => { throw new Error("synthetic DNR failure"); },
        } },
    });
    const update = vm.runInContext("updateHeaderRules", context);
    await assert.rejects(update({ url: "https://item.taobao.com/api", headers: { "kdcm-header-origin": "https://item.taobao.com" } }), /synthetic DNR failure/);
});
