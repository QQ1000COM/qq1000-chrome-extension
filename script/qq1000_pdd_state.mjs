// The browser retains session DNR rules when the MV3 service worker stops.
// Keep the matching pending item in storage.session, and never infer ownership
// or remove another tab's rule from a truncated tab ID.
export const PDD_RULE_BASE = 910000;
export const PDD_RULE_LIMIT = 920000;
export const PDD_EDIT_FILTER = "mms.pinduoduo.com/glide/mms/goodsCommit/action/edit";
const STORAGE_PREFIX = "qq1000_pdd_hijack_state_";
const FLAG_TTL = 5 * 60 * 1000;

export function isPddBlockRule(rule) {
    const condition = rule && rule.condition;
    return Boolean(rule && Number.isInteger(rule.id) && rule.id >= PDD_RULE_BASE && rule.id < PDD_RULE_LIMIT
        && rule.priority === 2 && rule.action && rule.action.type === "block" && Object.keys(rule.action).length === 1
        && condition && condition.urlFilter === PDD_EDIT_FILTER
        && Object.keys(condition).every(key => ["urlFilter", "resourceTypes", "tabIds"].includes(key))
        && Array.isArray(condition.tabIds) && condition.tabIds.length === 1 && Number.isInteger(condition.tabIds[0]) && condition.tabIds[0] >= 0
        && Array.isArray(condition.resourceTypes) && condition.resourceTypes.length === 2
        && condition.resourceTypes.includes("xmlhttprequest") && condition.resourceTypes.includes("other"));
}

export class PddHijackState {
    constructor(chromeApi, { flags = {}, processing = new Set(), ruleMap = new Map(), onFailure = async () => {}, onStateChange = async () => {}, now = Date.now } = {}) {
        this.chrome = chromeApi;
        this.flags = flags;
        this.processing = processing;
        this.ruleMap = ruleMap;
        this.onFailure = onFailure;
        this.onStateChange = onStateChange;
        this.now = now;
        this.jobs = new Map();
        this.cancelled = new Set();
        this.recoveryErrors = new Map();
        this.nextRuleId = PDD_RULE_BASE;
        this.queue = Promise.resolve();
        this.restoreError = null;
        this.ready = this.restore().catch(error => { this.restoreError = error; return false; });
    }

    key(tabId) { return STORAGE_PREFIX + tabId; }

    publicStatus(tabId) {
        const message = this.recoveryErrors.get(tabId) || (this.restoreError ? "无法恢复本页搬家任务，请重载插件后重试。" : "");
        return { needsAttention: Boolean(message), message };
    }

    publishStatus(tabId) {
        try { Promise.resolve(this.onStateChange(tabId, this.publicStatus(tabId))).catch(() => {}); } catch (ignored) {}
    }

    async getStatus(tabId) { return this.run(() => this.publicStatus(tabId), false); }

    async retainRecovery(tabId, message, state = {}) {
        this.recoveryErrors.set(tabId, message);
        await this.chrome.storage.session.set({ [this.key(tabId)]: {
            tabId, ruleId: state.ruleId ?? this.ruleMap.get(tabId), phase: "recovery_required",
            timestamp: state.timestamp ?? this.now(), documentId: state.documentId, frameId: state.frameId || 0,
            error: message,
        } });
        this.publishStatus(tabId);
    }

    async report(tabId, error) {
        try { await this.onFailure(tabId, error.message || String(error)); } catch (ignored) {}
    }

    run(operation, requireRecovery = true) {
        const result = this.queue.then(async () => {
            await this.ready;
            if (requireRecovery && this.restoreError) {
                try { await this.restore(); this.restoreError = null; }
                catch (error) { this.restoreError = error; throw new Error("拼多多状态恢复失败，请重载插件后重试"); }
            }
            return operation();
        });
        this.queue = result.catch(() => {});
        return result;
    }

    async restore() {
        const rules = (await this.chrome.declarativeNetRequest.getSessionRules()).filter(isPddBlockRule);
        const stored = await this.chrome.storage.session.get(null);
        const groups = new Map();
        for (const rule of rules) {
            const tabId = rule.condition.tabIds[0];
            if (!groups.has(tabId)) groups.set(tabId, []);
            groups.get(tabId).push(rule);
        }
        for (const [tabId, owned] of groups) {
            let tab;
            try { tab = await this.chrome.tabs.get(tabId); } catch (ignored) {}
            if (!tab || !/^https:\/\/mms\.pinduoduo\.com(?:\/|$)/.test(tab.url || "")) {
                await this.chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: owned.map(rule => rule.id) });
                await this.chrome.storage.session.remove(this.key(tabId));
                continue;
            }
            const state = stored[this.key(tabId)];
            const matching = state && owned.find(rule => rule.id === state.ruleId && state.tabId === tabId);
            const fresh = state && Number.isFinite(state.timestamp) && this.now() - state.timestamp >= 0 && this.now() - state.timestamp <= FLAG_TTL;
            const sameDocument = state && await this.sameDocument(tabId, state);
            const valid = matching && fresh && sameDocument && state.phase === "armed" && state.goodsDetail && typeof state.goodsDetail === "object" && !Array.isArray(state.goodsDetail);
            this.ruleMap.set(tabId, matching ? matching.id : owned[0].id);
            if (valid) {
                this.flags[tabId] = { ...state, needHijack: true };
                const redundant = owned.filter(rule => rule.id !== matching.id);
                if (redundant.length) await this.chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: redundant.map(rule => rule.id) });
            } else {
                // A previous send may already have reached the merchant. Never replay it.
                // Keep its own block until explicit retry/clear so an unmodified submit
                // cannot accidentally slip through after losing its transformation state.
                const error = new Error("搬家任务状态已失效或上次提交结果不明，请重新采集后重试");
                await this.retainRecovery(tabId, state && state.error || error.message, state || {});
                await this.report(tabId, error);
            }
        }
        for (const [key, state] of Object.entries(stored)) {
            if (!key.startsWith(STORAGE_PREFIX) || !state || !Number.isInteger(state.tabId) || groups.has(state.tabId)) continue;
            const message = state.error || "上次搬家任务未能完成或保存结果不明，请确认后重新采集";
            await this.retainRecovery(state.tabId, message, state);
            await this.report(state.tabId, new Error(message));
        }
        return true;
    }

    allocateRuleId(rules) {
        const occupied = new Set([...rules.map(rule => rule.id), ...this.jobs.values()]);
        for (let attempt = 0; attempt < PDD_RULE_LIMIT - PDD_RULE_BASE; attempt++) {
            const id = this.nextRuleId++;
            if (this.nextRuleId >= PDD_RULE_LIMIT) this.nextRuleId = PDD_RULE_BASE;
            if (!occupied.has(id)) return id;
        }
        throw new Error("拼多多拦截规则已满，请关闭旧任务后重试");
    }

    async sameDocument(tabId, state) {
        if (typeof state.documentId !== "string" || !state.documentId) return false;
        try {
            const frame = await this.chrome.webNavigation.getFrame({ tabId, frameId: state.frameId || 0 });
            return frame && frame.documentId === state.documentId;
        } catch (ignored) { return false; }
    }

    async arm(tabId, state) {
        try {
            return await this.run(async () => {
                if (!Number.isInteger(tabId) || tabId < 0 || !state || !state.goodsDetail || typeof state.goodsDetail !== "object" || Array.isArray(state.goodsDetail)) throw new Error("搬家任务参数不完整");
                if (this.processing.has(tabId)) throw new Error("当前搬家任务仍在处理中，请稍后重试");
                const frameId = Number.isInteger(state.frameId) ? state.frameId : 0;
                let frame;
                try { frame = await this.chrome.webNavigation.getFrame({ tabId, frameId }); } catch (ignored) {}
                if (!frame || typeof frame.documentId !== "string" || !frame.documentId) throw new Error("无法确认当前页面，请刷新页面后重试");
                if (state.documentId && state.documentId !== frame.documentId) throw new Error("页面已变化，请在当前页面重新采集后重试");
                const rules = await this.chrome.declarativeNetRequest.getSessionRules();
                const owned = rules.filter(rule => isPddBlockRule(rule) && rule.condition.tabIds[0] === tabId);
                const ruleId = this.allocateRuleId(rules);
                const key = this.key(tabId);
                const previous = (await this.chrome.storage.session.get([key]))[key];
                const snapshot = JSON.parse(JSON.stringify({ ...state, documentId: frame.documentId, frameId, tabId, ruleId, phase: "armed", timestamp: this.now() }));
                await this.chrome.storage.session.set({ [key]: snapshot });
                try {
                    await this.chrome.declarativeNetRequest.updateSessionRules({
                        removeRuleIds: owned.map(rule => rule.id),
                        addRules: [{ id: ruleId, priority: 2, action: { type: "block" }, condition: { urlFilter: PDD_EDIT_FILTER, resourceTypes: ["xmlhttprequest", "other"], tabIds: [tabId] } }],
                    });
                } catch (error) {
                    if (previous) await this.chrome.storage.session.set({ [key]: previous });
                    else await this.chrome.storage.session.remove(key);
                    throw error;
                }
                this.flags[tabId] = { ...snapshot, needHijack: true };
                this.ruleMap.set(tabId, ruleId);
                this.recoveryErrors.delete(tabId);
                this.publishStatus(tabId);
                return { success: true, ruleId };
            });
        } catch (error) {
            if (Number.isInteger(tabId) && tabId >= 0) { this.recoveryErrors.set(tabId, error.message || String(error)); this.publishStatus(tabId); }
            return { success: false, error: error.message || String(error) };
        }
    }

    async claim(tabId) {
        return this.run(async () => {
            if (this.processing.has(tabId)) return null;
            const state = this.flags[tabId];
            if (!state || !state.needHijack) {
                if (this.recoveryErrors.has(tabId)) throw new Error(this.recoveryErrors.get(tabId));
                return null;
            }
            const rules = await this.chrome.declarativeNetRequest.getSessionRules();
            const rule = rules.find(rule => isPddBlockRule(rule) && rule.id === state.ruleId && rule.condition.tabIds[0] === tabId);
            const age = this.now() - state.timestamp;
            if (!rule || age < 0 || age > FLAG_TTL || !await this.sameDocument(tabId, state)) {
                delete this.flags[tabId];
                const message = "搬家任务未能继续或页面已变化，请重新采集后重试";
                await this.retainRecovery(tabId, message, state);
                throw new Error(message);
            }
            await this.chrome.storage.session.set({ [this.key(tabId)]: { ...state, phase: "processing" } });
            delete this.flags[tabId];
            this.processing.add(tabId);
            this.jobs.set(tabId, rule.id);
            this.cancelled.delete(tabId);
            return { ...state, ruleId: rule.id };
        });
    }

    isCurrent(tabId, ruleId) { return this.jobs.get(tabId) === ruleId && !this.cancelled.has(tabId); }

    async removeOwnedRules(tabId, ruleId) {
        const rules = await this.chrome.declarativeNetRequest.getSessionRules();
        const owned = rules.filter(rule => isPddBlockRule(rule) && rule.condition.tabIds[0] === tabId && (ruleId === undefined || rule.id === ruleId));
        if (owned.length) await this.chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: owned.map(rule => rule.id) });
        if (ruleId === undefined || this.ruleMap.get(tabId) === ruleId) this.ruleMap.delete(tabId);
        return owned.length;
    }

    async removeBlock(tabId) {
        try {
            await this.run(() => this.removeOwnedRules(tabId), false);
            return { success: true };
        } catch (error) { return { success: false, error: error.message || String(error) }; }
    }

    async prepareSend(tabId, ruleId) {
        return this.run(async () => {
            if (!this.isCurrent(tabId, ruleId)) throw new Error("搬家任务已取消");
            const key = this.key(tabId);
            const state = (await this.chrome.storage.session.get([key]))[key];
            if (!state || state.ruleId !== ruleId || state.phase !== "processing") throw new Error("搬家任务状态丢失，已停止提交");
            const rules = await this.chrome.declarativeNetRequest.getSessionRules();
            if (!rules.some(rule => isPddBlockRule(rule) && rule.id === ruleId && rule.condition.tabIds[0] === tabId)) throw new Error("原请求拦截规则已丢失，已停止改包提交");
            await this.chrome.storage.session.set({ [key]: { ...state, phase: "sending" } });
            await this.removeOwnedRules(tabId, ruleId);
            return true;
        });
    }

    async clearWithinQueue(tabId, { closed = false } = {}) {
        this.cancelled.add(tabId);
        delete this.flags[tabId];
        const key = this.key(tabId);
        const state = (await this.chrome.storage.session.get([key]))[key];
        if (state) await this.chrome.storage.session.set({ [key]: { ...state, phase: "cancelled" } });
        await this.removeOwnedRules(tabId);
        await this.chrome.storage.session.remove(key);
        this.recoveryErrors.delete(tabId);
        if (closed || !this.jobs.has(tabId)) {
            this.jobs.delete(tabId);
            this.processing.delete(tabId);
            this.cancelled.delete(tabId);
        }
    }

    async clear(tabId, options = {}) {
        try {
            await this.run(async () => {
                await this.clearWithinQueue(tabId, options);
                if (this.restoreError) { await this.restore(); this.restoreError = null; }
                this.publishStatus(tabId);
            }, false);
            return { success: true };
        } catch (error) {
            this.recoveryErrors.set(tabId, "重置未完成：" + (error.message || String(error)));
            this.publishStatus(tabId);
            return { success: false, error: error.message || String(error) };
        }
    }

    async handleNavigation({ tabId }) {
        try {
            return await this.run(async () => {
                if (!this.flags[tabId] && !this.ruleMap.has(tabId) && !this.jobs.has(tabId) && !this.recoveryErrors.has(tabId)) return { success: true };
                const state = (await this.chrome.storage.session.get([this.key(tabId)]))[this.key(tabId)];
                // This check runs inside the mutation queue. A delayed navigation
                // event must not clear a task just armed for the current document.
                if (state && await this.sameDocument(tabId, state)) return { success: true };
                await this.clearWithinQueue(tabId);
                this.publishStatus(tabId);
                return { success: true };
            }, false);
        } catch (error) { return { success: false, error: error.message || String(error) }; }
    }

    async finish(tabId, ruleId) {
        try {
            await this.run(async () => {
                await this.removeOwnedRules(tabId, ruleId);
                const key = this.key(tabId);
                const state = (await this.chrome.storage.session.get([key]))[key];
                if (state && state.ruleId === ruleId) await this.chrome.storage.session.remove(key);
                if (this.flags[tabId] && this.flags[tabId].ruleId === ruleId) delete this.flags[tabId];
                if (this.jobs.get(tabId) === ruleId) {
                    this.jobs.delete(tabId);
                    this.processing.delete(tabId);
                    this.cancelled.delete(tabId);
                    this.recoveryErrors.delete(tabId);
                }
                this.publishStatus(tabId);
            }, false);
            return { success: true };
        } catch (error) { await this.report(tabId, error); return { success: false, error: error.message || String(error) }; }
    }
}
