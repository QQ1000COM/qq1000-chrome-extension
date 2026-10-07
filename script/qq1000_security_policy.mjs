// Page scripts are untrusted even when they share an origin with the injected UI.
// Keep browser privilege policy in the service worker, not in the downloadable SDK.
const COMMERCE_DOMAINS = [
    "taobao.com", "tmall.com", "tmall.hk", "1688.com", "alimama.com",
    "95095.com", "liangxinyao.com", "pinduoduo.com", "yangkeduo.com",
    "jd.com", "jd.hk", "douyin.com", "jinritemai.com", "kwaixiaodian.com",
    "kuaishou.com", "goofish.com", "weixin.qq.com",
];

const PAGE_CHROME_APIS = new Set([
    "tabs.query", "tabs.get", "tabs.getCurrent", "tabs.create", "tabs.update",
    "tabs.remove", "tabs.reload", "tabs.sendMessage", "runtime.getManifest",
    "runtime.getURL", "runtime.getPlatformInfo", "downloads.download",
    "downloads.search", "downloads.cancel", "downloads.pause", "downloads.resume",
    "notifications.create", "notifications.update", "notifications.clear",
]);

function matchesDomain(host, domain) {
    return host === domain || host.endsWith("." + domain);
}

function httpUrl(value) {
    try {
        const url = new URL(value);
        return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? url : null;
    } catch { return null; }
}

function commerceCookieTarget(value) {
    if (typeof value !== "string" || !value) return false;
    const url = httpUrl(value.includes("://") ? value : "https://" + value.replace(/^\./, ""));
    return !!url && COMMERCE_DOMAINS.some(domain => matchesDomain(url.hostname, domain));
}

function cookieTargets(request, command) {
    switch (command) {
        case "get_current_cookies": return [request.data?.url];
        case "get_cookies_str": return [request.data];
        case "getCookies": return [request.myDomain];
        case "removeCookie": return request.removeInfos ? (Array.isArray(request.removeInfos) ? request.removeInfos.map(item => item?.url) : [undefined]) : [request.url];
        case "setCookies": {
            const data = request.data || request;
            if (!Array.isArray(data.cookieData)) return [undefined];
            return data.cookieData.flatMap(item => [item?.detail?.url || data.domainUrl, ...(item?.detail?.domain ? [item.detail.domain] : []), ...(data.domain ? [data.domain] : [])]);
        }
        case "cookie":
            if (request.action === "set") return [request.details?.url, ...(request.details?.domain ? [request.details.domain] : [])];
            if (request.action === "setBatch") return Array.isArray(request.cookieList) ? request.cookieList.flatMap(item => [item?.url, ...(item?.domain ? [item.domain] : [])]) : [undefined];
            return [request.action === "remove" ? request.url : request.domain];
        default: return null;
    }
}

export function runtimeMessageError(request, sender, extensionId) {
    if (!request || typeof request !== "object" || Array.isArray(request)) return "Invalid message";
    if (!sender || sender.id !== extensionId) return "Untrusted sender";
    const command = request.cmd || request.type;
    if (typeof command !== "string") return "Invalid command";
    // Extension popup/pages do not cross the page bridge.
    if (!sender.tab && sender.url?.startsWith("chrome-extension://" + extensionId + "/")) return null;
    const source = httpUrl(sender.origin && sender.origin !== "null" ? sender.origin : sender.url);
    if (!source || !(COMMERCE_DOMAINS.some(domain => matchesDomain(source.hostname, domain)) || source.origin === "https://tu.qq1000.com")) return "Unsupported page origin";

    if (command === "chrome_api_call" && (!PAGE_CHROME_APIS.has(request.api) || !Array.isArray(request.params || []))) return "Chrome API is not available to pages";
    if (command === "chrome_api_batch_call" && (!Array.isArray(request.calls) || request.calls.length > 50 || !request.calls.every(call => call && PAGE_CHROME_APIS.has(call.api) && Array.isArray(call.params || [])))) return "Chrome API batch is not available to pages";
    if (command === "proxy_api_request" && request.apiConfig?.needAuth && !isAuthenticatedApiUrl(request.apiConfig.url)) return "Authentication is only available to the QQ1000 plugin API";

    // Dedicated cookie adapters remain for seller workflows, but must never expose
    // portal/admin, unrelated websites, or an unfiltered browser-wide cookie jar.
    const targets = cookieTargets(request, command);
    if (targets && (!targets.length || !targets.every(commerceCookieTarget))) return "Cookie target is outside supported commerce sites";
    return null;
}

export function isAuthenticatedApiUrl(value) {
    if (typeof value !== "string" || !value) return false;
    try {
        // Match the legacy handler's absolute/relative URL construction exactly.
        const url = new URL(value.startsWith("http") ? value : "https://tu.qq1000.com" + value);
        return url.origin === "https://tu.qq1000.com" && !url.username && !url.password && url.pathname.startsWith("/plugin/api/");
    } catch { return false; }
}

export function canForwardCookie(cookie, pageUrl) {
    if (!cookie || cookie.httpOnly || cookie.partitionKey || !cookie.domain) return false;
    const url = httpUrl(pageUrl);
    if (!url || (cookie.secure && url.protocol !== "https:")) return false;
    const domain = cookie.domain.replace(/^\./, "").toLowerCase();
    if (!commerceCookieTarget(domain) || !(cookie.hostOnly ? url.hostname === domain : matchesDomain(url.hostname, domain))) return false;
    const path = cookie.path || "/";
    return url.pathname === path || (url.pathname.startsWith(path) && (path.endsWith("/") || url.pathname[path.length] === "/"));
}

export function forwardCookieChange(change, chromeApi) {
    if (!change?.cookie || change.cookie.httpOnly || change.cookie.partitionKey) return;
    chromeApi.tabs.query({}, tabs => {
        for (const tab of tabs || []) {
            if (!Number.isInteger(tab.id) || !canForwardCookie(change.cookie, tab.url)) continue;
            // Top frame only: sending to every frame could leak to embedded origins.
            chromeApi.tabs.sendMessage(tab.id, { cmd: "cookie_change", type: 9001, data: change }, { frameId: 0 }, () => void chromeApi.runtime.lastError);
        }
    });
}
