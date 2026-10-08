import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../script/qq1000_pdd_recovery.js", import.meta.url), "utf8");
const NOTICE_ID = "qq1000-pdd-recovery-notice";
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); };
class Element {
    constructor(tag) { this.tagName = tag; this.children = []; this.listeners = new Map(); this.attributes = {}; this._text = ""; }
    set textContent(value) { this._text = String(value); this.children = []; }
    get textContent() { return this._text + this.children.map(child => child.textContent).join(""); }
    appendChild(child) { child.parentElement = this; this.children.push(child); return child; }
    remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this); this.parentElement = null; }
    setAttribute(name, value) { this.attributes[name] = value; }
    addEventListener(name, listener) { this.listeners.set(name, listener); }
    querySelector(selector) { return this.children.find(child => child.className === selector.slice(1)) || this.children.map(child => child.querySelector(selector)).find(Boolean) || null; }
}
function page({ initialStatus = { needsAttention: true, message: "上次保存结果不明，请确认后重试。" }, query, reset, origin = "https://mms.pinduoduo.com", top = true } = {}) {
    const root = new Element("html");
    const head = root.appendChild(new Element("head"));
    const body = root.appendChild(new Element("body"));
    const find = (node, id) => node.id === id ? node : node.children.map(child => find(child, id)).find(Boolean);
    const document = { head, body, documentElement: root, readyState: "complete", visibilityState: "visible", createElement: tag => new Element(tag), getElementById: id => find(root, id), addEventListener() {} };
    const windowListeners = new Map();
    const window = { location: { origin }, addEventListener: (name, listener) => windowListeners.set(name, listener) };
    window.top = top ? window : {};
    const listeners = [];
    const requests = [];
    const timers = new Map();
    let timerId = 0;
    let backendStatus = initialStatus;
    const chrome = { runtime: {
        onMessage: { addListener: listener => listeners.push(listener) },
        sendMessage(message, callback) {
            requests.push(message);
            if (message.type === "qq1000:pdd-recovery-state") {
                if (query) query(callback);
                else callback({ success: true, status: backendStatus });
            } else if (message.type === "pdd_clear_hijack_flag") {
                if (reset) reset(callback);
                else { backendStatus = { needsAttention: false, message: "" }; callback({ success: true }); }
            }
        },
    } };
    const context = vm.createContext({ window, document, chrome, setTimeout: (fn, ms) => { const id = ++timerId; timers.set(id, { fn, ms }); return id; }, clearTimeout: id => timers.delete(id) });
    vm.runInContext(source, context);
    return {
        requests, timers, listeners,
        notice: () => document.getElementById(NOTICE_ID),
        button: () => document.getElementById(NOTICE_ID)?.querySelector(".qq1000-pdd-recovery-reset"),
        click: () => document.getElementById(NOTICE_ID)?.querySelector(".qq1000-pdd-recovery-reset").listeners.get("click")(),
        push(status) { backendStatus = status; for (const listener of listeners) listener({ type: "qq1000:pdd-state", status }); },
        focus: () => windowListeners.get("focus")?.(),
        reinject: () => vm.runInContext(source, context),
    };
}

test("a late local content script queries the recovery state even if it missed the earlier notification", async () => {
    const app = page();
    await settle();
    assert.equal(app.requests[0].type, "qq1000:pdd-recovery-state");
    assert.match(app.notice().textContent, /上次保存结果不明/);
    assert.match(app.notice().textContent, /请先确认上次商品是否已保存/);
    assert.equal(app.button().textContent, "重置本页搬家任务");
    assert.equal(app.notice().attributes.role, "alert");
    assert.equal(app.timers.size, 0);
});

test("successful reset calls the existing clear command once and hides the notice", async () => {
    let respond;
    const app = page({ reset: callback => { respond = callback; } });
    await settle();
    const pending = app.click();
    void app.click();
    assert.equal(app.button().disabled, true);
    assert.equal(app.requests.filter(message => message.type === "pdd_clear_hijack_flag").length, 1);
    respond({ success: true });
    await pending;
    assert.equal(app.notice(), undefined);
});

test("reset failure keeps the notice and displays its reason", async () => {
    const app = page({ reset: callback => callback({ success: false, error: "浏览器暂时拒绝操作" }) });
    await settle();
    await app.click();
    assert.match(app.notice().textContent, /重置未完成：浏览器暂时拒绝操作/);
    assert.equal(app.button().disabled, false);
});

test("a successful retry push hides the notice and invalidates an older status query", async () => {
    let respond;
    const app = page({ query: callback => { respond = callback; } });
    app.push({ needsAttention: true, message: "需要确认" });
    assert.ok(app.notice());
    app.push({ needsAttention: false, message: "" });
    respond({ success: true, status: { needsAttention: true, message: "旧的恢复错误" } });
    await settle();
    assert.equal(app.notice(), undefined);
});

test("a delayed reset failure cannot overwrite a newer successful retry", async () => {
    let respond;
    const app = page({ reset: callback => { respond = callback; } });
    await settle();
    const pending = app.click();
    app.push({ needsAttention: false, message: "" });
    respond({ success: false, error: "旧操作失败" });
    await pending;
    assert.equal(app.notice(), undefined);
});

test("recovery messages are inert text and contain no local item or credential data", async () => {
    const app = page({ initialStatus: { needsAttention: true, message: "<img src=x onerror=alert(1)>" } });
    await settle();
    assert.match(app.notice().textContent, /<img src=x/);
    assert.equal(app.notice().innerHTML, undefined);
    await app.click();
    assert.deepEqual(app.requests.map(message => Object.keys(message)), [["type"], ["type"]]);
});

test("the recovery UI is confined to the top PDD merchant frame and reinjects only once", async () => {
    assert.equal(page({ origin: "https://item.taobao.com" }).requests.length, 0);
    assert.equal(page({ top: false }).requests.length, 0);
    const app = page();
    await settle();
    app.reinject();
    assert.equal(app.listeners.length, 1);
    assert.equal(app.requests.length, 1);
});
