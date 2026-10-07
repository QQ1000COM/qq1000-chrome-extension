import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { runtimeMessageError, canForwardCookie, forwardCookieChange, isAuthenticatedApiUrl } from "../script/qq1000_security_policy.mjs";

const root = new URL("../", import.meta.url);
const read = name => fs.readFileSync(new URL(name, root), "utf8");
const sender = { id: "test-extension", origin: "https://item.taobao.com", url: "https://item.taobao.com/item.htm", tab: { id: 7 } };
const validate = request => runtimeMessageError(request, sender, sender.id);

test("runtime policy rejects forged senders and lookalike hosts", () => {
    assert.match(runtimeMessageError({}, { id: "other" }, sender.id), /sender/);
    for (const origin of ["https://item.taobao.com.evil.example", "https://eviltaobao.com", "http://tu.qq1000.com", "https://elsewhere.qq1000.com"]) {
        assert.match(runtimeMessageError({ cmd: "start" }, { ...sender, origin }, sender.id), /origin/);
    }
    assert.equal(validate({ cmd: "start" }), null);
    assert.match(validate(null), /message/);
});

test("observed SDK browser operations remain available; arbitrary APIs and batch bypasses fail", () => {
    for (const api of ["tabs.query", "tabs.create", "downloads.download", "notifications.create", "runtime.getManifest", "runtime.getPlatformInfo"]) {
        assert.equal(validate({ type: "chrome_api_call", api, params: [] }), null, api);
    }
    for (const api of ["scripting.executeScript", "cookies.getAll", "storage.sync.get", "runtime.sendMessage", "declarativeNetRequest.updateDynamicRules", "constructor.constructor"]) {
        assert.match(validate({ type: "chrome_api_call", api, params: [] }), /not available/, api);
        assert.match(validate({ type: "chrome_api_batch_call", calls: [{ api, params: [] }] }), /not available/, api);
    }
    assert.match(validate({ type: "chrome_api_batch_call", calls: new Array(51).fill({ api: "tabs.query" }) }), /not available/);
});

test("dedicated cookie adapters reject browser-wide, portal, unrelated, and disguised domains", () => {
    for (const myDomain of [undefined, "", ".qq1000.com", "tu.qq1000.com", ".github.com", "taobao.com.evil.example", "taobao.com@evil.example"]) {
        assert.match(validate({ type: "getCookies", myDomain }), /Cookie target/);
    }
    assert.equal(validate({ type: "getCookies", myDomain: ".taobao.com" }), null);
    assert.equal(validate({ type: "cookie", action: "getAll", domain: ".jd.com" }), null);
    assert.match(validate({ type: "cookie", action: "setBatch", cookieList: [{ url: "https://item.taobao.com", domain: ".github.com" }] }), /Cookie target/);
    assert.match(validate({ type: "setCookies", data: { domainUrl: "https://taobao.com", cookieData: [{ detail: { url: "https://github.com" } }] } }), /Cookie target/);
});

test("authenticated proxy cannot send credentials to other origins or escape plugin API path", () => {
    for (const url of ["https://evil.example/", "https://tu.qq1000.com.evil.example/plugin/api/info", "https://user:pass@tu.qq1000.com/plugin/api/info", "http://tu.qq1000.com/plugin/api/info", "/plugin/api/../../admin", "/admin", "//evil.example/plugin/api/info"]) {
        assert.equal(isAuthenticatedApiUrl(url), false, url);
        assert.match(validate({ type: "proxy_api_request", apiConfig: { url, needAuth: true } }), /Authentication/);
    }
    for (const url of ["/plugin/api/user/info", "https://tu.qq1000.com/plugin/api/user/info"]) assert.equal(isAuthenticatedApiUrl(url), true);
});

test("cookie notifications preserve same-site readable cookies and stop sensitive/global broadcast", () => {
    const cookie = { domain: ".taobao.com", path: "/seller", secure: true, name: "example", value: "synthetic", httpOnly: false };
    assert.equal(canForwardCookie(cookie, "https://myseller.taobao.com/seller/item"), true);
    for (const url of ["https://github.com/seller", "https://taobao.com.evil.example/seller", "https://taobao.com/seller-other", "http://taobao.com/seller"]) assert.equal(canForwardCookie(cookie, url), false);
    assert.equal(canForwardCookie({ ...cookie, httpOnly: true }, "https://taobao.com/seller"), false);
    assert.equal(canForwardCookie({ ...cookie, partitionKey: {} }, "https://taobao.com/seller"), false);
    const sent = [];
    forwardCookieChange({ cookie }, { runtime: {}, tabs: { query: (_, callback) => callback([{ id: 1, url: "https://taobao.com/seller" }, { id: 2, url: "https://github.com/seller" }]), sendMessage: (...args) => sent.push(args) } });
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0][2], { frameId: 0 });
});

test("actual service worker listener checks policy before dispatch and does not race login handler", async () => {
    const source = read("script/service_worker_new.js");
    const start = source.indexOf("chrome.runtime.onMessage.addListener((e,t,r)=>");
    const end = source.indexOf(",messageRouter.registerMultiple", start);
    let listener;
    const calls = [];
    vm.runInNewContext(source.slice(start, end), { chrome: { runtime: { id: sender.id, onMessage: { addListener: fn => { listener = fn; } } } }, runtimeMessageError, messageRouter: { hasCommand: () => false }, handleMessage: async request => { calls.push(request); return { success: true }; }, console });
    const rejected = [];
    listener({ type: "chrome_api_call", api: "cookies.getAll", params: [{}] }, sender, result => rejected.push(result));
    assert.equal(calls.length, 0);
    assert.equal(rejected[0].success, false);
    assert.equal(listener({ cmd: "qq1000:open-login" }, sender, () => assert.fail("duplicate responder")), false);
    await new Promise(resolve => listener({ cmd: "start" }, sender, resolve));
    assert.equal(calls.length, 1);
});

class Element {
    constructor(tag) { this.tagName = tag; this.children = []; this.style = {}; this.classList = { toggle() {} }; this._text = ""; }
    set textContent(value) { this._text = String(value); this.children = []; }
    get textContent() { return this._text + this.children.map(child => child.textContent).join(""); }
    appendChild(child) { this.children.push(child); return child; }
    replaceChildren() { this.children = []; this._text = ""; }
}

function popupContext(fetchImpl) {
    const removed = [];
    const area = { remove: (keys, callback) => { removed.push(keys); callback(); }, get: (_, callback) => callback({}) };
    const context = vm.createContext({ document: { addEventListener() {}, createElement: tag => new Element(tag) }, window: { localStorage: { removeItem: key => removed.push(key) } }, chrome: { storage: { sync: area, local: area } }, fetch: fetchImpl, AbortController, setTimeout, clearTimeout, URLSearchParams });
    vm.runInContext(read("popup.js"), context);
    return { context, removed };
}

test("popup renders remote quota strings as inert text", () => {
    const { context } = popupContext();
    const box = new Element("div");
    context.box = box;
    context.rows = [{ icon: "<img src=x>", name: "<a href=https://evil.example>Login</a>", remaining: "<svg>", quota: "<iframe>", unit: "</small><form>" }];
    vm.runInContext("els.quotaList=box; renderQuotas(rows, false)", context);
    assert.ok(box.textContent.includes("<a href=https://evil.example>Login</a>"));
    assert.deepEqual(box.children[0].children.map(child => child.tagName), ["span", "span"]);
    assert.equal(box.innerHTML, undefined);
});

test("popup rejects HTTP authentication errors and clears every token fallback", async () => {
    let options;
    const { context, removed } = popupContext(async (_, init) => { options = init; return { status: 401 }; });
    const result = await vm.runInContext("apiRequest('/plugin/api/user/info', { token: 'synthetic' })", context);
    assert.equal(result.code, 401);
    assert.equal(options.redirect, "error");
    await vm.runInContext("clearStoredSession()", context);
    assert.ok(removed.some(keys => Array.isArray(keys) && keys.includes("cj-plugin-token")));
    assert.ok(removed.includes("cj-tools-plugin-token"));
});

test("actual content bridge ignores malformed and foreign window/origin messages", () => {
    const listeners = new Map();
    const sent = [];
    const window = { location: { origin: "https://item.taobao.com", href: "https://item.taobao.com/item.htm" }, frameElement: null, addEventListener: (name, fn) => listeners.set(name, fn), postMessage() {} };
    window.top = window;
    const chrome = { runtime: { id: sender.id, sendMessage: (message, callback) => { sent.push(message); if (callback) callback({ success: true }); return Promise.resolve({}); }, onMessage: { addListener() {} } } };
    vm.runInNewContext(read("script/content_script_loader_v3.js"), { window, chrome, console, URL });
    const receive = listeners.get("message");
    const event = { source: window, origin: window.location.origin, data: { type: "chrome_runtime_sendMessage", messageId: "synthetic", message: { cmd: "get_manifest_version" } } };
    const count = sent.length;
    receive({ ...event, origin: "https://evil.example" });
    receive({ ...event, source: {} });
    receive({ ...event, data: null });
    assert.equal(sent.length, count);
    receive(event);
    assert.equal(sent.length, count + 1);
    // about:blank content frames inherit their document origin although the
    // location URL itself has the serialized origin "null".
    window.origin = "https://item.taobao.com";
    window.location = { origin: "null", href: "about:blank" };
    receive(event);
    assert.equal(sent.length, count + 2);
});

test("network bootstrap refuses authenticated asset redirects", async () => {
    const calls = [];
    globalThis.self = { fetch: async (input, init) => { calls.push({ input, init }); return { status: 200 }; } };
    globalThis.chrome = { runtime: { onMessage: { addListener() {} } }, storage: { sync: { get: async () => ({ "cj-user-token": "synthetic" }) }, onChanged: { addListener() {} } } };
    try {
        await import("../script/qq1000_network_bootstrap.mjs");
        await self.fetch("https://tu.qq1000.com/plugin-static/test.js");
        await self.fetch("https://example.com/image.png");
        assert.equal(calls[0].init.headers.get("user-token"), "synthetic");
        assert.equal(calls[0].init.redirect, "error");
        assert.equal(calls[1].init, undefined);
    } finally { delete globalThis.self; delete globalThis.chrome; }
});
