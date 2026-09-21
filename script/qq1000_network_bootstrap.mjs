/**
 * QQ1000 网络引导层（必须在 service_worker_new.js 之前求值）
 *
 * 站点把插件的 JS/CSS 全部放在 https://tu.qq1000.com/plugin-static/ 上，
 * 并且要求带有效用户密钥。service worker 里的资源 fetch 走的是全局 fetch，
 * 所以在这里一次性包好，后面所有模块加载器都不用改。
 *
 * 作用：
 *  1. 给 /plugin-static/* 的请求补上 `user-token` 头 —— 没有账号的客户端
 *     连可运行的脚本都下载不到（防白嫖的第一道服务端闸门）。
 *  2. 资源返回 401/403 时清掉本地密钥缓存，让上层尽快走登录引导。
 *  3. 暴露 getUserToken / clearUserTokenCache 给插件自己的页面复用。
 */

const QQ1000_STATIC_HOST = "https://tu.qq1000.com/plugin-static/";
const QQ1000_API_HOST = "https://tu.qq1000.com";

const TOKEN_STORAGE_KEY = "cj-user-token";

let cachedToken = "";
let cachedTokenAt = 0;

export function clearUserTokenCache() {
    cachedToken = "";
    cachedTokenAt = 0;
}

export async function getUserToken(force = false) {
    const now = Date.now();
    if (!force && cachedToken && now - cachedTokenAt < 15000) return cachedToken;
    let value = "";
    try {
        const stored = await chrome.storage.sync.get([TOKEN_STORAGE_KEY]);
        value = String((stored && stored[TOKEN_STORAGE_KEY]) || "").trim();
    } catch (error) {
        value = "";
    }
    cachedToken = value;
    cachedTokenAt = now;
    return value;
}

export function apiHost() {
    return QQ1000_API_HOST;
}

// 内容脚本没有 chrome.tabs 权限，所以「打开登录页」由 service worker 代劳。
try {
    chrome.runtime.onMessage.addListener((message, _sender, respond) => {
        if (!message || message.cmd !== "qq1000:open-login") return false;
        const url = chrome.runtime.getURL("popup.html?mode=login");
        try {
            chrome.tabs.create({ url, active: true }, () => {
                try { respond({ ok: true }); } catch (error) {}
            });
        } catch (error) {
            try { respond({ ok: false, error: String(error && error.message) }); } catch (inner) {}
        }
        return true;
    });
} catch (error) {}

try {
    const nativeFetch = self.fetch.bind(self);

    self.fetch = async function qq1000Fetch(input, init) {
        let url = "";
        try {
            url = typeof input === "string" ? input : (input && input.url) || "";
        } catch (error) {
            url = "";
        }

        const isStaticAsset = typeof url === "string" && url.startsWith(QQ1000_STATIC_HOST);
        if (isStaticAsset) {
            try {
                const token = await getUserToken();
                if (token) {
                    const base = init || {};
                    const headers = new Headers(base.headers || (input && input.headers) || undefined);
                    if (!headers.has("user-token")) headers.set("user-token", token);
                    init = Object.assign({}, base, { headers });
                }
            } catch (error) {}
        }

        const response = await nativeFetch(input, init);

        if (isStaticAsset && (response.status === 401 || response.status === 403)) {
            clearUserTokenCache();
        }
        return response;
    };

    chrome.storage.onChanged.addListener((changes) => {
        if (changes && changes[TOKEN_STORAGE_KEY]) clearUserTokenCache();
    });
} catch (error) {
    // 包不住也不能让 service worker 起不来：退化成原生 fetch。
}
