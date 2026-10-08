import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../script/qq1000_ui_overrides.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
function fn(name) {
    const start = source.indexOf(`    function ${name}(`);
    assert.notEqual(start, -1);
    const end = source.indexOf("\n    }\n", start);
    assert.notEqual(end, -1);
    return source.slice(start, end + 7);
}
const settle = async () => { for (let index = 0; index < 5; index++) await new Promise(resolve => setImmediate(resolve)); };

class Node {
    constructor(name = "div") { this.name = name; this.children = []; this.dataset = {}; this.style = {}; this.classList = { add() {}, contains: () => false }; this.connectedRoot = false; }
    get isConnected() { return this.connectedRoot || !!this.parentElement?.isConnected; }
    appendChild(child) { if (child.parentElement) child.parentElement.children = child.parentElement.children.filter(item => item !== child); child.parentElement = this; this.children.push(child); }
    setAttribute(name, value) { this[name] = value; }
    querySelectorAll() { return []; }
    querySelector() { return null; }
    closest() { return null; }
    insertAdjacentElement(_position, node) { this.appendChild(node); }
}

function grouping(hasAnchor = true) {
    const dock = new Node(); dock.connectedRoot = true;
    const buttons = ["复制SKU", "评论分析", "下载主图", "选品池"].map(label => { const node = new Node("button"); dock.appendChild(node); return { label, element: node }; });
    const context = vm.createContext({
        document: { querySelector: () => null, getElementById: id => hasAnchor && id === "gg-top" ? dock : null, createElement: name => new Node(name), documentElement: { removeAttribute() {} } },
        PANEL_ID: "cj-goods-side-panel-root", TOOLS_ATTR: "data-qq1000-tools", TOOL_BUTTON_CLASSES: ["jc-top-btn-text"],
        TOOL_GROUPS: [{ title: "工具", labels: buttons.map(item => item.label) }], collectToolButtons: () => buttons,
        removeNode() {}, hasVisibleText: () => true, cleanupSeparatorOnlyRows() {},
    });
    vm.runInContext(fn("buildToolGroups"), context);
    return { buttons, dock, run: () => vm.runInContext("buildToolGroups()", context) };
}

test("docked gg-top tool groups remain attached and visible", () => {
    const app = grouping();
    assert.equal(app.run(), true);
    assert.ok(app.buttons.every(item => item.element.isConnected));
});

test("missing toolbar anchors never detach the original tool buttons", () => {
    const app = grouping(false);
    assert.equal(app.run(), false);
    assert.equal(app.dock.children.length, 4);
    assert.ok(app.buttons.every(item => item.element.isConnected));
});

test("SPA replacement invalidates cached detached toolbar roots", () => {
    const stale = { isConnected: false };
    const fresh = { isConnected: true };
    const context = vm.createContext({ Date: { now: () => 1050 }, toolRootsCache: { at: 1000, roots: [stale] }, PANEL_ID: "panel", document: { getElementById: id => id === "panel" ? fresh : null, querySelectorAll: () => [] } });
    vm.runInContext(fn("toolRoots"), context);
    assert.equal(vm.runInContext("toolRoots()[0]", context), fresh);
});

test("separator cleanup preserves empty-looking image and form containers", () => {
    const removed = [];
    const imageBox = { parentElement: {}, children: [{}], textContent: "", closest: () => null, querySelector: () => null };
    const formBox = { ...imageBox };
    const root = { querySelectorAll: selector => selector === "div" ? [imageBox, formBox] : [] };
    const context = vm.createContext({ toolRoots: () => [root], TOOLS_ATTR: "data-qq1000-tools", TOOL_BUTTON_CLASSES: ["jc-top-btn-text"], hasVisibleText: () => false, removeNode: node => removed.push(node) });
    vm.runInContext(fn("cleanupSeparatorOnlyRows"), context);
    vm.runInContext("cleanupSeparatorOnlyRows()", context);
    assert.equal(removed.length, 0);
});

test("the product-library tab purge cannot remove a merchant's own tab", () => {
    const hostTab = { textContent: "商品库", parentElement: {}, closest: () => null, remove() { this.removed = true; } };
    const pluginTab = { ...hostTab, closest: () => ({}) };
    const tail = source.slice(source.indexOf("/* qq1000: 只保留"));
    vm.runInNewContext(tail, { window: {}, document: { querySelectorAll: () => [hostTab, pluginTab] }, setInterval() {} });
    assert.equal(hostTab.removed, undefined);
    assert.equal(pluginTab.removed, true);
});

function portal() {
    const requests = [];
    const renders = [];
    let resolve;
    const network = new Promise(done => { resolve = done; });
    let token = "synthetic-first";
    const context = vm.createContext({
        Date, AbortController, setTimeout, clearTimeout, API_HOST: "https://tu.qq1000.com", PORTAL_TTL: 15000, PORTAL_REQUEST_TIMEOUT_MS: 12000,
        portalInflight: null, portalFetchedAt: 0, portalSignature: "", portalReloadRequested: false, portalSessionGeneration: 0, readUserToken: async () => token,
        fetch: async (url, options) => { requests.push({ url, options }); return network; },
        portalSignatureOf: data => JSON.stringify(data), renderPortalConfig: data => renders.push(data), scheduleApply() {},
    });
    vm.runInContext(fn("loadOnlinePortalConfig"), context);
    return { requests, renders, run: () => vm.runInContext("loadOnlinePortalConfig(true)", context), switchToken: () => { token = "synthetic-second"; }, finish: () => resolve({ ok: true, status: 200, json: async () => ({ code: 0, state: true, data: { branding: { aiLabel: "example" } } }) }) };
}

test("forced portal refreshes share one inflight authenticated request", async () => {
    const app = portal();
    const one = app.run(); const two = app.run();
    await settle();
    const count = app.requests.length;
    app.finish(); await Promise.all([one, two]);
    assert.equal(count, 1);
});

test("portal requests use permitted CORS headers, POST, a timeout signal and no credential redirects", async () => {
    const app = portal(); const work = app.run();
    await settle(); app.finish(); await work;
    const options = app.requests[0].options;
    assert.deepEqual(Object.keys(options.headers).map(key => key.toLowerCase()), ["user-token"]);
    assert.equal(options.method, "POST");
    assert.equal(options.redirect, "error");
    assert.ok(options.signal instanceof AbortSignal);
});

test("a late portal configuration response cannot replace the new account's UI", async () => {
    const app = portal(); const work = app.run();
    await settle(); app.switchToken(); app.finish(); await work;
    assert.equal(app.renders.length, 0);
});

test("changing a move-panel advertisement updates one listener instead of opening old links", () => {
    const urls = [];
    const listeners = [];
    const entry = { dataset: {}, style: { setProperty() {}, removeProperty() {} }, setAttribute() {}, querySelector: () => null, addEventListener: (_event, listener) => listeners.push(listener) };
    const node = { textContent: "礼品代发", parentElement: entry, dataset: {}, closest: () => entry };
    const context = vm.createContext({ API_HOST: "https://tu.qq1000.com", URL, MOVE_AD_SLOTS: [{ label: "礼品代发", match: /礼品/ }], directLabelNode: () => node, normalizeText: value => value, removeNode() {}, window: { open: url => urls.push(url) }, openLink: url => urls.push(url), ads: { move_panel: [{ id: "configured", enabled: true, title: "礼品代发", linkUrl: "https://example.com/old" }] } });
    for (const name of ["absoluteUrl", "adBoolean", "adTimestamp", "normalizeAd", "adsForPlacement", "applyAdBadge"]) vm.runInContext(fn(name), context);
    vm.runInContext(fn("applyMovePanelAds"), context);
    vm.runInContext("applyMovePanelAds(ads)", context);
    context.ads.move_panel[0].linkUrl = "https://example.com/new";
    vm.runInContext("applyMovePanelAds(ads)", context);
    listeners.forEach(listener => listener({ preventDefault() {}, stopPropagation() {}, stopImmediatePropagation() {} }));
    assert.deepEqual(urls, ["https://example.com/new"]);
});

test("generic merchant customer-service dialogs remain open while plugin-owned dialogs can close", () => {
    const closed = [];
    const removed = [];
    function wrapper(owned) {
        const button = { dataset: {}, getAttribute: () => "关闭", click: () => closed.push(owned) };
        return {
            closest: () => owned ? {} : null,
            querySelector: selector => selector === ".el-dialog__title" ? { textContent: "联系客服" } : null,
            querySelectorAll: selector => selector === "img" ? [{ getAttribute: () => "客服二维码" }] : selector === "button" ? [button] : [],
        };
    }
    const host = wrapper(false); const plugin = wrapper(true);
    const context = vm.createContext({ document: { querySelectorAll: selector => selector === ".el-dialog__wrapper" ? [host, plugin] : [] }, normalizeText: value => value, hasClass: () => false, removeNode: node => removed.push(node), setTimeout: fn => fn() });
    vm.runInContext(fn("removeCustomerServiceUi"), context);
    vm.runInContext("removeCustomerServiceUi()", context);
    assert.deepEqual(closed, [true]);
    assert.deepEqual(removed, [plugin]);
});

test("many mount mutations share a single delayed panel reveal", () => {
    const timers = [];
    const context = vm.createContext({ panelContainers: () => [{ classList: { contains: () => false } }], installStyle() {}, removeFeaturesByLabel() {}, buildToolGroups: () => false, markPanelsReady() {}, panelReadyTimer: null, clearTimeout() {}, setTimeout: callback => { timers.push(callback); return timers.length; } });
    vm.runInContext(fn("syncPanelMount"), context);
    for (let index = 0; index < 5; index++) vm.runInContext("syncPanelMount()", context);
    assert.equal(timers.length, 1);
});

test("portal token reads consume runtime errors and recover through local storage", async () => {
    let activeError = null;
    let errorReads = 0;
    const runtime = { get lastError() { if (activeError) errorReads++; return activeError; } };
    const chrome = { runtime, storage: {
        sync: { get: (_keys, callback) => setImmediate(() => { activeError = { message: "sync unavailable" }; callback({}); activeError = null; }) },
        local: { get: (_keys, callback) => setImmediate(() => callback({ "cj-user-token": "local-synthetic" })) },
    } };
    const context = vm.createContext({ chrome });
    vm.runInContext(fn("readUserToken"), context);
    assert.equal(await vm.runInContext("readUserToken()", context), "local-synthetic");
    assert.equal(errorReads, 1);
});
