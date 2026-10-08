// Test-only loader for actual private frontend functions. Nothing is exposed
// on a production page; callers may supply their own document/window fixtures.
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

export const AD_TEST_NOW = Date.parse("2026-10-08T04:00:00Z");
export const uiOverridesSource = fs.readFileSync(new URL("../../script/qq1000_ui_overrides.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
export function adDefinition(name) {
    const start = uiOverridesSource.indexOf(`    function ${name}(`);
    if (start < 0) return "";
    const end = uiOverridesSource.indexOf("\n    }\n", start);
    assert.ok(end > start, name);
    return uiOverridesSource.slice(start, end + 7);
}
export function loadAdFunctions(context, names) {
    for (const name of names) {
        const code = adDefinition(name);
        if (code) vm.runInContext(code, context);
    }
}
export class AdElement {
    constructor(tagName = "div") { this.tagName = tagName.toUpperCase(); this.children = []; this.dataset = {}; this.attrs = {}; this.listeners = {}; this.connectedRoot = false; this.style = { setProperty: (key, value) => { this.style[key] = value; }, removeProperty: key => { delete this.style[key]; } }; }
    clearChildren() { this.children.forEach(child => { child.parentElement = null; }); this.children = []; }
    set innerHTML(value) {
        this.clearChildren();
        for (const match of value.matchAll(/class="([^"]+)"/g)) { const node = new AdElement(); node.className = match[1]; this.appendChild(node); }
    }
    get textContent() { return (this._text || "") + this.children.map(child => child.textContent).join(""); }
    set textContent(value) { this._text = String(value || ""); this.clearChildren(); }
    appendChild(child) { if (child.parentElement) child.parentElement.children = child.parentElement.children.filter(node => node !== child); child.parentElement = this; this.children.push(child); return child; }
    insertBefore(child) { return this.appendChild(child); }
    remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this); this.parentElement = null; this.removed = true; }
    setAttribute(key, value) { this.attrs[key] = String(value); if (key.startsWith("data-")) this.dataset[key.slice(5).replace(/-([a-z])/g, (_, char) => char.toUpperCase())] = String(value); }
    getAttribute(key) { if (key === "class") return this.className || ""; if (key.startsWith("data-")) return this.dataset[key.slice(5).replace(/-([a-z])/g, (_, char) => char.toUpperCase())] ?? null; return this.attrs[key] ?? null; }
    removeAttribute(key) { delete this.attrs[key]; if (key.startsWith("data-")) delete this.dataset[key.slice(5).replace(/-([a-z])/g, (_, char) => char.toUpperCase())]; }
    contains(node) { return node === this || this.children.some(child => child.contains(node)); }
    querySelector(selector) { return this.children.find(child => child.className?.split(" ").includes(selector.slice(1))) || this.children.map(child => child.querySelector(selector)).find(Boolean) || null; }
    querySelectorAll() { return []; }
    addEventListener(name, listener) { this.listeners[name] = listener; }
    matches(selector) {
        return selector.split(",").some(raw => {
            const part = raw.trim();
            if (part.startsWith(".")) return (this.className || "").split(/\s+/).includes(part.slice(1));
            if (part.startsWith("#")) return this.id === part.slice(1);
            const contains = part.match(/^\[class\*=['"]([^'"]+)['"]\]$/);
            if (contains) return (this.className || "").includes(contains[1]);
            const attribute = part.match(/^\[([^=\]]+)(?:=['"]?([^'"\]]+)['"]?)?\]$/);
            if (attribute) return attribute[2] === undefined ? this.getAttribute(attribute[1]) !== null : this.getAttribute(attribute[1]) === attribute[2];
            return this.tagName.toLowerCase() === part.toLowerCase();
        });
    }
    closest(selector) { for (let node = this; node; node = node.parentElement) if (node.matches(selector)) return node; return null; }
    get isConnected() { return this.connectedRoot || !!this.parentElement?.isConnected; }
}

export function createAdsRuntime(extra = {}) {
    const body = new AdElement(); body.connectedRoot = true; const panel = new AdElement(); body.appendChild(panel);
    panel.id = "cj-goods-side-panel-root";
    const storage = new Map();
    const find = (node, id) => node.id === id ? node : node.children.map(child => find(child, id)).find(Boolean);
    const document = extra.document || { body, documentElement: body, createElement: () => new AdElement(), getElementById: id => find(body, id), querySelector: () => null, querySelectorAll: () => [] };
    const nowMs = extra.nowMs ?? AD_TEST_NOW;
    const context = vm.createContext({
        API_HOST: "https://tu.qq1000.com", PANEL_ID: panel.id, AD_BANNER_ID: "qq1000-portal-ad-banner", AD_POPUP_ID: "qq1000-portal-ad-popup",
        Date: class extends Date { static now() { return nowMs; } }, URL, document,
        window: { localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) } },
        adConfig: { label: "previous", url: "https://example.test/old" }, lastAdsByPlacement: {}, portalSignature: "", failedAdImages: new Map(), shownPopupKeys: new Set(), portalSessionGeneration: 0,
        MOVE_AD_SLOTS: [{ label: "礼品代发", match: /礼品|代发/ }, { label: "查降权号", match: /降权/ }],
        PLUGIN_OWNED_CLASS: /^(cj-|jc-|gg-|gm-|uc-|kd-|kdcm|qq1000-|h-00|plugin-)/,
        openAd() {}, openAdFromKeyboard() {}, openLink() {}, removeNode: node => node.remove(),
        ...extra,
    });
    const functions = ["normalizeText", "directTextOf", "directLabelNode", "adBoolean", "adTimestamp", "absoluteUrl", "normalizeAd", "adsForPlacement", "adSignature", "adKey", "applyAdBadge", "watchAdImage", "pickAd", "portalSignatureOf", "applyAd", "injectBannerAd", "showPopupAd", "renderPanelAdBar", "applyMovePanelAds", "renderCurrentAds", "renderPortalConfig"];
    loadAdFunctions(context, functions.filter(name => !Object.prototype.hasOwnProperty.call(extra, name)));
    return { context, body, panel, document, load: (...names) => loadAdFunctions(context, names), run: expression => vm.runInContext(expression, context) };
}

export function createAllAdSurfacesRuntime(extra = {}) {
    const body = new AdElement(); body.connectedRoot = true; const panel = new AdElement(); panel.id = "cj-goods-side-panel-root"; body.appendChild(panel);
    const sidebar = new AdElement(); sidebar.className = "cj-gm-entry--xingtu";
    sidebar.innerHTML = '<span class="menu-title"></span><span class="cj-xingtu-sub"></span>';
    panel.appendChild(sidebar);
    const toolbar = new AdElement(); toolbar.className = "h-00-col2"; panel.appendChild(toolbar);
    const moves = new Map();
    for (const name of ["礼品代发", "查降权号"]) {
        const entry = new AdElement(); entry.className = "cj-gm-entry"; entry.hidden = true; entry.style.setProperty("display", "none", "important");
        entry.setAttribute("data-qq1000-move-ad-entry", name);
        const content = new AdElement(); content.className = "menu-content";
        const label = new AdElement("span"); label.className = "menu-title"; label.setAttribute("data-qq1000-move-ad-slot", name);
        content.appendChild(label); entry.appendChild(content); panel.appendChild(entry);
        moves.set(name, { entry, label });
    }
    const brand = new AdElement(); brand.textContent = "QQ1000电商"; panel.appendChild(brand);
    const recharge = new AdElement(); recharge.textContent = "充值入口"; panel.appendChild(recharge);
    const byId = (node, id) => node.id === id ? node : node.children.map(child => byId(child, id)).find(Boolean);
    const document = {
        body, documentElement: body, createElement: () => new AdElement(), getElementById: id => byId(body, id),
        querySelector: selector => {
            if (selector === ".h-00-col2") return toolbar;
            const match = selector.match(/data-qq1000-move-ad-slot="([^"]+)"/);
            return match ? moves.get(match[1])?.label || null : null;
        },
        querySelectorAll: selector => {
            if (selector === ".cj-gm-entry--xingtu") return [sidebar];
            if (selector.includes(".h-00-col2")) return [toolbar];
            return [];
        },
    };
    const runtime = createAdsRuntime({ ...extra, document });
    return { ...runtime, body, panel, sidebar, toolbar, moves, brand, recharge };
}
