import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { PddHijackState, isPddBlockRule, PDD_RULE_BASE, PDD_RULE_LIMIT, PDD_EDIT_FILTER } from "../script/qq1000_pdd_state.mjs";

const clone = value => structuredClone(value);
const settle = async () => { for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve)); };
const ownedRule = (id, tabId) => ({ id, priority: 2, action: { type: "block" }, condition: { urlFilter: PDD_EDIT_FILTER, resourceTypes: ["xmlhttprequest", "other"], tabIds: [tabId] } });
const stateFor = tabId => ({ goodsDetail: { productId: "synthetic-" + tabId }, documentId: "document-" + tabId, frameId: 0 });

function fixture() {
    const rules = new Map();
    const session = {};
    const missingTabs = new Set();
    const documents = new Map();
    const faults = { add: false, remove: false, storage: false, read: false };
    const notices = [];
    const chrome = {
        declarativeNetRequest: {
            getSessionRules: async () => { if (faults.read) throw new Error("synthetic rule read failure"); return clone([...rules.values()]); },
            updateSessionRules: async update => {
                await new Promise(resolve => setImmediate(resolve));
                if (faults.add && update.addRules?.length) throw new Error("synthetic rule add failure");
                if (faults.remove && update.removeRuleIds?.length) throw new Error("synthetic rule removal failure");
                const next = new Map(rules);
                for (const id of update.removeRuleIds || []) next.delete(id);
                for (const rule of update.addRules || []) {
                    if (!Number.isInteger(rule.id) || rule.id <= 0 || rule.id > 2147483647 || next.has(rule.id)) throw new Error("invalid or duplicate rule ID");
                    next.set(rule.id, clone(rule));
                }
                rules.clear();
                for (const [id, rule] of next) rules.set(id, rule);
            },
        },
        storage: { session: {
            get: async keys => keys === null ? clone(session) : Object.fromEntries(keys.filter(key => key in session).map(key => [key, clone(session[key])])),
            set: async values => { if (faults.storage) throw new Error("synthetic session write failure"); Object.assign(session, clone(values)); },
            remove: async keys => { for (const key of Array.isArray(keys) ? keys : [keys]) delete session[key]; },
        } },
        tabs: { get: async tabId => { if (missingTabs.has(tabId)) throw new Error("Tab closed"); return { id: tabId, url: "https://mms.pinduoduo.com/goods/list" }; } },
        webNavigation: { getFrame: async ({ tabId }) => ({ documentId: documents.get(tabId) || "document-" + tabId }) },
    };
    const create = (options = {}) => new PddHijackState(chrome, { now: () => 10000, onFailure: async (tabId, error) => notices.push({ tabId, error }), ...options });
    return { rules, session, faults, missingTabs, documents, notices, chrome, create };
}

test("parallel PDD tabs whose IDs differ by 1000 receive distinct bounded rules", async () => {
    const app = fixture();
    const manager = app.create();
    manager.nextRuleId = PDD_RULE_LIMIT - 1;
    const tabs = [7, 1007, 2147483007];
    const results = await Promise.all(tabs.map(tabId => manager.arm(tabId, stateFor(tabId))));
    assert.ok(results.every(result => result.success));
    assert.equal(new Set(results.map(result => result.ruleId)).size, tabs.length);
    assert.ok(results.every(result => result.ruleId >= PDD_RULE_BASE && result.ruleId < PDD_RULE_LIMIT && result.ruleId <= 2147483647));
    assert.deepEqual([...app.rules.values()].flatMap(rule => rule.condition.tabIds).sort((a, b) => a - b), tabs);
});

test("worker restart restores the item only when the matching session rule and document still exist", async () => {
    const app = fixture();
    const previous = app.create();
    const armed = await previous.arm(7, stateFor(7));
    const restored = app.create();
    await restored.ready;
    const job = await restored.claim(7);
    assert.equal(job.goodsDetail.productId, "synthetic-7");
    assert.equal(job.ruleId, armed.ruleId);
    assert.equal(restored.processing.has(7), true);
});

test("a restarted worker never replays an interrupted processing or sending operation", async () => {
    for (const sending of [false, true]) {
        const app = fixture();
        const previous = app.create();
        await previous.arm(7, stateFor(7));
        const job = await previous.claim(7);
        if (sending) await previous.prepareSend(7, job.ruleId);
        const restored = app.create();
        await restored.ready;
        assert.equal(restored.flags[7], undefined);
        assert.ok(app.notices.length > 0);
        await assert.rejects(restored.claim(7), /状态已失效|结果不明/);
    }
});

test("an old document or an orphan legacy rule requires an explicit retry", async () => {
    const app = fixture();
    const previous = app.create();
    await previous.arm(7, stateFor(7));
    app.documents.set(7, "new-document");
    app.rules.set(910099, ownedRule(910099, 99));
    const restored = app.create();
    await restored.ready;
    assert.equal(restored.flags[7], undefined);
    assert.equal(restored.flags[99], undefined);
    await assert.rejects(restored.claim(99), /状态已失效|结果不明/);
    assert.equal((await restored.arm(99, stateFor(99))).success, true);
    assert.equal((await restored.claim(99)).goodsDetail.productId, "synthetic-99");
});

test("rule or session persistence failures cannot arm a transformation", async () => {
    for (const fault of ["add", "storage", "read"]) {
        const app = fixture();
        const manager = app.create();
        await manager.ready;
        app.faults[fault] = true;
        const result = await manager.arm(7, stateFor(7));
        assert.equal(result.success, false, fault);
        assert.equal(manager.flags[7], undefined, fault);
        assert.equal(app.rules.size, 0, fault);
        assert.equal(Object.keys(app.session).length, 0, fault);
    }
});

test("startup recovery failure is explicit and cannot arm a transformation", async () => {
    const app = fixture();
    app.faults.read = true;
    const manager = app.create();
    assert.equal(await manager.ready, false);
    const result = await manager.arm(7, stateFor(7));
    assert.equal(result.success, false);
    assert.match(result.error, /状态恢复失败/);
    assert.equal(manager.flags[7], undefined);
    assert.equal(app.rules.size, 0);
});

test("a lost block fails the claim and removal failure prevents preparing a send", async () => {
    const app = fixture();
    const manager = app.create();
    await manager.arm(7, stateFor(7));
    app.rules.clear();
    await assert.rejects(manager.claim(7), /未能继续|页面已变化/);
    assert.equal(manager.processing.has(7), false);
    await manager.arm(7, stateFor(7));
    const job = await manager.claim(7);
    app.faults.remove = true;
    await assert.rejects(manager.prepareSend(7, job.ruleId), /rule removal failure/);
    assert.equal(app.rules.size, 1);
});

test("clearing or closing one tab touches only precisely owned rules for that tab", async () => {
    const app = fixture();
    const manager = app.create();
    await manager.arm(7, stateFor(7));
    const other = await manager.arm(1007, stateFor(1007));
    const unrelated = ownedRule(910999, 7);
    unrelated.condition.urlFilter = "unrelated.example/path";
    app.rules.set(unrelated.id, unrelated);
    app.rules.set(10500, { id: 10500, action: { type: "modifyHeaders" } });
    assert.equal((await manager.clear(7, { closed: true })).success, true);
    assert.equal(app.rules.has(other.ruleId), true);
    assert.equal(app.rules.has(unrelated.id), true);
    assert.equal(app.rules.has(10500), true);
    assert.equal(manager.flags[7], undefined);
    assert.ok(manager.flags[1007]);
    assert.equal(Object.keys(app.session).length, 1);
});

test("cancelled jobs cannot send, and late cleanup cannot remove a newer armed job", async () => {
    const app = fixture();
    const manager = app.create();
    await manager.arm(7, stateFor(7));
    const old = await manager.claim(7);
    await manager.clear(7);
    await assert.rejects(manager.prepareSend(7, old.ruleId), /已取消/);
    assert.equal((await manager.arm(7, stateFor(7))).success, false);
    await manager.finish(7, old.ruleId);
    const current = await manager.arm(7, stateFor(7));
    await manager.finish(7, old.ruleId);
    assert.equal(app.rules.has(current.ruleId), true);
    assert.equal(manager.flags[7].ruleId, current.ruleId);
});

test("startup cleanup removes closed-tab rules and ignores unrelated rules in the same ID range", async () => {
    const app = fixture();
    app.rules.set(910007, ownedRule(910007, 7));
    const foreign = ownedRule(910099, 99);
    foreign.priority = 1;
    app.rules.set(foreign.id, foreign);
    app.missingTabs.add(7);
    const manager = app.create();
    await manager.ready;
    assert.equal(app.rules.has(910007), false);
    assert.equal(app.rules.has(910099), true);
    assert.equal(isPddBlockRule(foreign), false);
});

test("arm fills a missing document ID from Chrome and refuses unverifiable documents", async () => {
    const app = fixture();
    const manager = app.create();
    const armed = await manager.arm(7, { goodsDetail: { productId: "synthetic" } });
    assert.equal(armed.success, true);
    assert.equal(manager.flags[7].documentId, "document-7");
    app.chrome.webNavigation.getFrame = async () => ({});
    const failed = await manager.arm(8, { goodsDetail: { productId: "synthetic" } });
    assert.equal(failed.success, false);
    assert.match(failed.error, /无法确认当前页面/);
    assert.equal(manager.flags[8], undefined);
});

test("old snapshots without document identity are never replayed", async () => {
    const app = fixture();
    const previous = app.create();
    await previous.arm(7, stateFor(7));
    delete app.session[previous.key(7)].documentId;
    const restarted = app.create();
    await restarted.ready;
    assert.equal(restarted.flags[7], undefined);
    assert.equal((await restarted.getStatus(7)).needsAttention, true);
    await assert.rejects(restarted.claim(7), /状态已失效|结果不明/);
});

test("a navigation cleanup delayed by startup cannot delete a task armed for the current document", async () => {
    for (const armFirst of [false, true]) {
        const app = fixture();
        const previous = app.create();
        await previous.arm(7, stateFor(7));
        app.documents.set(7, "new-document");
        let release;
        const gate = new Promise(resolve => { release = resolve; });
        const read = app.chrome.storage.session.get;
        app.chrome.storage.session.get = async keys => { if (keys === null) await gate; return read(keys); };
        const restarted = app.create();
        let navigation, arm;
        if (armFirst) {
            arm = restarted.arm(7, { ...stateFor(7), documentId: "new-document" });
            navigation = restarted.handleNavigation({ tabId: 7, frameId: 0, documentId: "new-document" });
        } else {
            navigation = restarted.handleNavigation({ tabId: 7, frameId: 0, documentId: "new-document" });
            arm = restarted.arm(7, { ...stateFor(7), documentId: "new-document" });
        }
        release();
        const [result] = await Promise.all([arm, navigation]);
        assert.equal(result.success, true);
        assert.equal(app.rules.has(result.ruleId), true);
        assert.equal(restarted.flags[7].documentId, "new-document");
    }
});

test("recovery status survives worker restart and exposes no item or credential payload", async () => {
    const app = fixture();
    const previous = app.create();
    await previous.arm(7, stateFor(7));
    const job = await previous.claim(7);
    await previous.prepareSend(7, job.ruleId);
    const firstRestart = app.create();
    await firstRestart.ready;
    const secondRestart = app.create();
    await secondRestart.ready;
    const status = await secondRestart.getStatus(7);
    assert.equal(status.needsAttention, true);
    assert.deepEqual(Object.keys(status).sort(), ["message", "needsAttention"]);
    assert.doesNotMatch(JSON.stringify(status), /goodsDetail|synthetic-7|user-token|ruleId/);
    assert.equal((await secondRestart.clear(7)).success, true);
    assert.equal((await secondRestart.getStatus(7)).needsAttention, false);
});

test("recovery, retry and clear outcomes push only public status for the local notice", async () => {
    const app = fixture();
    app.rules.set(910007, ownedRule(910007, 7));
    const changes = [];
    const manager = app.create({ onStateChange: (_, status) => changes.push(status) });
    await manager.ready;
    assert.equal(changes.at(-1).needsAttention, true);
    await manager.arm(7, stateFor(7));
    assert.equal(changes.at(-1).needsAttention, false);
    app.faults.remove = true;
    assert.equal((await manager.clear(7)).success, false);
    assert.equal(changes.at(-1).needsAttention, true);
    app.faults.remove = false;
    assert.equal((await manager.clear(7)).success, true);
    assert.equal(changes.at(-1).needsAttention, false);
    for (const status of changes) assert.deepEqual(Object.keys(status).sort(), ["message", "needsAttention"]);
});

function interceptor(state) {
    const source = fs.readFileSync(new URL("../script/service_worker_new.js", import.meta.url), "utf8");
    const start = source.indexOf("function registerPddInterceptor()");
    const end = source.indexOf("async function handleMessage(", start);
    let receive;
    const calls = { transform: 0, send: 0, failed: 0, finished: 0 };
    const context = vm.createContext({
        chrome: { webRequest: { onBeforeRequest: { addListener: listener => { receive = listener; } } }, cookies: { getAll: async () => [] } },
        pddHijackState: state, pddHijackTrace() {}, processingTabIds: new Set(), hijackFlags: {}, pddBlockRuleByTab: new Map(),
        console: { error() {} }, TextDecoder, Uint8Array, URL, navigator: { userAgent: "synthetic" },
        setTimeout: callback => { callback(); return 1; },
        PDD_TRANSFORM_TIMEOUT_MS: 30000, PDD_PAGE_SEND_TIMEOUT_MS: 30000, PDD_HIJACK_FLAG_TTL_MS: 300000,
        PDD_MMS_ORIGIN: "https://mms.pinduoduo.com", PDD_ERROR_CODE: { UNKNOWN: "unknown", REQUEST_BODY_EMPTY: "empty", SEND_NETWORK: "network" },
        transformRequestBodyWithTimeout: async (_, body) => { calls.transform++; return body; },
        sendPagePddEditRequest: async () => { calls.send++; return { success: true }; },
        finishHijackSuccess: async () => { calls.finished++; },
        finishHijackFailure: async () => { calls.failed++; },
        notifyPageHijackResult: async () => { calls.failed++; },
        summarizePddEditBody: () => ({}), buildAbnormalFailPayload: () => ({}), shouldUseProxyFallback: () => false,
    });
    vm.runInContext(source.slice(start, end) + ";registerPddInterceptor();", context);
    const send = () => receive({ tabId: 7, frameId: 0, url: "https://mms.pinduoduo.com/glide/mms/goodsCommit/action/edit", requestBody: { raw: [{ bytes: new TextEncoder().encode('{"synthetic":true}').buffer }] } });
    return { send, calls };
}

test("the actual webRequest handler stops before transformation when rule recovery fails", async () => {
    const app = interceptor({ claim: async () => { throw new Error("synthetic recovery failure"); } });
    app.send();
    await settle();
    assert.equal(app.calls.transform, 0);
    assert.equal(app.calls.send, 0);
    assert.equal(app.calls.failed, 1);
});

test("the actual webRequest handler never sends when its required block cannot be safely removed", async () => {
    const app = interceptor({
        claim: async () => ({ ruleId: 910001, goodsDetail: {} }),
        isCurrent: () => true,
        prepareSend: async () => { throw new Error("synthetic remove failure"); },
        finish: async () => ({ success: true }),
    });
    app.send();
    await settle();
    assert.equal(app.calls.transform, 1);
    assert.equal(app.calls.send, 0);
    assert.equal(app.calls.failed, 1);
});

test("the actual webRequest success path sends once and releases its rule and stored task", async () => {
    const browser = fixture();
    const manager = browser.create();
    await manager.arm(7, stateFor(7));
    const app = interceptor(manager);
    app.send();
    app.send();
    await settle();
    assert.equal(app.calls.transform, 1);
    assert.equal(app.calls.send, 1);
    assert.equal(app.calls.failed, 0);
    assert.equal(app.calls.finished, 1);
    assert.equal(manager.processing.size, 0);
    assert.equal(browser.rules.size, 0);
    assert.equal(Object.keys(browser.session).length, 0);
});
