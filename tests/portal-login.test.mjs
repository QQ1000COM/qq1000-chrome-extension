import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../script/qq1000_portal_bridge.js", import.meta.url), "utf8");
const TOKEN_KEY = "cj-user-token";
const BANNER_ID = "qq1000-portal-login-banner";

// A small DOM fixture for the banner's static markup; no browser dependencies.
class Element {
    constructor(tag) {
        this.tagName = tag;
        this.children = [];
        this.dataset = {};
        this.style = {};
        this.listeners = new Map();
    }
    set innerHTML(value) {
        this.markup = value;
        this.children = [];
        for (const match of value.matchAll(/<([a-z]+)\b[^>]*class="([^"]+)"[^>]*>/g)) {
            const child = new Element(match[1]);
            child.className = match[2];
            this.appendChild(child);
        }
    }
    get innerHTML() { return this.markup || ""; }
    appendChild(child) { child.parentElement = this; this.children.push(child); return child; }
    removeChild(child) { this.children = this.children.filter(item => item !== child); child.parentElement = null; }
    querySelector(selector) {
        return this.children.find(child => selector[0] === "." && child.className?.split(" ").includes(selector.slice(1)))
            || this.children.map(child => child.querySelector(selector)).find(Boolean) || null;
    }
    querySelectorAll() { return []; }
    setAttribute() {}
    addEventListener(name, listener) { this.listeners.set(name, listener); }
}

const settle = async () => { for (let index = 0; index < 5; index++) await new Promise(resolve => setImmediate(resolve)); };
const deferred = () => {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
};

function bridge({ token = "synthetic", localToken, fetchInfo, fetchUpdate, localData = {}, pageStorage = new Map(), blockPageStorage = false, now = Date.now() } = {}) {
    const state = { sync: token ? { [TOKEN_KEY]: token } : {}, local: { ...localData, ...(localToken ? { [TOKEN_KEY]: localToken } : {}) } };
    const storageListeners = [];
    let storageReadsPaused = false;
    const pendingStorageReads = [];
    const windowListeners = new Map();
    const documentElement = new Element("html");
    const head = documentElement.appendChild(new Element("head"));
    const body = documentElement.appendChild(new Element("body"));
    const byId = (element, id) => element.id === id ? element : element.children.map(child => byId(child, id)).find(Boolean);
    const document = {
        readyState: "complete", visibilityState: "visible", documentElement, head, body,
        createElement: tag => new Element(tag), getElementById: id => byId(documentElement, id),
        querySelector: () => null, querySelectorAll: () => [], addEventListener() {},
    };
    const pendingTimers = new Map();
    let nextTimer = 0;
    let reloads = 0;
    const store = pageStorage;
    const window = {
        localStorage: {
            getItem: key => { if (blockPageStorage) throw new Error("Storage disabled"); return store.get(key); },
            setItem: (key, value) => { if (blockPageStorage) throw new Error("Storage disabled"); store.set(key, value); },
            removeItem: key => store.delete(key),
        },
        addEventListener: (name, listener) => windowListeners.set(name, listener), location: { reload: () => { reloads++; } },
    };
    const change = (area, value) => {
        const oldValue = state[area][TOKEN_KEY];
        if (value === undefined) delete state[area][TOKEN_KEY];
        else state[area][TOKEN_KEY] = value;
        for (const listener of storageListeners) listener({ [TOKEN_KEY]: { oldValue, newValue: value } }, area);
    };
    const area = name => ({
        get: (keys, callback) => {
            const result = Object.fromEntries(keys.filter(key => key in state[name]).map(key => [key, state[name][key]]));
            const complete = () => callback(result);
            if (storageReadsPaused) pendingStorageReads.push(complete);
            else setImmediate(complete);
        },
        set: (items, callback) => { Object.assign(state[name], items); callback(); },
        remove: (keys, callback) => {
            const hadToken = keys.includes(TOKEN_KEY) && TOKEN_KEY in state[name];
            for (const key of keys) delete state[name][key];
            if (hadToken) for (const listener of storageListeners) listener({ [TOKEN_KEY]: { newValue: undefined } }, name);
            callback();
        },
    });
    const requests = [];
    vm.runInNewContext(source, {
        window, document, AbortController, Event, Date: class extends Date { static now() { return now; } },
        MutationObserver: class { observe() {} },
        chrome: {
            runtime: { getManifest: () => ({ version: "5.79" }) },
            storage: { sync: area("sync"), local: area("local"), onChanged: { addListener: fn => storageListeners.push(fn) } },
        },
        setTimeout: (fn, ms) => { const id = ++nextTimer; pendingTimers.set(id, { fn, ms }); return id; },
        clearTimeout: id => pendingTimers.delete(id), setInterval: () => 1,
        fetch: async (url, options) => {
            requests.push({ url, options });
            if (url.includes("/plugin/api/user/info")) return fetchInfo ? fetchInfo(options) : { status: 200, json: async () => ({ code: 0, state: true }) };
            return fetchUpdate ? fetchUpdate(url, options) : { ok: true, json: async () => ({ version: "5.79.1" }) };
        },
    });
    return {
        state, requests, change,
        pageStorage,
        pauseStorageReads: () => { storageReadsPaused = true; },
        resumeStorageReads: () => { storageReadsPaused = false; pendingStorageReads.splice(0).forEach(complete => complete()); },
        focus: () => windowListeners.get("focus")?.(),
        banner: () => document.getElementById(BANNER_ID),
        reloadTimers: () => [...pendingTimers.values()].filter(timer => timer.ms === 300),
        runReload: () => { for (const timer of pendingTimers.values()) if (timer.ms === 300) timer.fn(); return reloads; },
        runTimers: ms => { for (const [id, timer] of pendingTimers) if (timer.ms === ms) { pendingTimers.delete(id); timer.fn(); } },
    };
}

test("a newer version shows an update notice without falsely logging out an authenticated user", async () => {
    const app = bridge();
    await settle();
    const banner = app.banner();
    assert.equal(banner.dataset.mode, "update");
    assert.equal(banner.querySelector(".qq1000-pb-title-text").textContent, "插件有新版本");
    assert.match(banner.querySelector(".qq1000-pb-text").textContent, /v5\.79\.1/);
    assert.match(banner.querySelector(".qq1000-pb-actions").innerHTML, /releases\/latest/);
    assert.equal(banner.querySelector(".qq1000-pb-primary"), null);
    assert.equal(app.state.sync[TOKEN_KEY], "synthetic");
    assert.equal(app.requests.find(request => request.url.includes("/plugin/api/")).options.headers["user-token"], "synthetic");
    assert.equal(app.requests.find(request => request.url.includes("/plugin/api/")).options.method, "POST");
});

test("a late successful heartbeat does not erase an update notice", async () => {
    const response = deferred();
    const app = bridge({ fetchInfo: () => response.promise });
    await settle();
    assert.equal(app.banner().dataset.mode, "update");
    response.resolve({ status: 200, json: async () => ({ code: 0 }) });
    await settle();
    assert.equal(app.banner().dataset.mode, "update");
});

test("missing credentials retain the login prompt; login restores the independent update notice", async () => {
    const app = bridge({ token: "" });
    await settle();
    assert.equal(app.banner().dataset.mode, "login");
    assert.match(app.banner().querySelector(".qq1000-pb-text").textContent, /在线登录/);
    assert.ok(app.banner().querySelector(".qq1000-pb-primary"));
    app.change("sync", "new-synthetic");
    app.change("local", "new-synthetic");
    await settle();
    assert.equal(app.banner().dataset.mode, "update");
    assert.equal(app.reloadTimers().length, 1);
    assert.equal(app.runReload(), 1);
});

test("removing only the fallback token does not override the effective sync login", async () => {
    const app = bridge({ localToken: "synthetic" });
    await settle();
    app.change("local", undefined);
    await settle();
    assert.equal(app.banner().dataset.mode, "update");
    assert.equal(app.reloadTimers().length, 0);
    app.change("sync", undefined);
    await settle();
    assert.equal(app.banner().dataset.mode, "login");
});

test("fallback credentials work and a stale heartbeat cannot clear a newly logged-in account", async () => {
    const response = deferred();
    let calls = 0;
    const app = bridge({ token: "", localToken: "old-synthetic", fetchInfo: () => ++calls === 1 ? response.promise : { status: 200, json: async () => ({ code: 0 }) } });
    await settle();
    assert.equal(app.banner().dataset.mode, "update");
    app.change("sync", "new-synthetic");
    await settle();
    response.resolve({ status: 401 });
    await settle();
    assert.equal(app.state.sync[TOKEN_KEY], "new-synthetic");
    assert.equal(app.banner().dataset.mode, "update");
});

test("a real unauthorized response clears credentials and cannot be replaced by a later update", async () => {
    const update = deferred();
    const app = bridge({ fetchInfo: () => ({ status: 401 }), fetchUpdate: () => update.promise });
    await settle();
    assert.equal(app.state.sync[TOKEN_KEY], undefined);
    assert.equal(app.banner().dataset.mode, "login");
    update.resolve({ ok: true, json: async () => ({ version: "5.79.1" }) });
    await settle();
    assert.equal(app.banner().dataset.mode, "login");
    assert.doesNotMatch(app.banner().querySelector(".qq1000-pb-text").textContent, /新版本/);
});

test("a stale heartbeat cannot clear a new account while asynchronous storage reads are pending", async () => {
    const response = deferred();
    let calls = 0;
    const app = bridge({ fetchInfo: () => ++calls === 1 ? response.promise : { status: 200, json: async () => ({ code: 0 }) } });
    await settle();
    app.pauseStorageReads();
    app.change("sync", "new-synthetic");
    app.change("local", "new-synthetic");
    app.focus();
    await settle();
    assert.equal(calls, 1, "focus must wait for the effective credentials to finish loading");
    response.resolve({ status: 401 });
    await settle();
    assert.equal(app.state.sync[TOKEN_KEY], "new-synthetic");
    assert.equal(app.state.local[TOKEN_KEY], "new-synthetic");
    app.resumeStorageReads();
    await settle();
    assert.equal(app.banner().dataset.mode, "update");
    assert.equal(app.reloadTimers().length, 1);
    assert.equal(calls, 2);
});

test("current versions stay quiet and closing an update does not alter the login", async () => {
    const current = bridge({ fetchUpdate: () => ({ ok: true, json: async () => ({ version: "5.79" }) }) });
    await settle();
    assert.equal(current.banner(), undefined);
    const app = bridge();
    await settle();
    app.banner().querySelector(".qq1000-pb-close").listeners.get("click")({ preventDefault() {} });
    assert.equal(app.banner(), undefined);
    assert.equal(app.state.sync[TOKEN_KEY], "synthetic");
});

test("popup reads the account through POST so a shared GET cache cannot choose its identity", async () => {
    const requests = [];
    const storage = {
        get: (_, callback) => callback({ [TOKEN_KEY]: "synthetic" }),
        set: (_, callback) => callback(),
    };
    const context = vm.createContext({
        document: { addEventListener() {}, createElement: tag => new Element(tag) },
        chrome: { storage: { sync: storage, local: storage } },
        AbortController, setTimeout, clearTimeout,
        fetch: async (url, options) => {
            requests.push({ url, options });
            return { status: 200, text: async () => JSON.stringify({ code: 0, state: true, data: { username: "test-account", pluginQuotas: [] } }) };
        },
    });
    vm.runInContext(fs.readFileSync(new URL("../popup.js", import.meta.url), "utf8"), context);
    vm.runInContext(`
        els.panelUser = { classList: { toggle() {} } };
        els.panelLogin = { classList: { toggle() {} } };
        els.userName = {};
        els.userMeta = {};
        els.quotaList = {};
    `, context);
    await vm.runInContext("loadUser()", context);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].options.method, "POST");
    assert.equal(requests[0].options.headers["user-token"], "synthetic");
    assert.equal(vm.runInContext("els.userName.textContent", context), "test-account");
});

test("update checks work when the merchant page disables localStorage", async () => {
    const app = bridge({ blockPageStorage: true });
    await settle();
    assert.equal(app.banner()?.dataset.mode, "update");
});

test("a hanging update mirror times out and falls back to the next mirror", async () => {
    let requests = 0;
    const app = bridge({ fetchUpdate: (_url, options) => {
        if (++requests === 1) return new Promise((_resolve, reject) => options.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
        return { ok: true, json: async () => ({ version: "5.79.1" }) };
    } });
    await settle();
    app.runTimers(8000);
    await settle();
    assert.equal(requests, 2);
    assert.equal(app.banner()?.dataset.mode, "update");
});

test("a known available update survives a page reload without another version request", async () => {
    const first = bridge();
    await settle();
    let requests = 0;
    const next = bridge({ localData: first.state.local, pageStorage: first.pageStorage, fetchUpdate: () => { requests++; throw new Error("offline"); } });
    await settle();
    assert.equal(next.banner()?.dataset.mode, "update");
    assert.equal(requests, 0);
});

test("failed update checks can retry after a short cooldown instead of waiting twelve hours", async () => {
    const now = Date.now();
    const first = bridge({ now, fetchUpdate: () => { throw new Error("offline"); } });
    await settle();
    const next = bridge({ now: now + 6 * 60 * 1000, localData: first.state.local, pageStorage: first.pageStorage });
    await settle();
    assert.equal(next.banner()?.dataset.mode, "update");
});
