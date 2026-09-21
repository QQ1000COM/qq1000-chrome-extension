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
            chrome.storage[area].get(keys, result => resolve(result || {}));
        } catch (error) {
            resolve({});
        }
    });
}

function storageSet(area, values) {
    return new Promise(resolve => {
        try {
            chrome.storage[area].set(values, () => resolve(true));
        } catch (error) {
            resolve(false);
        }
    });
}

function storageRemove(area, keys) {
    return new Promise(resolve => {
        try {
            chrome.storage[area].remove(keys, () => resolve(true));
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
            headers: Object.assign({ "user-token": options.token || "" }, options.headers || {}),
            signal: controller.signal,
        });
        const text = await response.text();
        try {
            return JSON.parse(text);
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
    if (Array.isArray(raw)) return raw;
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
    box.innerHTML = rows
        .map(row => {
            const isUnlimited = unlimited || row.unlimited;
            const remaining = isUnlimited ? "不限" : String(row.remaining ?? 0);
            const unit = row.unit || "次";
            const suffix = isUnlimited ? "" : `<small> / ${row.quota ?? 0} ${unit}</small>`;
            const tone = isUnlimited || Number(row.remaining ?? 0) > 0 ? "#0d0d0d" : "#b42318";
            return `<div class="quota-item">
    <span class="quota-name">${row.icon || "🧩"}<span class="n">${row.name || row.plugin_code}</span></span>
    <span class="quota-value" style="color:${tone}">${remaining}${suffix}</span>
</div>`;
        })
        .join("");
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
    const stored = await storageGet("sync", [TOKEN_KEY]);
    let token = String((stored && stored[TOKEN_KEY]) || "").trim();
    if (!token) {
        const fallback = await storageGet("local", [TOKEN_KEY]);
        token = String((fallback && fallback[TOKEN_KEY]) || "").trim();
    }
    if (!token) {
        showPanel(false);
        return;
    }
    const payload = await apiRequest("/plugin/api/user/info", { token });
    if (!payload || payload.state === false || UNAUTHORIZED_CODES.has(Number(payload.code))) {
        if (payload && UNAUTHORIZED_CODES.has(Number(payload.code))) {
            await storageRemove("sync", [TOKEN_KEY, INFO_KEY, "cj-user-vipState"]);
            showPanel(false);
            setStatus(payload.msg || "密钥已失效，请重新登录", "error");
            return;
        }
        // 网络问题：保留登录态，只提示
        showPanel(true);
        const cached = (await storageGet("sync", [INFO_KEY]))[INFO_KEY];
        renderUserHeader(cached || {}, token);
        els.quotaList.innerHTML = '<div class="muted">暂时读不到次数，请稍后刷新。</div>';
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
    const raw = String(els.keyInput.value || "").trim();
    if (!raw) {
        setStatus("请先粘贴用户密钥", "error");
        return;
    }
    els.loginBtn.disabled = true;
    setStatus("正在校验密钥…");
    const payload = await apiRequest("/plugin/api/longin/post", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        token: raw,
    });
    els.loginBtn.disabled = false;

    if (!payload || payload.state === false || Number(payload.code) !== 0) {
        setStatus(String((payload && payload.msg) || "登录失败，请检查密钥"), "error");
        return;
    }

    const data = payload.data || {};
    const loginToken = String(data.login_token || data.user_token || raw).trim();
    const info = {
        id: data.id || data.userId || "",
        name: data.username || data.nickname || "已登录",
        membership: data.membershipPlanName || "",
        expiresAt: data.membershipExpiresAt || "",
        unlimited: Boolean(data.unlimited),
    };
    await storageSet("sync", {
        [TOKEN_KEY]: loginToken,
        [INFO_KEY]: info,
        "cj-user-vipState": info.unlimited || info.membership ? "1" : "0",
    });
    // sync 是插件读取的主位置；local 里也放一份，兼容走 storage.local 的旧代码路径。
    await storageSet("local", { "cj-plugin-token": loginToken, [TOKEN_KEY]: loginToken });
    try {
        window.localStorage.setItem("cj-tools-plugin-token", loginToken);
    } catch (error) {}

    setStatus("登录成功，正在加载账号权益…", "ok");
    els.keyInput.value = "";
    await loadUser();
    await notifyOpenTabs();
}

async function handleLogout() {
    const stored = await storageGet("sync", [TOKEN_KEY]);
    const token = String((stored && stored[TOKEN_KEY]) || "").trim();
    setStatus("正在退出…");
    if (token) await apiRequest("/plugin/api/longin/out_login", { method: "POST", token });
    await storageRemove("sync", [TOKEN_KEY, INFO_KEY, "cj-user-vipState"]);
    await storageRemove("local", ["cj-plugin-token", TOKEN_KEY]);
    try {
        window.localStorage.removeItem("cj-tools-plugin-token");
    } catch (error) {}
    showPanel(false);
    setStatus("已退出登录", "ok");
}

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
        $("version").textContent = chrome.runtime.getManifest().version;
    } catch (error) {}

    $("login").addEventListener("click", () => void handleLogin());
    $("logout").addEventListener("click", () => void handleLogout());
    $("refresh").addEventListener("click", () => void loadUser());
    $("open-profile").addEventListener("click", openProfile);
    els.keyInput.addEventListener("keydown", event => {
        if (event.key === "Enter") void handleLogin();
    });

    void loadUser();

    const params = new URLSearchParams(window.location.search);
    if (params.get("mode") === "login") {
        setTimeout(() => els.keyInput.focus(), 120);
    }
});
