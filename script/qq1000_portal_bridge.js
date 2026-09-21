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
    const HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000;
    const UNAUTHORIZED_CODES = new Set([101, 102]);

    let token = "";
    let banner = null;
    let heartbeatTimer = null;
    let lastHeartbeatAt = 0;

    function storageGet(area, keys) {
        return new Promise(resolve => {
            try {
                chrome.storage[area].get(keys, result => {
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

    function hideBanner() {
        if (banner && banner.parentElement) banner.parentElement.removeChild(banner);
        banner = null;
    }

    function showBanner(reason) {
        if (!document.body && !document.documentElement) return;
        ensureBannerStyle();
        if (banner && banner.parentElement) {
            const text = banner.querySelector(".qq1000-pb-text");
            if (text) text.textContent = reason;
            return;
        }
        const node = document.createElement("div");
        node.id = BANNER_ID;
        node.innerHTML = `
<span class="qq1000-pb-title"><span class="qq1000-pb-dot"></span>未登录 · 插件功能已停用</span>
<div class="qq1000-pb-text"></div>
<div class="qq1000-pb-actions">
    <button type="button" class="qq1000-pb-primary">用密钥登录</button>
    <a href="${PROFILE_URL}" target="_blank" rel="noopener noreferrer">去用户中心复制密钥</a>
</div>
<button type="button" class="qq1000-pb-close" aria-label="关闭">×</button>`;
        const text = node.querySelector(".qq1000-pb-text");
        if (text) text.textContent = reason;
        node.querySelector(".qq1000-pb-primary").addEventListener("click", event => {
            event.preventDefault();
            openPopupPage();
        });
        node.querySelector(".qq1000-pb-close").addEventListener("click", event => {
            event.preventDefault();
            hideBanner();
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
                headers: Object.assign({ "user-token": token }, options.headers || {}),
                signal: controller.signal
            });
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
        if (!token) return;
        const now = Date.now();
        if (!force && now - lastHeartbeatAt < 60000) return;
        lastHeartbeatAt = now;
        const payload = await requestJson("/plugin/api/user/info");
        if (!payload) return;
        if (UNAUTHORIZED_CODES.has(Number(payload.code))) {
            await clearSession();
            showBanner(String(payload.msg || "登录已失效，请重新使用用户密钥登录"));
        }
    }

    async function refreshLoginState() {
        const stored = await storageGet("sync", [TOKEN_KEY]);
        token = String((stored && stored[TOKEN_KEY]) || "").trim();
        if (!token) {
            const local = await storageGet("local", [TOKEN_KEY]);
            token = String((local && local[TOKEN_KEY]) || "").trim();
        }
        if (!token) {
            showBanner("插件已改为在线登录：请在插件图标里粘贴 tu.qq1000.com 用户中心的用户密钥。");
            return;
        }
        hideBanner();
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
                    const password = scope.querySelector('input[type="password"]');
                    if (password && !password.dataset.qq1000KeyHint) {
                        password.dataset.qq1000KeyHint = "1";
                        password.setAttribute("placeholder", "密钥已填在上一栏，这里随便填");
                    }
                });
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
            if (document.visibilityState === "visible") heartbeat(true);
        });
        window.addEventListener("focus", () => heartbeat(true));
    }

    try {
        chrome.storage.onChanged.addListener((changes, area) => {
            if ((area !== "sync" && area !== "local") || !changes || !changes[TOKEN_KEY]) return;
            const next = String((changes[TOKEN_KEY].newValue) || "").trim();
            const previous = token;
            token = next;
            if (next && !previous) {
                hideBanner();
                // 刚登录：刷新一次让面板按新身份重新拉取脚本与次数。
                setTimeout(() => {
                    try { window.location.reload(); } catch (error) {}
                }, 300);
            } else if (!next) {
                showBanner("已退出登录，插件功能已停用。");
            }
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
    const UPDATE_CHECK_KEY = "qq1000_ext_update_checked_at";
    const UPDATE_CHECK_TTL = 12 * 60 * 60 * 1000;

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

    function checkExtensionUpdate() {
        let lastCheckedAt = 0;
        try {
            lastCheckedAt = Number(window.localStorage.getItem(UPDATE_CHECK_KEY) || 0);
        } catch (error) {}
        const now = Date.now();
        if (now - lastCheckedAt < UPDATE_CHECK_TTL) return;
        let currentVersion = "";
        try {
            currentVersion = chrome.runtime.getManifest().version;
            window.localStorage.setItem(UPDATE_CHECK_KEY, String(now));
        } catch (error) {
            return;
        }
        const attempt = index => {
            if (index >= UPDATE_VERSION_MIRRORS.length) return;
            const url = UPDATE_VERSION_MIRRORS[index] + (UPDATE_VERSION_MIRRORS[index].includes("?") ? "&" : "?") + "_t=" + now;
            fetch(url, { cache: "no-store", credentials: "omit" })
                .then(response => (response.ok ? response.json() : null))
                .then(payload => {
                    if (!payload || !payload.version) {
                        attempt(index + 1);
                        return;
                    }
                    if (!isNewerVersion(payload.version, currentVersion)) return;
                    showBanner("插件有新版本 v" + payload.version + "（当前 v" + currentVersion + "），请更新");
                })
                .catch(() => attempt(index + 1));
        };
        attempt(0);
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
