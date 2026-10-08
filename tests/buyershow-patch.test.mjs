import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../script/qq1000_buyershow_download_patch.js", import.meta.url), "utf8");
const text = "买家昵称：测试用户\n评价内容：质量很好\nSKU：示例规格";
function app({ readonlyZip = false, lateZip = false } = {}) {
    const listeners = new Map();
    const files = [];
    function JSZip() {}
    JSZip.prototype.file = function (...args) { files.push(args); return this; };
    const originalFile = JSZip.prototype.file;
    const window = { Blob, addEventListener: (name, listener) => { const list = listeners.get(name) || []; list.push(listener); listeners.set(name, list); } };
    Object.defineProperty(window, "JSZip", { value: lateZip ? undefined : JSZip, configurable: !lateZip, writable: !readonlyZip, enumerable: true });
    const timers = new Map(); let timerId = 0;
    const context = vm.createContext({ window, Blob, Proxy, Reflect, Date, setInterval: callback => { const id = ++timerId; timers.set(id, callback); return id; }, clearInterval: id => timers.delete(id) });
    vm.runInContext(source, context);
    return { window, files, timers, originalFile, nativeZip: JSZip, installZip: () => { window.JSZip = JSZip; }, tick: () => [...timers.values()].forEach(callback => callback()), start: () => listeners.get("qq1000-buyershow-download-start")?.forEach(listener => listener({})), again: () => vm.runInContext(source, context), listeners };
}

test("unrelated merchant text Blob exports are not rewritten on installation", async () => {
    const fixture = app();
    const value = new fixture.window.Blob([text], { type: "text/plain" });
    assert.equal(await value.text(), text);
});

test("unrelated merchant JSZip files are not rewritten outside a buyer-show action", () => {
    const fixture = app();
    new fixture.window.JSZip().file("内容.txt", text);
    assert.equal(fixture.files[0][1], text);
});

test("the legacy sanitizer remains an explicitly callable pure compatibility function", () => {
    const fixture = app();
    assert.equal(fixture.window.__QQ1000_SANITIZE_BUYER_SHOW_TEXT__(text), "质量很好");
    assert.equal(fixture.window.Blob, Blob);
});

test("host Blob values passed to JSZip are never read or replaced", async () => {
    const fixture = app(); fixture.start();
    let reads = 0;
    const value = { type: "text/plain", text: async () => { reads++; throw new Error("temporary text read error"); } };
    new fixture.window.JSZip().file("评论1.txt", value);
    assert.equal(await fixture.files[0][1], value);
    assert.equal(reads, 0);
});

test("the JSZip assignment hook preserves a merchant's readonly property contract", () => {
    const fixture = app({ readonlyZip: true });
    const descriptor = Object.getOwnPropertyDescriptor(fixture.window, "JSZip");
    assert.equal(descriptor.writable, false);
    assert.equal(descriptor.set, undefined);
});

test("the explicit legacy helper still recognizes first-review text", () => {
    const fixture = app();
    assert.equal(fixture.window.__QQ1000_SANITIZE_BUYER_SHOW_TEXT__("买家昵称：示例\n首评内容：很好用\n评论时间：今天"), "很好用");
});

test("reinjection never registers page-wide download listeners or timers", () => {
    const fixture = app(); fixture.again(); fixture.again();
    assert.equal(fixture.listeners.size, 0);
    assert.equal(fixture.timers.size, 0);
});

test("late nonconfigurable JSZip globals remain native after download events", () => {
    const fixture = app({ lateZip: true });
    assert.equal(fixture.timers.size, 0);
    fixture.start();
    assert.equal(fixture.timers.size, 0);
    fixture.installZip(); fixture.tick();
    new fixture.window.JSZip().file("评论1.txt", text);
    assert.equal(fixture.files[0][1], text);
    assert.equal(fixture.timers.size, 0);
});

test("merchant Blob exports remain byte-for-byte unchanged after an explicit buyer-show start", async () => {
    const fixture = app(); fixture.start();
    assert.equal(await new fixture.window.Blob([text], { type: "text/plain" }).text(), text);
});

test("merchant JSZip exports remain unchanged after an explicit buyer-show start", () => {
    const fixture = app(); fixture.start();
    new fixture.window.JSZip().file("评论1.txt", text);
    assert.equal(fixture.files[0][1], text);
});

test("native constructors and JSZip file methods are never replaced", () => {
    const fixture = app(); fixture.start(); fixture.again();
    assert.equal(fixture.window.Blob, Blob);
    assert.equal(fixture.window.JSZip, fixture.nativeZip);
    assert.equal(fixture.window.JSZip.prototype.file, fixture.originalFile);
});
