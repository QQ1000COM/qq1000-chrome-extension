"use strict";

/**
 * QQ1000 电商 · 在线登录桥
 *
 * 取代旧的「本地访客模式」桥（script/guest_mode_bridge.js）。旧桥会在本地
 * 伪造一个 unlimited 的访客身份、拦截所有 /plugin/api/* 请求并本地返回数据，
 * 让插件完全脱网可用——那正是白嫖的入口，现已彻底移除。
 *
 * 现在这个桥只做三件事：
 *   1. 读 chrome.storage.sync 里的 cj-user-token（= tu.qq1000.com 的用户密钥），
 *      没有就显示「未登录」浮条，引导用户到插件弹窗里粘贴密钥；
 *   2. 定期拿密钥向服务端做心跳校验，服务端回 101/102 就立刻清掉本地登录态
 *      并重新提示登录（密钥被停用 / 次数被封时插件立即失效）；
 *   3. 把插件自带登录弹窗的字段提示改成「用户密钥」，避免用户去输账号密码。
 *
 * 它不做任何本地放行、不伪造任何响应：能不能用只由服务端说了算。
 */
(function installQq1000PortalBridge() {
    if (window.__QQ1000_PORTAL_BRIDGE__) return;
    window.__QQ1000_PORTAL_BRIDGE__ = true;

    const TOKEN_KEY = "cj-user-token";
    const BANNER_ID = "qq1000-portal-login-banner";
    const API_HOST = "https://tu.qq1000.com";
    const PROFILE_URL = `${API_HOST}/profile`;
    const UPDATE_DOWNLOAD_URL = "https://github.com/QQ1000COM/qq1000-chrome-extension/releases/latest";
    const HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000;
    const UNAUTHORIZED_CODES = new Set([101, 102, 401]);

    let token = "";
    let banner = null;
    let loginNotice = "";
    let updateNotice = "";
    let loginRefreshId = 0;
    let loginRefreshPending = false;
    let reloadTimer = null;
    let heartbeatTimer = null;
    let lastHeartbeatAt = 0;
    let updateCheckPending = false;

    function storageGet(area, keys) {
        return new Promise(resolve => {
            try {
                chrome.storage[area].get(keys, result => {
                    void chrome.runtime?.lastError;
                    resolve(result || {});
                });
            } catch (error) {
                resolve({});
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

    function openPopupPage() {
        const url = chrome.runtime.getURL("popup.html?mode=login");
        // 内容脚本里没有 chrome.tabs（只有 runtime / storage / i18n / dom），
        // 所以让 service worker 去开标签页；不行再退回 window.open
        // （popup.html 已声明为 web_accessible_resource，网页可以直接打开）。
        try {
            chrome.runtime.sendMessage({ cmd: "qq1000:open-login" }, response => {
                void chrome.runtime.lastError;
                if (!response || !response.ok) {
                    try { window.open(url, "_blank"); } catch (error) {}
                }
            });
            return;
        } catch (error) {}
        try { window.open(url, "_blank"); } catch (error) {}
    }

    function ensureBannerStyle() {
        if (document.getElementById("qq1000-portal-login-style")) return;
        const style = document.createElement("style");
        style.id = "qq1000-portal-login-style";
        style.textContent = `
#${BANNER_ID}{position:fixed;right:16px;bottom:16px;z-index:2147483647;max-width:320px;
 font:13px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;
 background:#fff;color:#172033;border:1px solid #e2e7f0;border-radius:12px;padding:12px 14px;
 box-shadow:0 8px 28px rgba(16,24,40,.14);}
#${BANNER_ID} .qq1000-pb-title{display:flex;align-items:center;gap:6px;font-weight:600;font-size:13px;}
#${BANNER_ID} .qq1000-pb-dot{width:8px;height:8px;border-radius:50%;background:#f04438;flex:0 0 8px;}
#${BANNER_ID}[data-mode="update"] .qq1000-pb-dot{background:#f79009;}
#${BANNER_ID} .qq1000-pb-text{margin-top:6px;color:#667085;font-size:12px;}
#${BANNER_ID} .qq1000-pb-actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px;}
#${BANNER_ID} button,#${BANNER_ID} a{cursor:pointer;border-radius:8px;font-size:12px;padding:6px 10px;
 text-decoration:none;border:1px solid #d0d5dd;background:#fff;color:#475467;}
#${BANNER_ID} button.qq1000-pb-primary{background:#101828;border-color:#101828;color:#fff;font-weight:600;}
#${BANNER_ID} .qq1000-pb-close{position:absolute;top:8px;right:10px;border:0;background:transparent;
 color:#98a2b3;font-size:14px;padding:0 4px;line-height:1;}
`;
        (document.head || document.documentElement).appendChild(style);
    }

    function hideLoginBanner() {
        loginNotice = "";
        renderBanner();
    }

    function removeBanner() {
        if (banner && banner.parentElement) banner.parentElement.removeChild(banner);
        banner = null;
    }

    function showLoginBanner(reason) {
        loginNotice = reason;
        renderBanner();
    }

    function showUpdateBanner(reason) {
        updateNotice = reason;
        renderBanner();
    }

    function renderBanner() {
        // 更新通知与登录状态分别保存，版本检查不能覆盖真正的失效原因。
        const mode = loginNotice ? "login" : "update";
        const reason = loginNotice || updateNotice;
        if (!reason) {
            removeBanner();
            return;
        }
        if (!document.body && !document.documentElement) return;
        ensureBannerStyle();
        if (banner && banner.parentElement && banner.dataset.mode === mode) {
            const text = banner.querySelector(".qq1000-pb-text");
            if (text) text.textContent = reason;
            return;
        }
        removeBanner();
        const node = document.createElement("div");
        node.id = BANNER_ID;
        node.dataset.mode = mode;
        node.innerHTML = `
<span class="qq1000-pb-title"><span class="qq1000-pb-dot"></span><span class="qq1000-pb-title-text"></span></span>
<div class="qq1000-pb-text"></div>
<div class="qq1000-pb-actions"></div>
<button type="button" class="qq1000-pb-close" aria-label="关闭">×</button>`;
        node.querySelector(".qq1000-pb-title-text").textContent = mode === "login"
            ? "未登录 · 插件功能已停用" : "插件有新版本";
        const actions = node.querySelector(".qq1000-pb-actions");
        if (mode === "login") {
            actions.innerHTML = `
    <button type="button" class="qq1000-pb-primary">用密钥登录</button>
    <a href="${PROFILE_URL}" target="_blank" rel="noopener noreferrer">去用户中心复制密钥</a>`;
            node.querySelector(".qq1000-pb-primary").addEventListener("click", event => {
                event.preventDefault();
                openPopupPage();
            });
        } else {
            actions.innerHTML = `<a href="${UPDATE_DOWNLOAD_URL}" target="_blank" rel="noopener noreferrer">下载新版本</a>`;
        }
        const text = node.querySelector(".qq1000-pb-text");
        if (text) text.textContent = reason;
        node.querySelector(".qq1000-pb-close").addEventListener("click", event => {
            event.preventDefault();
            if (mode === "login") loginNotice = "";
            else updateNotice = "";
            renderBanner();
        });
        (document.body || document.documentElement).appendChild(node);
        banner = node;
    }

    async function requestJson(path, options = {}) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 12000);
        try {
            const response = await fetch(`${API_HOST}${path}`, {
                method: options.method || "GET",
                redirect: "error",
                headers: Object.assign({ "user-token": token }, options.headers || {}),
                signal: controller.signal
            });
            if (response.status === 401 || response.status === 403) {
                return { code: response.status === 403 ? 102 : 401, msg: "密钥已失效或权限不足，请重新登录" };
            }
            return await response.json();
        } catch (error) {
            return null;
        } finally {
            clearTimeout(timer);
        }
    }

    async function clearSession() {
        token = "";
        await storageRemove("sync", [TOKEN_KEY, "cj-user-info", "cj-user-vipState"]);
        await storageRemove("local", [TOKEN_KEY, "cj-plugin-token"]);
        try {
            window.localStorage.removeItem("cj-tools-plugin-token");
        } catch (error) {}
    }

    async function heartbeat(force = false) {
        if (!token || loginRefreshPending) return;
        const now = Date.now();
        if (!force && now - lastHeartbeatAt < 60000) return;
        lastHeartbeatAt = now;
        const checkedToken = token;
        const checkedRefreshId = loginRefreshId;
        // POST 由现有接口支持，避免 CDN 复用其他账号的 GET 校验结果。
        const payload = await requestJson("/plugin/api/user/info", { method: "POST" });
        // 存储变更已到达但异步回读尚未完成时，旧请求也不能清除新账号。
        if (token !== checkedToken || checkedRefreshId !== loginRefreshId) return;
        if (!payload) return;
        if (UNAUTHORIZED_CODES.has(Number(payload.code))) {
            await clearSession();
            showLoginBanner(String(payload.msg || "登录已失效，请重新使用用户密钥登录"));
        }
    }

    async function refreshLoginState(reloadOnChange = false) {
        const refreshId = ++loginRefreshId;
        loginRefreshPending = true;
        const stored = await storageGet("sync", [TOKEN_KEY]);
        let next = String((stored && stored[TOKEN_KEY]) || "").trim();
        if (!next) {
            const local = await storageGet("local", [TOKEN_KEY]);
            next = String((local && local[TOKEN_KEY]) || "").trim();
        }
        if (refreshId !== loginRefreshId) return;
        loginRefreshPending = false;
        const previous = token;
        token = next;
        if (!token) {
            if (reloadTimer) clearTimeout(reloadTimer);
            reloadTimer = null;
            showLoginBanner("插件已改为在线登录：请在插件图标里粘贴 tu.qq1000.com 用户中心的用户密钥。");
            return;
        }
        hideLoginBanner();
        if (reloadOnChange && token !== previous && !reloadTimer) {
            // 两个存储区会分别发事件，只按实际生效的密钥变化刷新一次。
            reloadTimer = setTimeout(() => {
                try { window.location.reload(); } catch (error) {}
            }, 300);
        }
        await heartbeat(true);
    }

    /* 插件自带登录弹窗的字段提示改成「用户密钥」 */
    const ACCOUNT_PLACEHOLDER = /手机号\s*\/\s*邮箱|手机号|邮箱|账号/;
    // 只在插件自己的弹窗里改文案。以前是全文档扫 input[placeholder]，
    // 结果淘宝/京东等站点**自己的**登录框也被改成「用户密钥」，用户根本没法登录 ——
    // 这些容器类名是插件独有的，宿主页面不会有。
    const LOGIN_SCOPE_SELECTORS = [
        ".lm2-form-panel",
        ".lm2-view",
        ".kdcm-input-row",
        "#loginApp-gg",
        ".cj-wg-overlay",
        ".plugin-wrapper"
    ];
    // 密码框隐藏后仍要带上一个值，随便什么内容都行（服务端只认账号那一栏的密钥）
    const KEY_PLACEHOLDER_VALUE = "qq1000-key";

    function relabelLoginDialogInputs() {
        LOGIN_SCOPE_SELECTORS.forEach(selector => {
            let scopes;
            try {
                scopes = document.querySelectorAll(selector);
            } catch (error) {
                return;
            }
            scopes.forEach(scope => {
                const inputs = scope.querySelectorAll("input[placeholder]");
                inputs.forEach(input => {
                    const placeholder = String(input.getAttribute("placeholder") || "");
                    if (!ACCOUNT_PLACEHOLDER.test(placeholder)) return;
                    if (input.dataset.qq1000KeyHint === "1") return;
                    input.dataset.qq1000KeyHint = "1";
                    input.setAttribute("placeholder", "用户密钥（在 tu.qq1000.com 用户中心复制）");
                    // 密码框必须取自同一个弹窗，不能再去全文档抓第一个 password 输入框。
                    // 本站只支持密钥登录：密码那一行直接隐藏，并自动填一个占位值 ——
                    // 插件客户端提交时会带上账号+密码两个字段，删掉会导致登录请求缺字段。
                    const password = scope.querySelector('input[type="password"]');
                    if (password) {
                        if (!password.dataset.qq1000KeyHint) {
                            password.dataset.qq1000KeyHint = "1";
                            password.setAttribute("placeholder", "密钥已填在上一栏，这里随便填");
                        }
                        const row = password.closest(".kdcm-input-row") ||
                            password.closest(".lm2-input-row") || password.parentElement;
                        if (row && row.style.display !== "none") row.style.display = "none";
                        if (password.value !== KEY_PLACEHOLDER_VALUE) {
                            password.value = KEY_PLACEHOLDER_VALUE;
                            password.dispatchEvent(new Event("input", { bubbles: true }));
                            password.dispatchEvent(new Event("change", { bubbles: true }));
                        }
                    }
                });
            });
        });
        // 注册 / 忘记密码这些入口本站不提供，直接摘掉
        [".lm2-register-row", ".lm2-forgot", ".lm2-forgot-password"].forEach(className => {
            document.querySelectorAll(className).forEach(node => {
                if (node.parentElement) node.remove();
            });
        });
    }

    function startObservers() {
        // 这个观察器跑在**所有页面**（含 tu.qq1000.com 这类重 DOM 的 SPA）。
        // 原来每次 DOM 变动都调一次「全文档扫描」找登录弹窗输入框，页面每秒几百上千次
        // 变动时会把主线程打满（表现就是网站卡死）。节流到每 800ms 最多一次 ——
        // 这里只是给输入框改文案，晚一点生效没有任何影响。
        let lastRelabelAt = 0;
        const observer = new MutationObserver(() => {
            const now = Date.now();
            if (now - lastRelabelAt < 800) return;
            lastRelabelAt = now;
            try {
                relabelLoginDialogInputs();
            } catch (error) {}
        });
        try {
            observer.observe(document.documentElement, { childList: true, subtree: true });
        } catch (error) {}
        relabelLoginDialogInputs();
    }

    function startHeartbeat() {
        if (heartbeatTimer) return;
        heartbeatTimer = setInterval(() => {
            if (document.visibilityState === "visible") heartbeat(true);
        }, HEARTBEAT_INTERVAL_MS);
        document.addEventListener("visibilitychange", () => {
            if (document.visibilityState === "visible") heartbeat();
        });
        window.addEventListener("focus", () => heartbeat());
    }

    try {
        chrome.storage.onChanged.addListener((changes, area) => {
            if ((area !== "sync" && area !== "local") || !changes || !changes[TOKEN_KEY]) return;
            // sync 优先、local 兜底，与 popup 一致；不能把删除任一副本当成退出。
            void refreshLoginState(true);
        });
    } catch (error) {}

    /* ------------------------------------------------------------------
     * 扩展自身更新检测
     * 版本源就是 GitHub 仓库根目录的 version.json（发布流程会自动更新它）。
     * 这里只在发现「远端版本比本机新」时提示一次，12 小时内不重复请求。
     * ------------------------------------------------------------------ */
    const UPDATE_VERSION_URL =
        "https://raw.githubusercontent.com/QQ1000COM/qq1000-chrome-extension/main/version.json";
    // raw.githubusercontent.com 在国内经常被污染/超时，失败时改用 jsDelivr 镜像再试一次，
    // 否则更新检测会静默失效（用户永远收不到升级提示）。
    const UPDATE_VERSION_MIRRORS = [
        UPDATE_VERSION_URL,
        "https://cdn.jsdelivr.net/gh/QQ1000COM/qq1000-chrome-extension@main/version.json",
        "https://fastly.jsdelivr.net/gh/QQ1000COM/qq1000-chrome-extension@main/version.json"
    ];
    const UPDATE_CHECK_KEY = "qq1000_ext_update_state";
    const UPDATE_CHECK_TTL = 12 * 60 * 60 * 1000;
    const UPDATE_RETRY_TTL = 5 * 60 * 1000;
    const UPDATE_TIMEOUT_MS = 8000;

    function validVersion(value) {
        return typeof value === "string" && /^\d{1,5}(\.\d{1,5}){0,3}$/.test(value)
            && value.split(".").every(part => Number(part) <= 65535);
    }

    function versionParts(value) {
        return String(value || "")
            .split(".")
            .map(part => parseInt(part, 10) || 0);
    }

    function isNewerVersion(remote, local) {
        const remoteParts = versionParts(remote);
        const localParts = versionParts(local);
        const length = Math.max(remoteParts.length, localParts.length);
        for (let index = 0; index < length; index += 1) {
            const left = remoteParts[index] || 0;
            const right = localParts[index] || 0;
            if (left !== right) return left > right;
        }
        return false;
    }

    async function checkExtensionUpdate() {
        if (updateCheckPending) return;
        let currentVersion = "";
        try {
            currentVersion = chrome.runtime.getManifest().version;
        } catch (error) {
            return;
        }
        updateCheckPending = true;
        try {
            // 扩展存储不受商家页面禁用 localStorage 影响，并跨页面保留升级提醒。
            const stored = await storageGet("local", [UPDATE_CHECK_KEY]);
            const cached = stored[UPDATE_CHECK_KEY] || {};
            const now = Date.now();
            const notice = version => {
                if (validVersion(version) && isNewerVersion(version, currentVersion)) {
                    showUpdateBanner("插件有新版本 v" + version + "（当前 v" + currentVersion + "），请下载后在扩展管理页重新加载。");
                }
            };
            notice(cached.version);
            const checkedAge = now - Number(cached.checkedAt || 0);
            if (validVersion(cached.version) && checkedAge >= 0 && checkedAge < UPDATE_CHECK_TTL) return;
            const attemptedAge = now - Number(cached.attemptedAt || 0);
            if (attemptedAge >= 0 && attemptedAge < UPDATE_RETRY_TTL) return;
            await storageSet("local", { [UPDATE_CHECK_KEY]: { ...cached, attemptedAt: now } });
            for (const mirror of UPDATE_VERSION_MIRRORS) {
                const controller = new AbortController();
                const timer = setTimeout(() => controller.abort(), UPDATE_TIMEOUT_MS);
                try {
                    const response = await fetch(mirror + "?_t=" + now, {
                        cache: "no-store", credentials: "omit", signal: controller.signal
                    });
                    const payload = response.ok ? await response.json() : null;
                    if (!payload || !validVersion(payload.version)) continue;
                    const version = validVersion(cached.version) && isNewerVersion(cached.version, payload.version)
                        ? cached.version : payload.version;
                    await storageSet("local", { [UPDATE_CHECK_KEY]: { version, checkedAt: Date.now(), attemptedAt: now } });
                    notice(version);
                    return;
                } catch (error) {
                    // 超时或暂时离线时继续镜像；全部失败后只冷却五分钟。
                } finally {
                    clearTimeout(timer);
                }
            }
        } finally {
            updateCheckPending = false;
        }
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", () => {
            void refreshLoginState();
            startObservers();
            startHeartbeat();
            checkExtensionUpdate();
        });
    } else {
        void refreshLoginState();
        startObservers();
        startHeartbeat();
        checkExtensionUpdate();
    }
})();

/* qq1000: 预热到插件 CDN 的连接。插件资源都在 tu.qq1000.com，
   提前做 DNS/TLS 握手，首次拉 bundle 能省 100~300ms。 */
;(function () {
    try {
        var head = document.head || document.documentElement;
        if (!head || document.querySelector("link[data-qq1000-preconnect]")) return;
        ["https://tu.qq1000.com"].forEach(function (url) {
            var preconnect = document.createElement("link");
            preconnect.rel = "preconnect";
            preconnect.href = url;
            preconnect.crossOrigin = "anonymous";
            preconnect.setAttribute("data-qq1000-preconnect", "1");
            head.appendChild(preconnect);
            var dns = document.createElement("link");
            dns.rel = "dns-prefetch";
            dns.href = url;
            dns.setAttribute("data-qq1000-preconnect", "1");
            head.appendChild(dns);
        });
    } catch (error) {}
})();
