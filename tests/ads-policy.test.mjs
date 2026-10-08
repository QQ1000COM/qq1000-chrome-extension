import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createAdsRuntime as runtime, createAllAdSurfacesRuntime, adDefinition as definition, AdElement as Element, AD_TEST_NOW as now, uiOverridesSource } from "./helpers/ads-runtime.mjs";

const ad = (extra = {}) => ({ id: "configured-ad", enabled: true, title: "Configured offer", linkUrl: "https://example.test/offer", ...extra });

for (const [label, record] of [
    ["disabled", ad({ enabled: false })],
    ["not explicitly enabled", ad({ enabled: undefined })],
    ["missing id", ad({ id: "" })],
    ["expired", ad({ endAt: Math.floor(now / 1000) - 1 })],
    ["not yet started", ad({ startAt: Math.floor(now / 1000) + 60 })],
    ["invalid schedule", ad({ endAt: "not-a-date" })],
    ["missing real content", ad({ title: "", subtitle: "", content: "", imageUrl: "", buttonText: "Click" })],
    ["missing entry link", ad({ linkUrl: "" })],
    ["unsafe entry link", ad({ linkUrl: "javascript:alert(1)" })],
    ["legacy targeted ad", ad({ pluginId: "a-specific-plugin" })],
]) {
    test(`${label} sidebar advertisements are never selected`, () => {
        const app = runtime({ ads: { sidebar: [record] } });
        assert.equal(app.run('pickAd(ads, "sidebar")'), null);
    });
}

test("a configured active advertisement is selected without changing its content", () => {
    const app = runtime({ ads: { sidebar: [ad()] } });
    const selected = app.run('pickAd(ads, "sidebar")');
    assert.equal(selected.title, "Configured offer");
    assert.equal(selected.linkUrl, "https://example.test/offer");
});

test("empty configured placements clear the sidebar even when old AI branding contains a promotion URL", () => {
    const app = runtime({ data: { branding: { aiLabel: "Old promotion", aiUrl: "https://example.test/old" }, adsByPlacement: {} } });
    app.run("renderPortalConfig(data)");
    assert.equal(app.context.adConfig, null);
});

test("VIP site advertisements never fill an unconfigured extension sidebar", () => {
    const app = runtime({ data: { adsByPlacement: { vip: [ad()] } } });
    app.run("renderPortalConfig(data)");
    assert.equal(app.context.adConfig, null);
});

test("unauthenticated runtime payloads clear rather than reuse configured advertisements", () => {
    const app = runtime({ data: { loggedIn: false, adsByPlacement: { sidebar: [ad()], banner: [ad()] } } });
    app.run("renderPortalConfig(data)");
    assert.equal(app.context.adConfig, null);
    assert.equal(app.document.getElementById("qq1000-portal-ad-banner"), undefined);
});

test("clearing popup configuration removes an already visible popup", () => {
    const app = runtime(); const popup = new Element(); popup.id = "qq1000-portal-ad-popup"; app.body.appendChild(popup);
    app.run("showPopupAd(null)");
    assert.equal(app.document.getElementById(popup.id), undefined);
});

test("a popup with no visible configured content is not created", () => {
    const app = runtime({ record: ad({ title: "", subtitle: "", content: "", imageUrl: "" }) });
    app.run("showPopupAd(record)");
    assert.equal(app.document.getElementById("qq1000-portal-ad-popup"), undefined);
});

test("text-only banner and popup advertisements do not invent destination buttons", () => {
    const app = runtime({ record: ad({ linkUrl: "" }) });
    app.run("injectBannerAd(record); showPopupAd(record)");
    const banner = app.document.getElementById("qq1000-portal-ad-banner");
    const popup = app.document.getElementById("qq1000-portal-ad-popup");
    assert.ok(banner && popup);
    assert.equal(banner.querySelector(".qq1000-ad-go"), null);
    assert.equal(popup.querySelector(".qq1000-ad-go"), null);
});

test("blank configured button text never falls back to generic promotional calls to action", () => {
    const app = runtime({ record: ad({ buttonText: "" }) });
    app.run("injectBannerAd(record); showPopupAd(record)");
    assert.equal(app.document.getElementById("qq1000-portal-ad-banner").querySelector(".qq1000-ad-go"), null);
    assert.equal(app.document.getElementById("qq1000-portal-ad-popup").querySelector(".qq1000-ad-go"), null);
});

test("all ad fields and placements participate in refresh detection", () => {
    const app = runtime({ first: { adsVersion: 1, adsByPlacement: { tb_panel: [ad()] } }, second: { adsVersion: 1, adsByPlacement: { tb_panel: [ad({ linkUrl: "https://example.test/new", content: "New copy" })] } } });
    assert.notEqual(app.run("portalSignatureOf(first)"), app.run("portalSignatureOf(second)"));
});

test("deleting scheduled advertisements before their start cannot restore stale placements", async () => {
    let clock = now;
    let responseData = { adsByPlacement: Object.fromEntries(["sidebar", "banner", "popup", "tb_panel", "move_panel"].map(placement => [placement, [ad({ id: placement, placement, startAt: now / 1000 + 60 })]])) };
    const app = createAllAdSurfacesRuntime({
        Date: class extends Date { static now() { return clock; } }, AbortController, setTimeout, clearTimeout,
        PORTAL_TTL: 15000, PORTAL_REQUEST_TIMEOUT_MS: 12000,
        portalInflight: null, portalFetchedAt: 0, portalReloadRequested: false,
        readUserToken: async () => "synthetic-session",
        fetch: async () => ({ status: 200, json: async () => ({ code: 0, data: responseData }) }), scheduleApply() {},
    });
    app.load("loadOnlinePortalConfig");
    await app.run("loadOnlinePortalConfig(true)");
    assert.equal(app.sidebar.hidden, true);
    responseData = { adsByPlacement: {} };
    await app.run("loadOnlinePortalConfig(true)");
    clock += 61 * 1000;
    app.run("renderCurrentAds()");
    for (const entry of [app.sidebar, app.toolbar, ...[...app.moves.values()].map(item => item.entry)]) {
        assert.equal(entry.hidden, true);
        assert.equal(entry.style.display, "none");
    }
    assert.equal(app.document.getElementById("qq1000-portal-ad-banner"), undefined);
    assert.equal(app.document.getElementById("qq1000-portal-ad-popup"), undefined);
});

test("no configured sidebar ad hides the whole promotional entry without throwing", () => {
    const app = runtime({ adConfig: null });
    const entry = new Element(); entry.innerHTML = '<span class="menu-title"></span><span class="cj-xingtu-sub"></span>';
    app.context.entry = entry;
    assert.doesNotThrow(() => app.run("applyAd(entry)"));
    assert.ok(entry.hidden || entry.style.display === "none");
});

test("promotional URL normalization never invents a homepage URL", () => {
    const app = runtime();
    assert.equal(app.run('absoluteUrl("")'), "");
    assert.equal(app.run('absoluteUrl("javascript:alert(1)")'), "");
    assert.equal(app.run('absoluteUrl("//example.test/offer")'), "");
    assert.equal(app.run('absoluteUrl("/offers")'), "https://tu.qq1000.com/offers");
});

test("the packaged config has no built-in AI advertising fallback", () => {
    const config = JSON.parse(fs.readFileSync(new URL("../config/app-config.json", import.meta.url), "utf8"));
    assert.ok(!config.aiAd || !Object.values(config.aiAd).some(Boolean));
});

test("disabled toolbar advertisements are absent from the real toolbar renderer", () => {
    const bar = new Element();
    const app = runtime({ ads: { tb_panel: [ad({ enabled: false })] }, document: {
        querySelector: () => bar, querySelectorAll: () => [bar], createElement: () => new Element(),
    } });
    vm.runInContext(definition("renderPanelAdBar"), app.context);
    app.run("renderPanelAdBar(ads)");
    assert.equal(bar.children.length, 0);
    assert.equal(bar.style.display, "none");
});

test("missing move-panel configuration hides its entry but allows later valid configuration to restore it", () => {
    const root = new Element(); const entry = new Element(); const label = new Element();
    label.textContent = "礼品代发"; root.appendChild(entry); entry.appendChild(label); label.closest = () => entry;
    const app = runtime({ ads: {}, MOVE_AD_SLOTS: [{ label: "礼品代发", match: /礼品/ }], directLabelNode: () => label, normalizeText: value => String(value || "").trim() });
    vm.runInContext(definition("applyMovePanelAds"), app.context);
    app.run("applyMovePanelAds(ads)");
    assert.equal(entry.parentElement, root);
    assert.ok(entry.hidden || entry.style.display === "none");
    app.context.ads = { move_panel: [ad({ title: "Configured gift offer" })] };
    app.run("applyMovePanelAds(ads)");
    assert.equal(entry.parentElement, root);
    assert.equal(entry.hidden, false);
    assert.equal(label.textContent, "Configured gift offer");
});

test("expired move-panel advertisements cannot leave their previous destination active", () => {
    const entry = new Element(); const label = new Element(); entry.appendChild(label); label.closest = () => entry;
    const app = runtime({ ads: { move_panel: [ad({ title: "礼品代发" })] }, MOVE_AD_SLOTS: [{ label: "礼品代发", match: /礼品/ }], directLabelNode: () => label, normalizeText: value => String(value || "").trim() });
    vm.runInContext(definition("applyMovePanelAds"), app.context);
    app.run("applyMovePanelAds(ads)");
    app.context.ads.move_panel[0].endAt = now / 1000 - 1;
    app.run("applyMovePanelAds(ads)");
    assert.ok(entry.hidden || entry.style.display === "none");
    assert.equal(entry.dataset.qq1000AdUrl, "");
});

test("configured visibility flags cannot be replaced by default promotional copy", () => {
    const app = runtime({ ads: { banner: [ad({ showTitle: false, subtitle: "hidden", showSubtitle: false })] } });
    assert.equal(app.run('pickAd(ads, "banner")'), null);
});

for (const [label, fetchResult] of [
    ["empty server response", async () => ({ status: 200, json: async () => null })],
    ["HTTP 401", async () => ({ status: 401, json: async () => ({ code: 0 }) })],
    ["network failure", async () => { throw new Error("offline"); }],
]) {
    test(`${label} clears previously visible advertisements without restoring defaults`, async () => {
        const app = runtime({ AbortController, setTimeout, clearTimeout, PORTAL_TTL: 15000, PORTAL_REQUEST_TIMEOUT_MS: 12000,
            portalInflight: null, portalFetchedAt: 0, portalReloadRequested: false,
            readUserToken: async () => "synthetic", fetch: fetchResult, scheduleApply() {},
            data: { adsByPlacement: { sidebar: [ad()], banner: [ad()], popup: [ad()] } },
        });
        app.run("renderPortalConfig(data)");
        assert.ok(app.document.getElementById("qq1000-portal-ad-banner"));
        app.load("loadOnlinePortalConfig");
        await app.run("loadOnlinePortalConfig(true)");
        assert.equal(app.context.adConfig, null);
        assert.equal(app.document.getElementById("qq1000-portal-ad-banner"), undefined);
        assert.equal(app.document.getElementById("qq1000-portal-ad-popup"), undefined);
    });
}

test("a failed image-only advertisement is hidden without a replacement image", () => {
    const app = runtime({ record: ad({ title: "", imageUrl: "https://example.test/missing.png", linkUrl: "" }) });
    app.run("injectBannerAd(record)");
    const banner = app.document.getElementById("qq1000-portal-ad-banner");
    const image = banner.querySelector(".qq1000-banner-ad-image");
    assert.equal(typeof image.listeners.error, "function");
    image.listeners.error();
    assert.ok(banner.hidden || banner.style.display === "none");
    assert.equal(banner.querySelector(".qq1000-banner-ad-image"), null);
});

test("an advertisement with configured text keeps its text when the image fails", () => {
    const app = runtime({ record: ad({ imageUrl: "https://example.test/missing.png" }) });
    app.run("injectBannerAd(record)");
    const banner = app.document.getElementById("qq1000-portal-ad-banner");
    const image = banner.querySelector(".qq1000-banner-ad-image");
    assert.equal(typeof image.listeners.error, "function");
    image.listeners.error();
    assert.notEqual(banner.hidden, true);
    assert.match(banner.textContent, /Configured offer/);
    assert.equal(banner.querySelector(".qq1000-banner-ad-image"), null);
});

test("epoch-zero expiry and hidden body text cannot become an always-on ad", () => {
    const app = runtime({ rows: { sidebar: [ad({ endAt: 0 })], banner: [ad({ title: "", content: "Hidden copy", showSubtitle: false })] } });
    assert.equal(app.run('pickAd(rows, "sidebar")'), null);
    assert.equal(app.run('pickAd(rows, "banner")'), null);
});

for (const placement of ["banner", "popup"]) {
    for (const field of ["imageUrl", "linkUrl"]) {
        test(`${placement} rejects an explicitly invalid ${field} instead of displaying a downgraded ad`, () => {
            const app = runtime({ rows: { [placement]: [ad({ [field]: "javascript:invalid" })] } });
            assert.equal(app.run(`pickAd(rows, ${JSON.stringify(placement)})`), null);
        });
    }
}

test("deleting all configured ads removes every ad surface and its space while keeping brand and recharge", () => {
    const app = createAllAdSurfacesRuntime({ data: { adsByPlacement: Object.fromEntries(["sidebar", "banner", "popup", "tb_panel", "move_panel"].map(placement => [placement, [ad({ id: placement, placement })]])) } });
    app.run("renderPortalConfig(data)");
    assert.equal(app.sidebar.hidden, false);
    assert.equal(app.toolbar.hidden, false);
    assert.equal(app.moves.get("礼品代发").entry.hidden, false);
    assert.ok(app.document.getElementById("qq1000-portal-ad-banner"));
    assert.ok(app.document.getElementById("qq1000-portal-ad-popup"));
    app.run("renderPortalConfig({adsByPlacement:{}})");
    for (const entry of [app.sidebar, app.toolbar, ...[...app.moves.values()].map(item => item.entry)]) {
        assert.equal(entry.hidden, true);
        assert.equal(entry.style.display, "none");
    }
    assert.equal(app.toolbar.children.length, 0);
    assert.equal(app.document.getElementById("qq1000-portal-ad-banner"), undefined);
    assert.equal(app.document.getElementById("qq1000-portal-ad-popup"), undefined);
    assert.equal(app.brand.parentElement, app.panel);
    assert.equal(app.recharge.parentElement, app.panel);
});

test("image-only toolbar ads occupy no space until loaded and collapse again if their image fails", () => {
    const app = createAllAdSurfacesRuntime({ data: { adsByPlacement: { tb_panel: [ad({ title: "", imageUrl: "https://example.test/ad.png" })] } } });
    app.run("renderPortalConfig(data)");
    assert.equal(app.toolbar.hidden, true);
    assert.equal(app.toolbar.style.display, "none");
    const image = app.toolbar.children[0].querySelector(".qq1000-toolbar-ad-image");
    image.listeners.load();
    assert.equal(app.toolbar.hidden, false);
    image.listeners.error();
    assert.equal(app.toolbar.hidden, true);
    assert.equal(app.toolbar.style.display, "none");
});

for (const placement of ["sidebar", "move_panel"]) {
    test(`a late ${placement} image event cannot restore an advertisement after configuration deletion`, () => {
        const app = createAllAdSurfacesRuntime({ data: { adsByPlacement: { [placement]: [ad({ title: "", imageUrl: "https://example.test/ad.png" })] } } });
        app.run("renderPortalConfig(data)");
        const entry = placement === "sidebar" ? app.sidebar : app.moves.get("礼品代发").entry;
        const image = entry.querySelector(".qq1000-sidebar-ad-image");
        assert.ok(image);
        app.run("renderPortalConfig({adsByPlacement:{}})");
        image.listeners.load();
        assert.equal(entry.hidden, true);
        assert.equal(entry.style.display, "none");
    });
}

for (const placement of ["sidebar", "banner", "popup", "tb_panel", "move_panel"]) {
    test(`${placement} honors the configured advertisement-label toggle`, () => {
        const app = createAllAdSurfacesRuntime({ data: { adsByPlacement: { [placement]: [ad({ id: placement, showAdLabel: true })] } } });
        app.run("renderPortalConfig(data)");
        const container = () => placement === "sidebar" ? app.sidebar
            : placement === "move_panel" ? app.moves.get("礼品代发").entry
                : placement === "tb_panel" ? app.toolbar
                    : app.document.getElementById(placement === "banner" ? "qq1000-portal-ad-banner" : "qq1000-portal-ad-popup");
        assert.ok(container().querySelector(".qq1000-ad-badge"));
        app.context.data.adsByPlacement[placement][0].showAdLabel = false;
        app.run("renderPortalConfig(data)");
        assert.equal(container().querySelector(".qq1000-ad-badge"), null);
    });
}

test("legacy toolbar promotions cannot be moved into ordinary business tool groups", () => {
    const promotion = { label: "资源推荐", closest: selector => selector.includes(".h-00-col2") ? {} : null };
    const business = { label: "复制SKU", closest: () => null };
    const context = vm.createContext({ toolRoots: () => [{ querySelectorAll: () => [promotion, business] }],
        TOOL_BUTTON_CLASSES: ["jc-top-btn-primary"], TOOLS_ATTR: "data-qq1000-tools", inToolbarRegion: () => true,
        toolLabelOf: node => node.label, toolMoveTarget: node => node,
    });
    vm.runInContext(definition("collectToolButtons"), context);
    const rows = vm.runInContext("collectToolButtons()", context);
    assert.deepEqual(Array.from(rows, row => row.label), ["复制SKU"]);
});

test("move-panel ads reveal the actual outer entry, never only the menu-title label", () => {
    const app = createAllAdSurfacesRuntime({ data: { adsByPlacement: { move_panel: [ad()] } } });
    const { entry, label } = app.moves.get("礼品代发");
    assert.equal(label.closest(".cj-gm-entry, [class*='menu']"), label, "CSS closest evaluates matching on the current node before ancestors");
    app.run("renderPortalConfig(data)");
    assert.equal(entry.hidden, false);
    assert.notEqual(entry.style.display, "none");
    assert.equal(entry.getAttribute("data-qq1000-ad-visible"), "1");
    assert.equal(label.textContent, "Configured offer");
});

test("an outdated asynchronous token read cannot restore old advertisements after a login change", async () => {
    let readCount = 0; let onChange;
    let resolveOldRead; const oldRead = new Promise(resolve => { resolveOldRead = resolve; });
    let resolveNewResponse; const newResponse = new Promise(resolve => { resolveNewResponse = resolve; });
    const app = runtime({ AbortController, setTimeout, clearTimeout, PORTAL_TTL: 15000, PORTAL_REQUEST_TIMEOUT_MS: 12000,
        portalInflight: null, portalFetchedAt: 0, portalReloadRequested: false, portalSessionGeneration: 0,
        chrome: { storage: { onChanged: { addListener: listener => { onChange = listener; } } } },
        readUserToken: () => ++readCount === 2 ? oldRead : Promise.resolve(readCount === 1 ? "old-synthetic" : "new-synthetic"),
        fetch: async (_url, options) => options.headers["user-token"] === "old-synthetic"
            ? { status: 200, json: async () => ({ code: 0, data: { adsByPlacement: { sidebar: [ad({ id: "old-ad" })] } } }) }
            : newResponse,
        scheduleApply() {},
    });
    app.load("loadOnlinePortalConfig", "handleAdSessionChange");
    const start = uiOverridesSource.indexOf("        chrome.storage.onChanged.addListener(");
    const end = uiOverridesSource.indexOf("\n    } catch", start);
    vm.runInContext(uiOverridesSource.slice(start, end), app.context);
    const oldRequest = app.run("loadOnlinePortalConfig(true)");
    for (let index = 0; index < 8; index++) await new Promise(resolve => setImmediate(resolve));
    assert.equal(readCount, 2);
    onChange({ "cj-user-token": { newValue: "new-synthetic" } }, "sync");
    resolveOldRead("old-synthetic");
    try {
        await oldRequest;
        assert.equal(app.context.adConfig, null);
    } finally {
        resolveNewResponse({ status: 200, json: async () => ({ code: 0, data: { adsByPlacement: { sidebar: [ad({ id: "new-ad" })] } } }) });
        for (let index = 0; index < 8; index++) await new Promise(resolve => setImmediate(resolve));
    }
    assert.equal(app.context.adConfig.id, "new-ad");
});

test("an image-only popup is counted as shown only after its image is visible", () => {
    const app = runtime({ record: ad({ title: "", imageUrl: "https://example.test/popup.png", linkUrl: "" }) });
    app.run("showPopupAd(record)");
    let popup = app.document.getElementById("qq1000-portal-ad-popup");
    popup.querySelector(".qq1000-ad-popup-img").listeners.error();
    assert.equal(Object.keys(JSON.parse(app.context.window.localStorage.getItem("qq1000:ad:seen") || "{}")).length, 0);
    app.run("showPopupAd(null)");
    app.context.Date = class extends Date { static now() { return now + 6 * 60 * 1000; } };
    app.run("showPopupAd(record)");
    popup = app.document.getElementById("qq1000-portal-ad-popup");
    assert.ok(popup);
    popup.querySelector(".qq1000-ad-popup-img").listeners.load();
    assert.equal(popup.hidden, false);
    assert.equal(Object.keys(JSON.parse(app.context.window.localStorage.getItem("qq1000:ad:seen") || "{}")).length, 1);
});

test("closing a popup stays effective when page localStorage is unavailable", () => {
    const app = runtime({ record: ad(), window: { localStorage: { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } } } });
    app.run("showPopupAd(record)");
    const popup = app.document.getElementById("qq1000-portal-ad-popup");
    popup.querySelector(".qq1000-ad-close").listeners.click({ preventDefault() {}, stopImmediatePropagation() {} });
    app.run("showPopupAd(record)");
    assert.equal(app.document.getElementById("qq1000-portal-ad-popup"), undefined);
});

for (const placement of ["sidebar", "move_panel"]) {
    test(`old ${placement} image events cannot reveal a newly configured image`, () => {
        const app = createAllAdSurfacesRuntime({ data: { adsByPlacement: { [placement]: [ad({ title: "", imageUrl: "https://example.test/old.png" })] } } });
        app.run("renderPortalConfig(data)");
        const entry = placement === "sidebar" ? app.sidebar : app.moves.get("礼品代发").entry;
        const oldImage = entry.querySelector(".qq1000-sidebar-ad-image");
        app.context.data.adsByPlacement[placement][0].imageUrl = "https://example.test/new.png";
        app.run("renderPortalConfig(data)");
        const currentImage = entry.querySelector(".qq1000-sidebar-ad-image");
        oldImage.listeners.load();
        oldImage.listeners.error();
        assert.equal(entry.hidden, true);
        assert.notEqual(currentImage, oldImage);
        currentImage.listeners.load();
        assert.equal(entry.hidden, false);
    });
}
