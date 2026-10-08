"use strict";

/**
 * QQ1000 电商 · 插件弹窗
 *
 * 这里是插件的「登录入口 + 账号状态」面板：
 *  - 未登录：粘贴 tu.qq1000.com 用户中心的「用户密钥」→ 向服务端校验 →
 *    写进 chrome.storage.sync 的 cj-user-token，插件的所有请求都带这个密钥。
 *  - 已登录：显示账号、会员到期、每个插件的剩余次数，可刷新 / 退出登录。
 *
 * 校验和次数都由服务端给出，本地不做任何放行判断（防白嫖）。
 */

const API_HOST = "https://tu.qq1000.com";
const PROFILE_URL = `${API_HOST}/profile`;
const TOKEN_KEY = "cj-user-token";
const INFO_KEY = "cj-user-info";
const UNAUTHORIZED_CODES = new Set([101, 102, 401]);

const els = {};
let accountRequestId = 0;
let sessionChangeId = 0;
let authActionId = 0;
let loginPending = false;
let sessionMutationDepth = 0;
let sessionMutationQueue = Promise.resolve();
let refreshTimer = null;
let verifiedUser = null;

function $(id) {
    return document.getElementById(id);
}

function setStatus(message, kind = "") {
    const node = els.status;
    if (!node) return;
    node.textContent = message || "";
    node.className = kind;
}

function storageGet(area, keys) {
    return new Promise(resolve => {
        try {
            chrome.storage[area].get(keys, result => resolve(chrome.runtime?.lastError ? null : (result || {})));
        } catch (error) {
            resolve(null);
        }
    });
}

function storageSet(area, values) {
    return new Promise(resolve => {
        try {
            chrome.storage[area].set(values, () => resolve(!chrome.runtime?.lastError));
        } catch (error) {
            resolve(false);
        }
    });
}

function storageRemove(area, keys) {
    return new Promise(resolve => {
        try {
            chrome.storage[area].remove(keys, () => resolve(!chrome.runtime?.lastError));
        } catch (error) {
            resolve(false);
        }
    });
}

async function apiRequest(path, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
        const response = await fetch(`${API_HOST}${path}`, {
            method: options.method || "GET",
            redirect: "error",
            headers: Object.assign({ "user-token": options.token || "" }, options.headers || {}),
            signal: controller.signal,
        });
        if (response.status === 401 || response.status === 403) {
            return { state: false, code: response.status === 403 ? 102 : 401, msg: "密钥已失效或权限不足，请重新登录" };
        }
        const text = await response.text();
        try {
            const payload = JSON.parse(text);
            if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
                return { state: false, code: -1, msg: "服务端返回格式异常，请稍后重试" };
            }
            if (response.status >= 400) {
                return { state: false, code: response.status, msg: payload.msg || `服务端暂不可用（HTTP ${response.status}）` };
            }
            return payload;
        } catch (error) {
            return { state: false, code: -1, msg: `服务端返回异常（HTTP ${response.status}）` };
        }
    } catch (error) {
        return { state: false, code: -2, msg: "网络异常，请检查网络后重试" };
    } finally {
        clearTimeout(timer);
    }
}

function showPanel(loggedIn) {
    els.panelUser.classList.toggle("hidden", !loggedIn);
    els.panelLogin.classList.toggle("hidden", loggedIn);
}

function normalizeQuotas(raw) {
    if (Array.isArray(raw)) return raw.filter(row => row && typeof row === "object" && !Array.isArray(row));
    if (raw && typeof raw === "object") {
        return Object.keys(raw).map(key => {
            const row = raw[key] || {};
            return {
                plugin_code: key,
                name: row.name || key,
                icon: row.icon || "🧩",
                unit: row.unit || "次",
                quota: row.quota || 0,
                used: row.used || 0,
                remaining: row.remaining,
                unlimited: Boolean(row.unlimited),
            };
        });
    }
    return [];
}

function renderQuotas(raw, unlimited) {
    const box = els.quotaList;
    if (!box) return;
    const rows = normalizeQuotas(raw);
    if (!rows.length) {
        box.innerHTML = '<div class="muted">后台还没有配置插件。</div>';
        return;
    }
    box.replaceChildren();
    rows.forEach(row => {
            const isUnlimited = unlimited || row.unlimited;
            const remaining = isUnlimited ? "不限" : String(row.remaining ?? 0);
            const unit = row.unit || "次";
            const tone = isUnlimited || Number(row.remaining ?? 0) > 0 ? "#0d0d0d" : "#b42318";
            const item = document.createElement("div");
            item.className = "quota-item";
            const name = document.createElement("span");
            name.className = "quota-name";
            name.textContent = String(row.icon || "🧩");
            const label = document.createElement("span");
            label.className = "n";
            label.textContent = String(row.name || row.plugin_code || "");
            name.appendChild(label);
            const value = document.createElement("span");
            value.className = "quota-value";
            value.style.color = tone;
            value.textContent = remaining;
            if (!isUnlimited) {
                const suffix = document.createElement("small");
                suffix.textContent = ` / ${row.quota ?? 0} ${unit}`;
                value.appendChild(suffix);
            }
            item.appendChild(name);
            item.appendChild(value);
            box.appendChild(item);
        });
}

async function readStoredToken() {
    const stored = await storageGet("sync", [TOKEN_KEY]);
    const primary = String((stored && stored[TOKEN_KEY]) || "").trim();
    if (primary) return primary;
    const local = await storageGet("local", [TOKEN_KEY]);
    const fallback = String((local && local[TOKEN_KEY]) || "").trim();
    return fallback || (stored === null || local === null ? null : "");
}

function mutateSession(action) {
    const operation = sessionMutationQueue.then(async () => {
        sessionMutationDepth++;
        try { return await action(); }
        finally { sessionMutationDepth--; }
    });
    sessionMutationQueue = operation.catch(() => {});
    return operation;
}

async function clearStoredSession(expectedToken) {
    if (expectedToken !== undefined && await readStoredToken() !== expectedToken) return false;
    // 先清备用副本，避免 sync 删除事件又把旧 local 密钥当成刚登录。
    const localRemoved = await storageRemove("local", ["cj-plugin-token", TOKEN_KEY]);
    if (expectedToken !== undefined) {
        const stored = await storageGet("sync", [TOKEN_KEY]);
        const current = String((stored && stored[TOKEN_KEY]) || "").trim();
        if (stored === null || (current && current !== expectedToken)) return false;
    }
    const syncRemoved = await storageRemove("sync", [TOKEN_KEY, INFO_KEY, "cj-user-vipState"]);
    try { window.localStorage.removeItem("cj-tools-plugin-token"); } catch (error) {}
    verifiedUser = null;
    return localRemoved && syncRemoved;
}

function renderUserHeader(info, token) {
    els.userName.textContent = (info && info.name) || "已登录";
    const parts = [];
    if (info && info.membership) parts.push(info.membership);
    if (info && info.expiresAt) parts.push(`到期 ${String(info.expiresAt).slice(0, 10)}`);
    if (info && info.unlimited) parts.push("不限量账号");
    if (info && info.id) parts.push(`ID ${info.id}`);
    parts.push(`密钥 ${String(token).slice(0, 4)}****`);
    els.userMeta.textContent = parts.join(" · ");
}

async function loadUser() {
    const requestId = ++accountRequestId;
    const changeId = sessionChangeId;
    const isCurrent = () => requestId === accountRequestId && changeId === sessionChangeId;
    const token = await readStoredToken();
    if (!isCurrent()) return;
    if (token === null) {
        setStatus("暂时无法读取登录信息，请重新打开插件后重试。", "error");
        return;
    }
    if (!token) {
        verifiedUser = null;
        showPanel(false);
        return;
    }
    // 账号资料由服务端实时校验；POST 避开按 URL 共享缓存的旧 GET 响应。
    const payload = await apiRequest("/plugin/api/user/info", { token, method: "POST" });
    if (!isCurrent() || await readStoredToken() !== token || !isCurrent()) return;
    const validData = payload && payload.data && typeof payload.data === "object" && !Array.isArray(payload.data);
    if (!payload || payload.state === false || Number(payload.code) !== 0 || !validData) {
        if (payload && UNAUTHORIZED_CODES.has(Number(payload.code))) {
            const cleared = await mutateSession(() => isCurrent() ? clearStoredSession(token) : false);
            if (!cleared) {
                if (requestId === accountRequestId) setStatus("登录状态已变化，请刷新重试。", "error");
                return;
            }
            showPanel(false);
            setStatus(payload.msg || "密钥已失效，请重新登录", "error");
            return;
        }
        // 断网保留密钥；只复用本弹窗已验证且仍属于同一密钥的资料。
        showPanel(true);
        renderUserHeader(verifiedUser && verifiedUser.token === token ? verifiedUser.info : { name: "登录状态待验证" }, token);
        els.quotaList.innerHTML = '<div class="muted">暂时读不到次数，请稍后刷新。</div>';
        setStatus((payload && payload.msg) || "暂时无法验证账号，请稍后刷新。", "error");
        return;
    }

    const data = payload.data || {};
    const info = {
        id: data.id || data.userId || "",
        name: data.username || data.nickname || "已登录",
        membership: data.membershipPlanName || "",
        expiresAt: data.membershipExpiresAt || "",
        unlimited: Boolean(data.unlimited),
    };
    await storageSet("sync", { [INFO_KEY]: info });
    if (!isCurrent()) return;
    verifiedUser = { token, info };
    showPanel(true);
    renderUserHeader(info, token);
    renderQuotas(data.pluginQuotas, info.unlimited);
    setStatus("");
}

async function notifyOpenTabs() {
    try {
        chrome.tabs.query({}, tabs => {
            (tabs || []).forEach(tab => {
                if (!tab || !tab.id || !tab.url || !/^https?:/i.test(tab.url)) return;
                try {
                    chrome.tabs.sendMessage(tab.id, { cmd: "qq1000:login-changed" }, () => void chrome.runtime.lastError);
                } catch (error) {}
            });
        });
    } catch (error) {}
}

async function handleLogin() {
    if (loginPending) return;
    const raw = String(els.keyInput.value || "").trim();
    if (!raw) {
        setStatus("请先粘贴用户密钥", "error");
        return;
    }
    const actionId = ++authActionId;
    const changeId = sessionChangeId;
    ++accountRequestId;
    loginPending = true;
    els.loginBtn.disabled = true;
    setStatus("正在校验密钥…");
    try {
        const payload = await apiRequest("/plugin/api/longin/post", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            token: raw,
        });
        if (actionId !== authActionId || changeId !== sessionChangeId) return;

        if (!payload || payload.state === false || Number(payload.code) !== 0 || !payload.data || typeof payload.data !== "object" || Array.isArray(payload.data)) {
            setStatus(String((payload && payload.msg) || "登录失败，请检查密钥"), "error");
            return;
        }

        const data = payload.data;
        const loginToken = String(data.login_token || data.user_token || raw).trim();
        const info = {
            id: data.id || data.userId || "",
            name: data.username || data.nickname || "已登录",
            membership: data.membershipPlanName || "",
            expiresAt: data.membershipExpiresAt || "",
            unlimited: Boolean(data.unlimited),
        };
        let savedSync;
        let savedLocal;
        await mutateSession(async () => {
            if (actionId !== authActionId) return;
            savedSync = await storageSet("sync", {
                [TOKEN_KEY]: loginToken,
                [INFO_KEY]: info,
                "cj-user-vipState": info.unlimited || info.membership ? "1" : "0",
            });
            // 另一个弹窗可能已完成账号切换，不能再把本次旧密钥写进备用区。
            const effectiveToken = await readStoredToken();
            if (actionId !== authActionId || effectiveToken === null || (effectiveToken && effectiveToken !== loginToken)) return;
            // sync 是主位置；local 兼容备用读取路径。
            savedLocal = await storageSet("local", { "cj-plugin-token": loginToken, [TOKEN_KEY]: loginToken });
        });
        if (actionId !== authActionId) return;
        const storedToken = await readStoredToken();
        if (actionId !== authActionId) return;
        if ((!savedSync && !savedLocal) || storedToken !== loginToken) {
            setStatus("无法保存登录信息，请重新打开插件后重试。", "error");
            return;
        }
        try {
            window.localStorage.setItem("cj-tools-plugin-token", loginToken);
        } catch (error) {}

        setStatus("登录成功，正在加载账号权益…", "ok");
        els.keyInput.value = "";
        await loadUser();
        await notifyOpenTabs();
    } finally {
        if (actionId === authActionId) {
            loginPending = false;
            els.loginBtn.disabled = false;
        }
    }
}

async function handleLogout() {
    const actionId = ++authActionId;
    ++accountRequestId;
    loginPending = false;
    if (els.loginBtn) els.loginBtn.disabled = false;
    setStatus("正在退出…");
    const result = await mutateSession(async () => {
        if (actionId !== authActionId) return null;
        const token = await readStoredToken();
        return { token, cleared: token !== null && await clearStoredSession(token) };
    });
    if (actionId !== authActionId || !result) return;
    const { token, cleared } = result;
    if (token === null) {
        setStatus("暂时无法读取登录信息，请重试退出。", "error");
        return;
    }
    if (!cleared) {
        setStatus("未能完成退出，请刷新后重试。", "error");
        void loadUser();
        return;
    }
    showPanel(false);
    setStatus("已退出登录", "ok");
    // 本地立即退出；迟到或失败的服务端通知不能再改变新会话。
    if (token) void apiRequest("/plugin/api/longin/out_login", { method: "POST", token });
}

try {
    chrome.storage.onChanged.addListener((changes, area) => {
        if ((area !== "sync" && area !== "local") || !changes || !changes[TOKEN_KEY]) return;
        sessionChangeId++;
        accountRequestId++;
        if (refreshTimer) clearTimeout(refreshTimer);
        if (sessionMutationDepth || !els.panelUser) return;
        refreshTimer = setTimeout(() => { refreshTimer = null; void loadUser(); }, 0);
    });
} catch (error) {}

function openProfile() {
    try {
        chrome.tabs.create({ url: PROFILE_URL, active: true });
    } catch (error) {
        window.open(PROFILE_URL, "_blank");
    }
}

document.addEventListener("DOMContentLoaded", () => {
    els.panelUser = $("panel-user");
    els.panelLogin = $("panel-login");
    els.userName = $("user-name");
    els.userMeta = $("user-meta");
    els.quotaList = $("quota-list");
    els.status = $("status");
    els.keyInput = $("key");
    els.loginBtn = $("login");

    try {
        const manifest = chrome.runtime.getManifest();
        $("version").textContent = manifest.version_name || manifest.version;
    } catch (error) {}

    $("login").addEventListener("click", () => void handleLogin());
    $("logout").addEventListener("click", () => void handleLogout());
    $("refresh").addEventListener("click", () => void loadUser());
    $("open-profile").addEventListener("click", openProfile);
    $("manage-extension").addEventListener("click", () => {
        chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}`, active: true });
    });
    els.keyInput.addEventListener("keydown", event => {
        if (event.key === "Enter") void handleLogin();
    });

    void loadUser();

    const params = new URLSearchParams(window.location.search);
    if (params.get("mode") === "login") {
        setTimeout(() => els.keyInput.focus(), 120);
    }
});
