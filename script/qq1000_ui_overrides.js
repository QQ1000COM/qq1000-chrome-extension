"use strict";

/*
 * Small, local UI compatibility layer for the hosted goods-manager panel.
 * The same panel is mounted on product, seller-center and publish pages across
 * multiple marketplaces. The business bundle is delivered by CDN, so shared
 * branding and layout fixes live here instead of patching a generated bundle.
 */
(function installQq1000UiOverrides() {
    const PANEL_ID = "cj-goods-side-panel-root";
    // 广告位（资源推荐 / 1元礼品代发 / 真实快递代发 / 查降权旺旺号 等）由后台配置，
    // 必须原样展示，所以不再列入移除清单。
    const REMOVED_ITEM_LABELS = new Set([
        "充值入口"
    ]);
    const BUYER_SHOW_PATCH_EVENT = "qq1000-buyershow-download-start";
    const DEFAULT_AD = {
        label: "QQ1000.AI",
        url: "https://tu.qq1000.com",
        subtitle: "tu.qq1000.com"
    };

    if (window.__QQ1000_UI_OVERRIDES_INSTALLED__) return;
    window.__QQ1000_UI_OVERRIDES_INSTALLED__ = true;

    // 样式尽早注入：等面板渲染出来才注入的话，会先闪一下插件的原始样式。
    installStyle();
    // 从第一帧起就压住插件原来的按钮排布，只等重写后的分组布局
    // （超时兜底会撤掉这个标记，见下面的 setTimeout）。
    document.documentElement.setAttribute("data-qq1000-tools-pending", "1");
    // 面板可能早于本脚本出现（或本脚本运行完就不再产生 DOM 变动），
    // 这里立刻同步跑一次：面板在的话马上完成分类重排，不在也没关系。
    try {
        syncPanelMount();
    } catch (error) {}
    // 兜底：整理过程中万一出错、或按钮迟迟没渲染出来，1.5 秒后无论如何都放开显示，
    // 不能因为整理失败就让面板不可见、按钮消失。
    setTimeout(() => {
        document.documentElement.removeAttribute("data-qq1000-tools-pending");
        try {
            buildToolGroups();
        } catch (error) {
        }
        markPanelsReady();
    }, 1500);

    let adConfig = { ...DEFAULT_AD };
    // 最近一次的广告位数据：面板重新渲染后要靠它把搬家面板的两条推广入口再贴一次
    let lastAdsByPlacement = {};
    let applyTimer = null;
    // 门户配置（品牌 + 广告位）的刷新状态：后台改完要尽快反映到插件。
    let lastAnywherePurgeAt = 0;
    let portalFetchedAt = 0;
    let portalSignature = "";
    let portalInflight = null;

    function installStyle() {
        if (document.getElementById("qq1000-ui-overrides")) return;
        const style = document.createElement("style");
        style.id = "qq1000-ui-overrides";
        style.textContent = `
html body #cj-goods-side-panel-root.goods-side-panel.spm-panel:not(.spm-panel--narrow):not(.spm-panel--dock-left) {
    width: 170px !important;
    min-width: 170px !important;
}
html body #cj-goods-side-panel-root .cj-hd-brand {
    display: flex !important;
    align-items: center !important;
    flex-wrap: nowrap !important;
    min-width: 0 !important;
    min-height: 48px !important;
    box-sizing: border-box !important;
}
html body #cj-goods-side-panel-root .cj-hd-logo {
    flex: 0 0 32px !important;
    width: 32px !important;
    height: 32px !important;
    max-width: 32px !important;
    overflow: hidden !important;
}
html body #cj-goods-side-panel-root .cj-hd-logo-img {
    display: block !important;
    width: 100% !important;
    height: 100% !important;
    max-width: 100% !important;
    object-fit: cover !important;
}
html body #cj-goods-side-panel-root .cj-hd-brand-text {
    flex: 1 1 auto !important;
    width: 0 !important;
    min-width: 0 !important;
    max-width: calc(100% - 42px) !important;
    overflow: hidden !important;
}
html body #cj-goods-side-panel-root .cj-hd-brand-title {
    display: block !important;
    max-width: 100% !important;
    overflow: hidden !important;
    text-overflow: ellipsis !important;
    white-space: nowrap !important;
    font-size: 13px !important;
    line-height: 1.2 !important;
    letter-spacing: 0 !important;
    word-break: keep-all !important;
    overflow-wrap: normal !important;
}
html body #cj-goods-side-panel-root .cj-hd-brand-sub {
    display: block !important;
    max-width: 100% !important;
    overflow: hidden !important;
    text-overflow: ellipsis !important;
    white-space: nowrap !important;
}
html body #cj-goods-side-panel-root .cj-gm-entry--xingtu {
    cursor: pointer !important;
}
html body #cj-goods-side-panel-root .cj-gm-entry--xingtu .menu-content {
    min-width: 0 !important;
    overflow: hidden !important;
}
html body #cj-goods-side-panel-root .cj-gm-entry--xingtu .menu-title,
html body #cj-goods-side-panel-root .cj-gm-entry--xingtu .cj-xingtu-sub {
    max-width: 100% !important;
    overflow: hidden !important;
    text-overflow: ellipsis !important;
    white-space: nowrap !important;
}
html body .qq1000-buyershow-download-menu {
    z-index: 2147483646 !important;
    pointer-events: auto !important;
}
html body #qq1000-portal-ad-banner {
    position: relative !important;
    display: flex !important; flex-direction: column !important; align-items: stretch !important;
    gap: 5px !important; margin: 6px 8px !important; padding: 8px !important; box-sizing: border-box !important;
    border-radius: 8px !important; background: linear-gradient(135deg, #eef2ff 0%, #f8fafc 100%) !important;
    border: 1px solid #dcE3f3 !important; font-size: 11px !important; line-height: 1.4 !important;
    overflow: hidden !important;
}
/* 侧栏面板只有 ~170px 宽：标题行放不下「推荐 + 标题 + 按钮 + 关闭」，
   所以改成竖排三段（标题行 / 副标题 / 按钮整行），按钮永不换行成竖排。 */
html body #qq1000-portal-ad-banner .qq1000-ad-main { min-width: 0 !important; padding-right: 16px !important; }
html body #qq1000-portal-ad-banner .qq1000-ad-head {
    display: flex !important; align-items: center !important; gap: 4px !important;
    min-width: 0 !important; overflow: hidden !important;
}
html body #qq1000-portal-ad-banner .qq1000-ad-badge {
    flex: 0 0 auto !important; padding: 0 4px !important; border-radius: 4px !important;
    background: #101828 !important; color: #fff !important; font-size: 10px !important; line-height: 15px !important;
}
html body #qq1000-portal-ad-banner .qq1000-ad-title {
    flex: 1 1 auto !important; min-width: 0 !important; font-weight: 600 !important; color: #101828 !important;
    white-space: nowrap !important; overflow: hidden !important; text-overflow: ellipsis !important;
}
html body #qq1000-portal-ad-banner .qq1000-ad-sub {
    display: block !important; margin-top: 2px !important; color: #667085 !important;
    white-space: nowrap !important; overflow: hidden !important; text-overflow: ellipsis !important;
}
html body #qq1000-portal-ad-banner .qq1000-ad-actions {
    display: flex !important; align-items: center !important; gap: 6px !important;
}
html body #qq1000-portal-ad-banner .qq1000-ad-go {
    flex: 1 1 auto !important; white-space: nowrap !important; border: 0 !important;
    border-radius: 6px !important; cursor: pointer !important; font-family: inherit !important;
    font-size: 11px !important; line-height: 16px !important; padding: 4px 8px !important;
    background: #4568f2 !important; color: #fff !important;
}
html body #qq1000-portal-ad-banner .qq1000-ad-close {
    position: absolute !important; top: 3px !important; right: 3px !important;
    flex: 0 0 auto !important; border: 0 !important; background: transparent !important;
    color: #98a2b3 !important; padding: 0 3px !important; font-size: 14px !important;
    line-height: 1 !important; cursor: pointer !important;
}
html body #qq1000-portal-ad-popup {
    position: fixed !important; inset: 0 !important; z-index: 2147483647 !important;
    background: rgba(16, 24, 40, 0.45) !important; display: flex !important;
    align-items: center !important; justify-content: center !important;
}
html body #qq1000-portal-ad-popup .qq1000-ad-popup-card {
    position: relative !important; width: 320px !important; max-width: calc(100vw - 32px) !important;
    padding: 18px !important; box-sizing: border-box !important; border-radius: 14px !important;
    background: #fff !important; box-shadow: 0 18px 48px rgba(16, 24, 40, 0.24) !important;
    font: 13px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif !important;
    color: #172033 !important; text-align: center !important;
}
html body #qq1000-portal-ad-popup .qq1000-ad-popup-title { font-size: 16px !important; font-weight: 600 !important; }
html body #qq1000-portal-ad-popup .qq1000-ad-popup-body { margin-top: 8px !important; color: #667085 !important; }
html body #qq1000-portal-ad-popup .qq1000-ad-popup-img {
    display: block !important; width: 100% !important; margin: 12px 0 0 !important; border-radius: 10px !important;
}
html body #qq1000-portal-ad-popup .qq1000-ad-go {
    width: 100% !important; margin-top: 14px !important; padding: 9px 12px !important; border: 0 !important;
    border-radius: 8px !important; background: #4568f2 !important; color: #fff !important;
    font-size: 14px !important; font-weight: 600 !important; cursor: pointer !important;
}
html body #qq1000-portal-ad-popup .qq1000-ad-close {
    position: absolute !important; top: 8px !important; right: 10px !important; border: 0 !important;
    background: transparent !important; color: #98a2b3 !important; font-size: 18px !important;
    line-height: 1 !important; cursor: pointer !important;
}

/* 客服微信入口已下线：侧栏二维码卡片 + 「联系客服」弹窗一律不显示。 */
html body .uc-qr-card,
html body .uc-qr-header,
html body .uc-qr-img-wrap,
html body .uc-qr-img,
html body .uc-qr-footer,
html body .uc-qr-tip,
html body .uc-qr-link,
html body .uc-qr-placeholder,
html body .kdds-contact-dialog,
html body .kdds-contact-overlay,
html body .kdds-contact-panel,
html body .kdds-contact-qr-wrap,
html body .kdds-contact-hint,
html body .kdds-contact-qr,
html body .kdds-contact-btn {
    display: none !important;
}

/* 邀请好友入口已下线。 */
html body .uc-invite-banner,
html body .uc-invite-body,
html body .uc-invite-icon-wrap,
html body .uc-invite-divider,
html body .uc-invite-link-row {
    display: none !important;
}

/* 选品库里的「免费体验 AI 换图」推广条已下线（同时用插件自己的关闭标记真关掉，
   这里只是兜底：万一组件已经渲染出来，不让它再出现）。 */
html body .pool-ai-intro-banner {
    display: none !important;
}

/* ---------- 面板显示时机 ----------
   不采用「先让插件自己排一遍、再重新排」的做法 —— 那样一定会闪。
   这里从第一帧起就不显示插件原来的工具按钮，只显示脚本重写出来的分组布局：
   按钮在搬进分组容器（加上 qq1000-moved 标记）之前一直是隐藏的。

   注意：面板停靠成横条时根容器是 #gg-top，不是 #cj-goods-side-panel-root，
   所以按钮的隐藏规则**不加容器前缀**，两种形态都覆盖到。
   兜底：脚本里设了 1.5 秒超时，届时无论如何都会撤掉这套隐藏规则。 */
html[data-qq1000-tools-pending] :is(#cj-goods-side-panel-root, #gg-top, .cj-top-bg, .cj-top) .jc-top-btn-text:not(.qq1000-moved),
html[data-qq1000-tools-pending] :is(#cj-goods-side-panel-root, #gg-top, .cj-top-bg, .cj-top) .jc-top-btn-primary:not(.qq1000-moved),
html[data-qq1000-tools-pending] :is(#cj-goods-side-panel-root, #gg-top, .cj-top-bg, .cj-top) .cj-btn-zh-bgfff:not(.qq1000-moved),
html[data-qq1000-tools-pending] :is(#cj-goods-side-panel-root, #gg-top, .cj-top-bg, .cj-top) .cj-btn-shu {
    display: none !important;
}
html body #cj-goods-side-panel-root:not(.qq1000-ready),
html body #gg-top:not(.qq1000-ready) {
    visibility: hidden !important;
}

/* 插件名被截断成「QQ100…」：把标题的截断限制放开，完整显示插件名。 */
html body .plugin-name-text,
html body .kd-dialog-plugin-name,
html body .kd-dialog-site-name {
    max-width: none !important;
    overflow: visible !important;
    text-overflow: clip !important;
    white-space: nowrap !important;
}

/* ---------- 面板排版整理 ----------
   只调「排布」，不碰任何颜色/背景 —— 之前给按钮和统计项加了浅色背景，
   结果插件原本的白字压到浅底上，整片看不清。
   插件把竖线分隔符设成 flex:1;max-width:30px，会吃掉行内空间把按钮推开；
   按钮又是 margin:0 auto 各自居中，间距才忽宽忽窄。 */
html body :is(#cj-goods-side-panel-root, #gg-top, .cj-top-bg, .cj-top) .cj-btn-shu {
    flex: 0 0 auto !important;
    min-width: 0 !important;
    max-width: none !important;
    margin: 0 6px !important;
}
html body :is(#cj-goods-side-panel-root, #gg-top, .cj-top-bg, .cj-top) .jc-top-btn-text,
html body :is(#cj-goods-side-panel-root, #gg-top, .cj-top-bg, .cj-top) .jc-top-btn-primary,
html body :is(#cj-goods-side-panel-root, #gg-top, .cj-top-bg, .cj-top) .cj-btn-zh-bgfff,
html body :is(#cj-goods-side-panel-root, #gg-top, .cj-top-bg, .cj-top) .jc-top-view-text {
    flex: 0 0 auto !important;
    margin: 0 !important;
    white-space: nowrap !important;
}
/* 只作用于插件面板内部，避免影响站内弹窗的排版 */
html body #cj-goods-side-panel-root .gg-flex,
html body .cj-top .gg-flex,
html body .cj-top-bg .gg-flex {
    gap: 8px !important;
    flex-wrap: wrap !important;
    align-items: center !important;
}

/* ---------- 按工具名分组后的容器（同样只用排布，不上色） ---------- */
html body .qq1000-tools {
    display: flex !important;
    flex-wrap: wrap !important;
    align-items: center !important;
    gap: 10px !important;
    padding: 6px 8px !important;
}
html body .qq1000-tools-group {
    display: flex !important;
    align-items: center !important;
    gap: 6px !important;
    padding: 0 8px 0 6px !important;
    border-left: 2px solid #409eff !important;
}
html body .qq1000-tools-title {
    font-size: 12px !important;
    font-weight: 600 !important;
    white-space: nowrap !important;
}
html body .qq1000-tools-row {
    display: flex !important;
    align-items: center !important;
    gap: 6px !important;
    flex-wrap: wrap !important;
}
html body .qq1000-tools-row .cj-btn-shu {
    display: none !important;
}
`;
        (document.head || document.documentElement).appendChild(style);
    }

    function openAd(event) {
        event.preventDefault();
        event.stopImmediatePropagation();
        const anchor = document.createElement("a");
        anchor.href = adConfig.url;
        anchor.target = "_blank";
        anchor.rel = "noopener noreferrer";
        anchor.style.display = "none";
        (document.body || document.documentElement).appendChild(anchor);
        anchor.click();
        anchor.remove();
    }

    function openAdFromKeyboard(event) {
        if (event.key !== "Enter" && event.key !== " ") return;
        openAd(event);
    }

    function applyAd(entry) {
        const title = entry.querySelector(".menu-title");
        const subtitle = entry.querySelector(".cj-xingtu-sub");
        if (title && title.textContent !== adConfig.label) title.textContent = adConfig.label;
        if (subtitle && subtitle.textContent !== adConfig.subtitle) subtitle.textContent = adConfig.subtitle;
        entry.setAttribute("data-qq1000-ai-url", adConfig.url);
        entry.setAttribute("title", "打开 " + adConfig.label);
        entry.setAttribute("aria-label", "打开 " + adConfig.label);
        entry.setAttribute("role", "link");
        entry.setAttribute("tabindex", "0");
        if (entry.dataset.qq1000AiBound === "1") return;
        entry.dataset.qq1000AiBound = "1";
        entry.addEventListener("click", openAd, true);
        entry.addEventListener("keydown", openAdFromKeyboard, true);
    }

    function normalizeText(value) {
        return String(value || "").replace(/\s+/g, "").trim();
    }

    function removeNode(node) {
        if (!node || typeof node.remove !== "function") return false;
        node.remove();
        return true;
    }

    function removePanelMenuEntries(panel) {
        panel.querySelectorAll(".cj-gm-entry").forEach(entry => {
            const title = entry.querySelector(".menu-title");
            const label = normalizeText(title ? title.textContent : entry.textContent);
            if (REMOVED_ITEM_LABELS.has(label)) removeNode(entry);
        });
    }

    function hasClass(element, className) {
        return !!element && !!element.classList && element.classList.contains(className);
    }

    function findRemovalTarget(element, root) {
        let current = element;
        while (current && current !== root) {
            if (
                hasClass(current, "cj-gm-entry") ||
                hasClass(current, "h-00-col2-text") ||
                hasClass(current, "cj-kf-container") ||
                hasClass(current, "kd-dialog-service-container") ||
                hasClass(current, "lm2-feat") ||
                hasClass(current, "el-button") ||
                current.tagName === "BUTTON" ||
                current.tagName === "A" ||
                current.tagName === "LI"
            ) return current;
            current = current.parentElement;
        }
        return element;
    }

    function findAncestorByClass(element, className) {
        let current = element;
        while (current) {
            if (hasClass(current, className)) return current;
            current = current.parentElement;
        }
        return null;
    }

    function removeExactItemsFromRoot(root) {
        if (!root || typeof root.querySelectorAll !== "function") return;
        root.querySelectorAll("*").forEach(element => {
            if (!element.parentElement) return;
            const label = normalizeText(element.textContent);
            if (!REMOVED_ITEM_LABELS.has(label) && label !== "客服" && label !== "联系客服") return;
            removeNode(findRemovalTarget(element, root));
        });
    }

    // 这几个功能（及其子项）在下线范围内，直接在页面上真实移除。
    // 不在插件 bundle 里删节点：那样会在运行时踩到 $refs / DOM 查询，
    // 整个面板会渲染失败（试过，面板直接加载不出来），所以放在这里按标签摘节点。
    const REMOVED_FEATURE_LABELS = new Set(["商品信息", "淘客查询", "查词分析", "聚划算"]);
    const REMOVED_ROW_LABELS = [
        "类目：", "SKU数：", "已售：", "销售额约：", "收藏：", "评价：", "问大家：",
        "月销量：", "月付款：", "月收货：", "点击查询",
        "搜索词分析", "关键词分析", "长尾词销量",
        "淘客信息", "佣金比例：", "30天推广量：", "30天支出佣金："
    ];
    // 只认插件自己的这几类容器，避免误删弹窗里的同名文案（例如下载弹窗里的「商品信息」复选框）
    const FEATURE_CONTAINER_CLASSES = [
        "jc-top-btn-primary",
        "jc-top-btn-text",
        "jc-top-view-text",
        "cj-tkcx-view",
        "cj-gm-entry"
    ];

    function closestFeatureContainer(element) {
        let current = element;
        while (current && current !== document.body) {
            if (FEATURE_CONTAINER_CLASSES.some(className => hasClass(current, className))) return current;
            current = current.parentElement;
        }
        return null;
    }

    // ---------- 按工具名把功能按钮重新归类 ----------
    // 插件把这些按钮铺在几行里，靠竖线分隔符撑开，既乱又难找。
    // 这里按工具类别收进带标题的分组卡片，并保持行内间距一致。
    const TOOL_GROUPS = [
        { title: "商品", labels: ["复制SKU", "SKU预览", "SKU图预览", "生成网页二维码", "宝贝卡首屏", "利润计算", "违规词检测", "SKU详细数据", "初始化设置", "复制标题", "复制图片", "复制链接", "复制表格", "车图下载", "主图下载"] },
        { title: "评论", labels: ["评论分析", "问大家分析", "评论透视", "买家秀下载"] },
        { title: "数据", labels: ["万相台", "市场分析", "查词分析", "搜索词分析", "关键词分析", "长尾词销量", "全店透视", "词根搜索", "数据汇总", "详情数据", "市场分析结果"] },
        { title: "下载", labels: ["信息下载", "PC图集下载", "手机图集下载", "车图下载", "下载全部", "下载主图&主视频", "下载SKU图", "下载详情图片", "导出数据", "商品下载", "下载主图", "导出Excel", "导出CSV", "导出文本", "导出表格", "下载评论", "下载图片"] },
        { title: "店铺", labels: ["店铺分析", "全店导出", "诊断工具", "店铺上新", "批量查询", "历史记录", "搜相似同款", "店铺诊断", "官方公告"] },
        { title: "选品", labels: ["选品", "选品池", "商品库", "关注店铺", "收藏", "相似同款"] }
    ];
    const TOOL_BUTTON_CLASSES = ["jc-top-btn-primary", "jc-top-btn-text", "cj-btn-zh-bgfff"];
    const TOOLS_ATTR = "data-qq1000-tools";

    function toolLabelOf(element) {
        // 去掉尾部箭头/装饰后再比较
        return normalizeText(element.textContent).replace(/[▾▴▼▲\s]+$/g, "");
    }

    // 面板根节点在一次整理里会被反复用到（分组、清理、兜底），而每次都要查若干次 DOM。
    // 100ms 内复用同一份结果：既避免同一帧重复查询，也不会因为缓存太久而读到已被移除的节点。
    let toolRootsCache = { at: 0, roots: [] };
    function toolRoots() {
        const now = Date.now();
        if (now - toolRootsCache.at < 100 && toolRootsCache.roots.length) return toolRootsCache.roots;
        const roots = [];
        const panel = document.getElementById(PANEL_ID);
        if (panel) roots.push(panel);
        // #gg-top 是面板停靠成横条时的根容器（此时没有 #cj-goods-side-panel-root），
        // 两种形态都要能收到按钮，否则横条模式下分组会「什么都找不到」。
        const dock = document.getElementById("gg-top");
        if (dock) roots.push(dock);
        [".cj-top-bg", ".cj-top"].forEach(selector => {
            document.querySelectorAll(selector).forEach(node => roots.push(node));
        });
        toolRootsCache = { at: now, roots: roots };
        return roots;
    }

    // 两种形态的根容器（可能同时存在，也可能只有其中一个）
    function panelContainers() {
        return [document.getElementById(PANEL_ID), document.getElementById("gg-top")].filter(Boolean);
    }

    function markPanelsReady() {
        panelContainers().forEach(node => node.classList.add("qq1000-ready"));
    }

    // 下拉类按钮（PC图集下载 / 手机图集下载 / 复制标题 ▾ / 诊断工具 ▾ …）的弹层挂在
    // el-dropdown 容器里。只搬按钮本体的话弹层会留在原位，展开时就错位到别处，
    // 所以这里往上找到承载弹层的容器，整块搬。
    function toolMoveTarget(button) {
        let node = button;
        let current = button.parentElement;
        let depth = 0;
        while (current && current !== document.body && depth < 3) {
            const className = String(current.className || "");
            if (/el-dropdown|dropdown-wrapper|shop-export-wrapper/.test(className)) {
                node = current;
                current = current.parentElement;
                depth += 1;
                continue;
            }
            break;
        }
        return node;
    }

    // 只处理顶栏工具区里的按钮：面板还有「可拖拽浮动面板」这种形态，
    // 里面是采集入口/下载工具这类菜单，不能被分类逻辑搬走、也不能被清理规则删掉。
    function inToolbarRegion(element) {
        return !!(element.closest && (element.closest(".h-00") || element.closest(".cj-top-bg")));
    }

    function collectToolButtons() {
        // 同一个工具名在面板里可能出现多次（不同组件各渲染一处），必须全部收走：
        // 只搬第一处的话，剩下的会孤零零留在原行里，看着就是错位。
        const found = [];
        const seen = new Set();
        toolRoots().forEach(root => {
            TOOL_BUTTON_CLASSES.forEach(className => {
                root.querySelectorAll("." + className).forEach(button => {
                    if (seen.has(button)) return;
                    if (button.closest("[" + TOOLS_ATTR + "]")) return;
                    if (!inToolbarRegion(button)) return;
                    const label = toolLabelOf(button);
                    if (!label || label.length > 14) return;
                    seen.add(button);
                    found.push({ label: label, element: toolMoveTarget(button) });
                });
            });
        });
        return found;
    }

    function buildToolGroups() {
        const existing = document.querySelector("[" + TOOLS_ATTR + "]");
        const fresh = collectToolButtons();
        // 已经分好类、且外面没有新按钮了 -> 不重复构建（避免每次观察器触发都重排）
        if (existing && !fresh.length) return false;

        // 重建时把旧容器里的按钮一起收回来，否则它们会随旧容器被删掉
        const items = [];
        const seen = new Set();
        if (existing) {
            // 重建时按「分组行里的直接子节点」回收：它可能是按钮本体，也可能是
            // 带着弹层的 el-dropdown 容器，两种都要原样搬回去，弹层才不会丢。
            existing.querySelectorAll(".qq1000-tools-row").forEach(row => {
                Array.from(row.children).forEach(node => {
                    if (seen.has(node)) return;
                    const chip = TOOL_BUTTON_CLASSES.some(className => hasClass(node, className))
                        ? node
                        : node.querySelector("." + TOOL_BUTTON_CLASSES.join(", ."));
                    const label = toolLabelOf(chip || node);
                    if (!label) return;
                    seen.add(node);
                    items.push({ label: label, element: node });
                });
            });
        }
        fresh.forEach(item => {
            if (seen.has(item.element)) return;
            seen.add(item.element);
            items.push(item);
        });
        if (items.length < 4) return false;
        if (existing) removeNode(existing);

        const buckets = TOOL_GROUPS.map(group => ({ title: group.title, nodes: [] }));
        const others = { title: "其它", nodes: [] };
        items.forEach(item => {
            const hit = TOOL_GROUPS.find(group => group.labels.some(name => item.label === name || item.label.startsWith(name)));
            (hit ? buckets.find(bucket => bucket.title === hit.title) : others).nodes.push(item.element);
        });
        const used = buckets.filter(bucket => bucket.nodes.length);
        if (others.nodes.length) used.push(others);
        if (!used.length) return false;

        const container = document.createElement("div");
        container.className = "qq1000-tools";
        container.setAttribute(TOOLS_ATTR, "1");
        used.forEach(bucket => {
            const group = document.createElement("div");
            group.className = "qq1000-tools-group";
            const title = document.createElement("span");
            title.className = "qq1000-tools-title";
            title.textContent = bucket.title;
            const row = document.createElement("div");
            row.className = "qq1000-tools-row";
            bucket.nodes.forEach(node => {
                // 打上标记，CSS 才会让它显示（未搬迁的按钮一直是隐藏的，避免闪旧排版）；
                // 搬进来的可能是 el-dropdown 容器，里面的按钮本体也要一起标记。
                node.classList.add("qq1000-moved");
                node.querySelectorAll("." + TOOL_BUTTON_CLASSES.join(", .")).forEach(chip => {
                    chip.classList.add("qq1000-moved");
                });
                row.appendChild(node);
            });
            group.appendChild(title);
            group.appendChild(row);
            container.appendChild(group);
        });

        // 挂到顶栏下方
        const anchor = document.querySelector(".cj-top .h-00") || document.querySelector(".cj-top") ||
            document.getElementById(PANEL_ID);
        if (!anchor) return false;
        if (anchor.classList && anchor.classList.contains("h-00")) {
            anchor.insertAdjacentElement("afterend", container);
        } else {
            anchor.insertAdjacentElement("afterbegin", container);
        }

        // 原来的行如果已经空了就一起收掉，避免留下空白条
        items.forEach(item => {
            const parent = item.element.parentElement;
            if (!parent || parent.closest("[" + TOOLS_ATTR + "]")) return;
            const stillHasButton = TOOL_BUTTON_CLASSES.some(className => parent.querySelector("." + className));
            if (stillHasButton) return;
            // 按钮搬走后，原来夹在中间当分隔符的竖线会孤零零留着，一并清掉
            parent.querySelectorAll(".cj-btn-shu").forEach(removeNode);
            if (!hasVisibleText(parent)) removeNode(parent);
        });
        cleanupSeparatorOnlyRows();
        // 分组完成，撤掉「隐藏原始按钮」的标记：万一还有后到的按钮，直接显示在原位，
        // 下一轮 DOM 变动会把它补收进分组，而不是让它一直不可见。
        document.documentElement.removeAttribute("data-qq1000-tools-pending");
        return true;
    }

    // 只剩分隔符/空白/标点的行，判定为「没有内容」
    function hasVisibleText(element) {
        return normalizeText(element.textContent).replace(/[|\s·•・\-—–_]+/g, "") !== "";
    }

    // 按钮被搬走后，原行里常剩下孤立的竖线分隔符，或者整行只剩分隔符 —— 全部收掉。
    // 这些行跟分类无关，是插件用 cj-btn-shu 当视觉分隔留下的壳。
    function cleanupSeparatorOnlyRows() {
        toolRoots().forEach(root => {
            root.querySelectorAll(".cj-btn-shu").forEach(separator => {
                const row = separator.parentElement;
                if (!row || row.closest("[" + TOOLS_ATTR + "]")) return;
                const hasButton = TOOL_BUTTON_CLASSES.some(className => row.querySelector("." + className));
                if (!hasButton && !hasVisibleText(row)) removeNode(row);
                else if (!hasButton) removeNode(separator);
            });
            root.querySelectorAll("div").forEach(row => {
                if (row.closest("[" + TOOLS_ATTR + "]") || !row.parentElement) return;
                if (row.querySelector("." + TOOL_BUTTON_CLASSES.join(", ."))) return;
                if (row.children.length > 6) return;
                if (!hasVisibleText(row)) removeNode(row);
            });
        });
    }

    /**
     * 面板刚挂载时的同步整理：先分类重排、摘掉要下线的条目，再放开显示。
     * 必须在「浏览器绘制之前」跑 —— MutationObserver 回调满足这个时机，
     * 所以这里也会被观察器直接调用。
     */
    function syncPanelMount() {
        const containers = panelContainers();
        if (!containers.length) return;
        if (!containers.some(node => !node.classList.contains("qq1000-ready"))) return;
        let grouped = false;
        try {
            installStyle();
            removeFeaturesByLabel();
            grouped = buildToolGroups() === true;
        } catch (error) {
        }
        if (grouped) {
            markPanelsReady();
            return;
        }
        // 分组没成功（比如这个面板里压根没有可分类的工具按钮，或者按钮还没渲染出来）
        // 也必须把面板显示出来 —— 否则它会一直停在「不可见」状态，看起来就是面板消失了。
        // 给一个很短的延迟，兼顾「按钮稍后才到」的情况。
        setTimeout(markPanelsReady, 250);
    }

    // 「商品信息」那些统计格 + 指定的工具按钮，彻底移除。
    // 关键：不能等 800ms 的节流循环（Vue 重新渲染后它们会短暂出现），
    // 必须在 DOM 变动回调里立刻摘掉 —— 那个回调发生在浏览器绘制之前，
    // 所以这些节点一次都不会被画出来。
    const REMOVED_STAT_LABELS = ["类目：", "SKU数：", "已售：", "销售额约：", "收藏：", "评价：",
        "问大家：", "月销量：", "月付款：", "月收货：", "点击查询"];
    // 按文字内容匹配，不依赖容器类名 —— 面板在侧栏形态和横条形态下用的类名不一样，
    // 之前只查 .jc-top-view-text，结果横条形态一个都没匹配到。
    // 冒号全角半角都认；「收藏店铺」这种没有冒号的不会误伤。
    const REMOVED_STAT_PATTERN = /^(类目|SKU数|已售|销售额约|收藏|评价|问大家|月销量|月付款|月收货)\s*[:：]/;
    const REMOVED_TOOL_LABELS = ["宝贝卡首屏", "利润计算", "生成网页二维码"];
    const TOOL_NODE_SELECTOR = ".jc-top-view-text, .jc-top-btn-text, .jc-top-btn-primary, .cj-btn-zh-bgfff";

    function matchesRemovedStat(text) {
        if (!text) return false;
        if (REMOVED_STAT_PATTERN.test(text)) return true;
        return text === "点击查询";
    }

    // 标签是格子 <span> 里的**直接文本节点**（后面紧跟一个装图标/数值的 <span>），
    // 所以必须看元素自身的直接文本，而不是 textContent（后者会被子元素影响）。
    function directTextOf(element) {
        let text = "";
        Array.from(element.childNodes || []).forEach(child => {
            if (child.nodeType === 3) text += child.nodeValue;
        });
        return normalizeText(text);
    }

    // 整块内容是否「除了要移除的标签之外没有别的中文」：
    // 用来判断往外走的那一层还是不是一个纯统计块（避免连带删掉旁边的功能按钮）。
    const STAT_LABEL_WORDS = /(类目|SKU数|已售|销售额约|收藏|评价|问大家|月销量|月付款|月收货|点击查询)/g;
    function statBlockOnly(text) {
        if (!matchesRemovedStat(text)) return false;
        const rest = String(text).replace(STAT_LABEL_WORDS, "");
        return !/[\u4e00-\u9fff]/.test(rest);
    }

    // 从命中的标签往外找到最大的「纯统计块」：整块文本去掉已知标签后没有其它中文。
    // 这样无论插件用什么类名包这些格子，都能整块移除，而不会连带删掉工具按钮。
    function statCellOf(node, root) {
        let target = node;
        let current = node.parentElement;
        let depth = 0;
        while (current && current !== root && depth < 4) {
            const text = normalizeText(current.textContent);
            if (!text || text.length > 300) break;
            if (!statBlockOnly(text)) break;
            if (current.querySelector("." + TOOL_BUTTON_CLASSES.join(", ."))) break;
            target = current;
            current = current.parentElement;
            depth += 1;
        }
        return target;
    }

    // scope：只在这个子树里找（DOM 变动回调里传新增节点，避免每次变动都全量扫面板）。
    function purgeRemovedNodes(scope) {
        const roots = scope ? [scope] : toolRoots();
        roots.forEach(root => {
            if (!root || typeof root.querySelectorAll !== "function") return;
            // 统计格：按元素自身的直接文本定位（类名、子元素都不可靠）
            root.querySelectorAll("div, span, p, td, li").forEach(node => {
                if (!node.parentElement || node.closest("[" + TOOLS_ATTR + "]")) return;
                if (!matchesRemovedStat(directTextOf(node))) return;
                removeNode(statCellOf(node, root));
            });
            // 没有任何文字的按钮壳：插件的图标字体/占位图没渲染出来时，页面上就是一块空白色块，
            // 留着只会让人以为是坏掉的图标，这里直接移除（有文字的按钮不受影响）。
            TOOL_BUTTON_CLASSES.forEach(className => {
                root.querySelectorAll("." + className).forEach(button => {
                    if (!inToolbarRegion(button)) return;
                    const label = toolLabelOf(button);
                    if (!label) {
                        removeNode(toolMoveTarget(button));
                        return;
                    }
                    if (!REMOVED_TOOL_LABELS.includes(label)) return;
                    // 下拉类按钮要连弹层容器一起摘，否则会留下一个空壳
                    removeNode(toolMoveTarget(button));
                });
            });
        });
    }

    // 只有这次 DOM 变动真的碰到了面板自己的节点才去扫描，避免高频回调下反复全量查询。
    // 插件类名前缀也认：统计格的类名和工具按钮不同，只按按钮类判会漏掉它们。
    function mutationTouchesTools(mutations) {
        const pluginNode = /^(cj-|jc-|gg-|h-00|qq1000-)/;
        return mutations.some(mutation => Array.from(mutation.addedNodes || []).some(node => {
            if (!node || node.nodeType !== 1) return false;
            if (node.matches && node.matches(TOOL_NODE_SELECTOR)) return true;
            if (pluginNode.test(String(node.className || ""))) return true;
            return !!(node.querySelector && node.querySelector(TOOL_NODE_SELECTOR));
        }));
    }

    // 兜底：两种形态下面板容器的 id / 类名不一样，万一上面的范围没覆盖到，
    // 就在全文档里按「插件自己的类名前缀 + 文案匹配」再扫一遍。
    // 只在节流过的常规整理路径里跑，避免高频回调下全量扫描拖慢页面。
    function purgeStatLabelsAnywhere() {
        const pluginOwned = /^(cj-|jc-|gg-|qq1000-|h-00|plugin-name)/;
        document.querySelectorAll("div, span").forEach(node => {
            if (!node.parentElement) return;
            if (!matchesRemovedStat(directTextOf(node))) return;
            let cursor = node;
            let owned = false;
            let depth = 0;
            while (cursor && depth < 4) {
                if (pluginOwned.test(String(cursor.className || ""))) {
                    owned = true;
                    break;
                }
                cursor = cursor.parentElement;
                depth += 1;
            }
            if (owned) removeNode(statCellOf(node, document.body));
        });
    }

    function removeFeaturesByLabel() {
        const roots = [];        const panel = document.getElementById(PANEL_ID);
        if (panel) roots.push(panel);
        [".cj-top-bg", ".cj-top", ".h-00"].forEach(selector => {
            document.querySelectorAll(selector).forEach(node => roots.push(node));
        });
        roots.forEach(root => {
            root.querySelectorAll("div, span, li, a, button").forEach(element => {
                if (!element.parentElement) return;
                const label = normalizeText(element.textContent);
                if (!label || label.length > 40) return;
                const matched = REMOVED_FEATURE_LABELS.has(label) ||
                    REMOVED_ROW_LABELS.some(item => label === item || label.startsWith(item));
                if (!matched) return;
                const target = closestFeatureContainer(element);
                if (target) removeNode(target);
            });
        });
    }

    function removeCustomerServiceUi() {
        [
            ".cj-kf-container",
            ".cj-kf-qr-dropdown",
            ".kd-dialog-service-container",
            ".kd-service-qrcode-dropdown",
            ".uc-qr-card",
            "#kdds-contact-btn",
            "#kdds-contact-dialog"
        ].forEach(selector => {
            document.querySelectorAll(selector).forEach(removeNode);
        });

        document.querySelectorAll(".el-dialog__wrapper").forEach(wrapper => {
            const title = wrapper.querySelector(".el-dialog__title");
            const hasCustomerQr = Array.from(wrapper.querySelectorAll("img")).some(image =>
                /客服二维码/.test(String(image.getAttribute("alt") || ""))
            );
            if (normalizeText(title && title.textContent) !== "联系客服" || !hasCustomerQr) return;
            const closeButton = Array.from(wrapper.querySelectorAll("button")).find(button =>
                normalizeText(button.getAttribute("title")) === "关闭" || hasClass(button, "el-dialog__headerbtn")
            );
            if (closeButton && closeButton.dataset.qq1000CloseTriggered !== "1") {
                closeButton.dataset.qq1000CloseTriggered = "1";
                try { closeButton.click(); } catch (error) {}
            }
            setTimeout(() => removeNode(wrapper), 0);
        });

        document.querySelectorAll(".cj-wg-overlay").forEach(overlay => {
            const closeButton = overlay.querySelector(".cj-wg-close");
            if (closeButton && closeButton.dataset.qq1000CloseTriggered !== "1") {
                closeButton.dataset.qq1000CloseTriggered = "1";
                try { closeButton.click(); } catch (error) {}
            }
            setTimeout(() => removeNode(overlay), 0);
        });

        [".select-catery-user", ".download-user-info", ".update-popup-dialog-custom"].forEach(selector => {
            document.querySelectorAll(selector).forEach(scope => {
                scope.querySelectorAll("button").forEach(button => {
                    if (normalizeText(button.textContent) === "联系客服") removeNode(button);
                });
            });
        });
    }

    /**
     * 顶栏左上角必须显示「插件标题 + 官网地址」。
     * 插件那边这块写的是 `agentUrl ? <a>标题</a> : 什么都不渲染`，只要配置还没回来、
     * agentUrl 一时为空（或标题字段为空），标题就整块消失。
     * 这里做兜底补齐：已经是空的标题补文案，整块没渲染就自己补一个。
     * （常量写在这里而不是引用下面的 OFFICIAL_SITE，避免执行顺序上踩到 const 的暂时性死区。）
     */
    function ensurePanelTitle() {
        // 顶栏左上的容器在两种形态（侧栏 / 停靠横条）里挂载点不同，逐个尝试。
        const col1 = document.querySelector(".h-00-col1") ||
            document.querySelector("#gg-top .h-00-col1") ||
            document.querySelector(".cj-top .h-00-col1");
        if (!col1) return;
        // 标题一律用扩展本地的品牌名，不依赖在线配置（在线配置没回来时插件整块不渲染）。
        const existing = col1.querySelector(".plugin-name-text");
        if (existing) {
            if (normalizeText(existing.textContent) !== "QQ1000电商") existing.textContent = "QQ1000电商";
            return;
        }
        const link = document.createElement("a");
        link.href = "https://tu.qq1000.com";
        link.target = "_blank";
        link.setAttribute("rel", "noreferrer");
        link.style.cssText = "text-decoration:none;display:flex;align-items:center;gap:8px;margin-left:10px;";
        const title = document.createElement("span");
        title.className = "plugin-name-text";
        title.style.cssText = "font-weight:600;font-size:14px;white-space:nowrap;";
        title.textContent = "QQ1000电商";
        link.appendChild(title);
        // 标签里已经有网址（插件自己渲染的）时就不再补一遍，避免重复。
        if (!normalizeText(col1.textContent).includes("tu.qq1000.com")) {
            const url = document.createElement("span");
            url.style.cssText = "font-size:12px;white-space:nowrap;";
            url.textContent = "tu.qq1000.com";
            link.appendChild(url);
        }
        col1.appendChild(link);
    }

    /**
     * 所有「下线/清理」规则的唯一入口，顺序固定：
     *   1. purgeRemovedNodes —— 面板范围内的统计格、空壳按钮、指定工具按钮
     *   2. purgeStatLabelsAnywhere —— 全文档兜底（类名前缀归属插件才算），10 秒最多一次
     *   3. removeFeaturesByLabel —— 指定功能及其子功能行
     * 说明：这三步各自只扫一遍、范围很小，合并成一次遍历收益有限、却容易改出行为差异，
     * 所以这里只统一入口与顺序，避免散落在多处调用导致漏调/重复调。
     */
    // 插件在若干按钮上挂「NEW」角标（绝对定位）。按钮被归类搬走后角标会留在原位，
    // 就成了飘在别处的红色小方块；这些角标没有信息量，直接移除。
    function purgeNewBadges() {
        toolRoots().forEach(root => {
            root.querySelectorAll('[class*="new"], [class*="New"], [class*="badge"], [class*="Badge"], .el-badge__content').forEach(node => {
                if (!node.parentElement) return;
                const text = normalizeText(directTextOf(node)).toUpperCase();
                if (text !== "NEW" && text !== "HOT") return;
                removeNode(node);
            });
        });
    }

    // 插件内置的顶部广告条目与后台配置无关：一律先清掉（不依赖是否登录、是否抓到配置），
    // 后台配置的广告由 renderPanelAdBar 渲染并带 data-qq1000-ad-rendered 标记，不会被误清。
    function stripBuiltinAdBar() {
        document.querySelectorAll(".h-00-col2-text.gg-text-xhx").forEach(node => {
            if (node.closest("[data-qq1000-ad-rendered]")) return;
            removeNode(node);
        });
        const bar = document.querySelector(".h-00-col2");
        if (!bar) return;
        if (bar.querySelector(".h-00-col2-text.gg-text-xhx")) return;
        if (normalizeText(bar.textContent)) return;
        bar.style.display = "none";   // 没有内容就别留一条空白蓝条
    }

    function applyRemovals() {
        purgeNewBadges();
        stripBuiltinAdBar();
        purgeRemovedNodes();
        const now = Date.now();
        if (now - lastAnywherePurgeAt > 10000) {
            lastAnywherePurgeAt = now;
            purgeStatLabelsAnywhere();
        }
        removeFeaturesByLabel();
    }

    function removeUnwantedPluginUi(panel) {
        if (panel) removePanelMenuEntries(panel);
        ensurePanelTitle();
        applyRemovals();
        buildToolGroups();
        // 顶部广告栏（.h-00-col2 / #gg-top，内容 资源推荐、1元礼品代发、真实快递代发、
        // 查降权旺旺号…）由后台配置，用户要求在面板上原样展示，这里不再整栏移除。
        document.querySelectorAll(".lm2-feat-title").forEach(title => {
            const label = normalizeText(title.textContent);
            if (label !== "礼品代发" && label !== "查降权号" && label !== "查降权旺旺号") return;
            removeNode(findAncestorByClass(title, "lm2-feat") || title);
        });
        removeCustomerServiceUi();

        const roots = [];
        if (panel) roots.push(panel);
        [".plugin-wrapper", ".kd-dialog", ".download-user-info"].forEach(selector => {
            document.querySelectorAll(selector).forEach(root => roots.push(root));
        });
        Array.from(new Set(roots)).forEach(removeExactItemsFromRoot);
    }

    function requestBuyerShowPatchRefresh() {
        try {
            if (typeof document.dispatchEvent !== "function" || typeof CustomEvent !== "function") return;
            document.dispatchEvent(new CustomEvent(BUYER_SHOW_PATCH_EVENT, { bubbles: true, composed: true }));
        } catch (error) {}
    }

    function markBuyerShowDownloadMenus() {
        document.querySelectorAll(".el-dropdown-menu").forEach(menu => {
            const text = normalizeText(menu.textContent);
            if (!text.includes("多文件夹下载") || !text.includes("单文件夹下载")) return;
            menu.classList.add("qq1000-buyershow-download-menu");
            menu.style.setProperty("z-index", "2147483646", "important");
            menu.querySelectorAll(".el-dropdown-menu__item").forEach(item => {
                if (item.dataset.qq1000BuyerShowBound === "1") return;
                item.dataset.qq1000BuyerShowBound = "1";
                item.addEventListener("click", requestBuyerShowPatchRefresh, true);
            });
        });
    }

    function bindBuyerShowBatchButtons() {
        document.querySelectorAll(".buyer-show-dialog").forEach(dialog => {
            dialog.querySelectorAll("button").forEach(button => {
                const label = normalizeText(button.textContent);
                if (!["批量下载", "下载单文档评论", "下载", "开始下载"].includes(label)) return;
                if (button.dataset.qq1000BuyerShowBound === "1") return;
                button.dataset.qq1000BuyerShowBound = "1";
                button.addEventListener("click", () => {
                    requestBuyerShowPatchRefresh();
                    scheduleApply();
                    setTimeout(scheduleApply, 80);
                    setTimeout(scheduleApply, 240);
                }, true);
            });
        });
    }

    function applyBuyerShowUiFixes() {
        bindBuyerShowBatchButtons();
        markBuyerShowDownloadMenus();
    }

    const OFFICIAL_SITE = "https://tu.qq1000.com";
    // 插件顶栏标题的兜底值（正常应由 tools/config/new2025 的 pluginName 下发）。
    const PLUGIN_BRAND_NAME = "QQ1000电商";
    // 用户中心里要下线的 Tab（按文案匹配，避免企业子账号被 visibleTabs 过滤后序号错位）。
    // 「功能导航」**不能删**：那里面是打开商品搬家 / 淘宝详情分析 / 生意参谋助手 /
    // 直通车助手这些功能面板的入口卡片，删掉 Tab 就等于把这些功能整个藏起来。
    const HIDDEN_TAB_LABELS = ["会员订购"];

    /**
     * 把要下线的 Tab **直接从 DOM 移除**（不是 display:none 隐藏）。
     * 面板由 v-if 控制，Tab 按钮没了就永远进不去，里面的内容自然也不会出现。
     * 按文案匹配而不是按 :nth-child —— 企业子账号会被 visibleTabs 过滤掉 membership，
     * 序号整体前移，按序号删会误伤「更新记录」。
     */
    function removeUnwantedTabs() {
        document.querySelectorAll(".uc-tab-btn").forEach(button => {
            const label = normalizeText(button.textContent);
            if (!HIDDEN_TAB_LABELS.some(name => label.includes(name))) return;
            // 万一当前正停在这个 Tab 上，先把面板切到第一个保留的 Tab，避免白屏。
            const bar = button.parentNode;
            if (bar && button.classList.contains("active")) {
                const fallback = Array.from(bar.children).find(
                    item => item !== button && item.classList && item.classList.contains("uc-tab-btn")
                );
                if (fallback) fallback.click();
            }
            button.remove();
        });
    }

    /**
     * 「常用操作」四个按钮统一跳官网首页 https://tu.qq1000.com。
     * （原本跳 ``officialWebsite + 子路径``，而 officialWebsite 兜底值是 "1.com"。）
     *
     * 注意：**必须挂在 document 的捕获阶段**。Vue 的 click 是注册在元素自己身上的，
     * 同一元素上的监听器按注册顺序执行 —— 我们在 Vue 之后注册，抢不到先手，
     * stopImmediatePropagation 拦不住它，会先弹出厂商链接再弹我们的。
     * 挂到 document 捕获才能在事件到达按钮之前截胡。
     */
    function bindQuickActions() {
        if (document.documentElement.dataset.qq1000QuickBound === "1") return;
        document.documentElement.dataset.qq1000QuickBound = "1";
        document.addEventListener("click", event => {
            const target = event.target;
            const item = target && target.closest ? target.closest(".uc-quick-item") : null;
            if (!item) return;
            event.preventDefault();
            event.stopPropagation();
            event.stopImmediatePropagation();
            const anchor = document.createElement("a");
            anchor.href = OFFICIAL_SITE;
            anchor.target = "_blank";
            anchor.rel = "noopener noreferrer";
            anchor.style.display = "none";
            (document.body || document.documentElement).appendChild(anchor);
            anchor.click();
            anchor.remove();
        }, true);
    }

    /**
     * 插件把 appConfig（含官网地址 / 插件标题 / logo）缓存在 localStorage
     * （`cj_app_config_2025`）里，缓存 30 分钟，兜底值还是 "1.com" / 空字符串。
     * 这里纠正成本站域名，并把标题与 logo 补齐 —— 不用等缓存过期就能生效。
     */
    // 上次写回缓存的内容：整理流程每 800ms 跑一次，加个签名短路，
    // 没变化就不再解析/序列化那一大坨 JSON。
    let lastAppConfigSignature = "";
    function patchAppConfigCache() {
        try {
            const raw = window.localStorage.getItem("cj_app_config_2025");
            if (!raw || raw === lastAppConfigSignature) return;
            const parsed = JSON.parse(raw);
            const envelope = parsed && parsed.data;
            if (!envelope || typeof envelope !== "object") return;
            // 缓存有两层：parsed.data 是接口信封 {state,code,msg,data}，
            // 真正的业务字段在 envelope.data 里（没有信封时退化到同一层）。
            const payload = (envelope.data && typeof envelope.data === "object") ? envelope.data : envelope;
            let touched = false;
            const current = String(payload.agentUrl || payload.agent_url || payload.website_url || "");
            if (!(current.startsWith("http") && current.includes("qq1000.com"))) {
                payload.agentUrl = OFFICIAL_SITE;
                payload.agent_url = OFFICIAL_SITE;
                payload.website_url = OFFICIAL_SITE;
                touched = true;
            }
            // 顶栏标题为空/是插件默认值时补上（否则顶栏左上是空的）。
            const name = String(payload.pluginName || "").trim();
            if (!name || name === "插件工具" || name === "电商工具") {
                payload.pluginName = PLUGIN_BRAND_NAME;
                if (!String(payload.titleName || "").trim()) payload.titleName = PLUGIN_BRAND_NAME;
                touched = true;
            }
            if (touched) {
                const next = JSON.stringify(parsed);
                lastAppConfigSignature = next;
                window.localStorage.setItem("cj_app_config_2025", next);
            } else {
                // 内容本来就合规：记下签名，下次直接跳过解析
                lastAppConfigSignature = raw;
            }
        } catch (error) {}
    }

    function applyOverrides() {
        applyTimer = null;
        const panel = document.getElementById(PANEL_ID);
        const buyerShowDialog = document.querySelector(".buyer-show-dialog");
        removeUnwantedPluginUi(panel);
        if (panel || buyerShowDialog) installStyle();
        if (panel) {
            loadOnlinePortalConfig();
            panel.querySelectorAll(".cj-gm-entry--xingtu").forEach(applyAd);
        }
        applyBuyerShowUiFixes();
        // 用户中心（弹窗）里的三处定制
        removeUnwantedTabs();
        bindQuickActions();
        patchAppConfigCache();
        dismissUnwantedBanners();
    }

    function scheduleApply() {
        if (applyTimer !== null) return;
        applyTimer = setTimeout(applyOverrides, 0);
    }

    const API_HOST = "https://tu.qq1000.com";
    // 15 秒内不重复拉取（MutationObserver 触发很频繁），但每 30 秒强制刷新一次，
    // 保证「后台改广告 → 插件自动跟上」而不用用户手动刷新页面。
    const PORTAL_TTL = 15000;
    const PORTAL_REFRESH_MS = 30000;
    const AD_BANNER_ID = "qq1000-portal-ad-banner";
    const AD_POPUP_ID = "qq1000-portal-ad-popup";

    function readUserToken() {
        return new Promise(resolve => {
            try {
                chrome.storage.sync.get(["cj-user-token"], sync => {
                    const token = String((sync && sync["cj-user-token"]) || "").trim();
                    if (token) return resolve(token);
                    chrome.storage.local.get(["cj-user-token"], local => {
                        resolve(String((local && local["cj-user-token"]) || "").trim());
                    });
                });
            } catch (error) {
                resolve("");
            }
        });
    }

    function absoluteUrl(url) {
        const value = String(url || "").trim();
        if (!value) return API_HOST;
        return /^https?:\/\//i.test(value) ? value : `${API_HOST}${value.startsWith("/") ? "" : "/"}${value}`;
    }

    function openLink(url, event) {
        if (event) {
            event.preventDefault();
            event.stopImmediatePropagation();
        }
        const target = absoluteUrl(url);
        const anchor = document.createElement("a");
        anchor.href = target;
        anchor.target = "_blank";
        anchor.rel = "noopener noreferrer";
        anchor.style.display = "none";
        (document.body || document.documentElement).appendChild(anchor);
        anchor.click();
        anchor.remove();
    }

    function pickAd(adsByPlacement, placement) {
        const rows = adsByPlacement && adsByPlacement[placement];
        return Array.isArray(rows) && rows.length ? rows[0] : null;
    }

    /** 面板顶部横幅广告（后台 placement=banner）。 */
    function injectBannerAd(ad) {
        const panel = document.getElementById(PANEL_ID) || document.getElementById("gg-top");
        if (!panel) return;
        const existing = document.getElementById(AD_BANNER_ID);
        if (!ad) {
            if (existing) existing.remove();
            return;
        }
        // 关闭状态挂在「广告 id + 更新时间」上：后台改了内容就等于一条新广告，
        // 用户之前关掉过，也不该把新版一起吞掉。
        const version = ad.updatedAt || 0;
        const dismissKey = `qq1000:ad:dismiss:${ad.id}:${version}`;
        try {
            // 旧版是按「广告 id」记录关闭状态的，会让人换完新广告仍然看不到——
            // 直接清掉这个历史 key，避免广告被永久吞掉。
            window.localStorage.removeItem(`qq1000:ad:dismiss:${ad.id}`);
            if (window.localStorage.getItem(dismissKey) === "1") {
                if (existing) existing.remove();
                return;
            }
        } catch (error) {}
        const banner = existing || document.createElement("div");
        banner.id = AD_BANNER_ID;
        banner.dataset.adVersion = String(version);
        banner.innerHTML = `
<button type="button" class="qq1000-ad-close" aria-label="关闭广告">×</button>
<div class="qq1000-ad-main">
    <div class="qq1000-ad-head">
        <span class="qq1000-ad-badge">推荐</span>
        <span class="qq1000-ad-title"></span>
    </div>
    <span class="qq1000-ad-sub"></span>
</div>
<div class="qq1000-ad-actions">
    <button type="button" class="qq1000-ad-go"></button>
</div>`;
        banner.querySelector(".qq1000-ad-title").textContent = ad.title || "";
        banner.querySelector(".qq1000-ad-sub").textContent = ad.subtitle || ad.content || "";
        const go = banner.querySelector(".qq1000-ad-go");
        go.textContent = ad.buttonText || "查看";
        go.addEventListener("click", event => openLink(ad.linkUrl, event), true);
        banner.querySelector(".qq1000-ad-close").addEventListener("click", event => {
            event.preventDefault();
            event.stopImmediatePropagation();
            try { window.localStorage.setItem(dismissKey, "1"); } catch (error) {}
            banner.remove();
        }, true);
        if (!existing) panel.insertBefore(banner, panel.firstChild);
    }

    /** 站内弹窗广告（后台 placement=popup），每个广告每天最多弹一次。 */
    function showPopupAd(ad) {
        if (!ad || !document.body) return;
        if (document.getElementById(AD_POPUP_ID)) return;
        let seen = {};
        const today = new Date().toISOString().slice(0, 10);
        const seenKey = `${ad.id}:${ad.updatedAt || 0}`;
        try {
            seen = JSON.parse(window.localStorage.getItem("qq1000:ad:seen") || "{}");
            if (seen[seenKey] === today) return;
            seen[seenKey] = today;
            window.localStorage.setItem("qq1000:ad:seen", JSON.stringify(seen));
        } catch (error) {}
        const node = document.createElement("div");
        node.id = AD_POPUP_ID;
        node.innerHTML = `
<div class="qq1000-ad-popup-card" role="dialog" aria-label="活动">
    <button type="button" class="qq1000-ad-close" aria-label="关闭">×</button>
    <div class="qq1000-ad-popup-title"></div>
    <div class="qq1000-ad-popup-body"></div>
    <img class="qq1000-ad-popup-img" alt="">
    <button type="button" class="qq1000-ad-go">查看</button>
</div>`;
        node.querySelector(".qq1000-ad-popup-title").textContent = ad.title || "";
        node.querySelector(".qq1000-ad-popup-body").textContent = ad.content || ad.subtitle || "";
        const img = node.querySelector(".qq1000-ad-popup-img");
        if (ad.imageUrl) {
            img.src = ad.imageUrl;
        } else {
            img.remove();
        }
        node.querySelector(".qq1000-ad-go").textContent = ad.buttonText || "立即查看";
        node.querySelector(".qq1000-ad-go").addEventListener("click", event => openLink(ad.linkUrl, event), true);
        node.querySelector(".qq1000-ad-close").addEventListener("click", event => {
            event.preventDefault();
            event.stopImmediatePropagation();
            node.remove();
        }, true);
        document.body.appendChild(node);
    }

    /** 门户配置的「内容签名」—— 只有它变了才重渲染，避免每次刷新都闪一下。 */
    function portalSignatureOf(data) {
        const ads = (data && data.adsByPlacement) || {};
        const branding = (data && data.branding) || {};
        const parts = [`v${(data && data.adsVersion) || 0}`];
        ["banner", "popup", "sidebar", "vip"].forEach(placement => {
            const rows = ads[placement] || [];
            const first = rows[0] || {};
            parts.push(`${placement}:${first.id || ""}:${first.updatedAt || ""}:${first.title || ""}:${first.subtitle || ""}`);
        });
        parts.push(`brand:${branding.aiLabel || ""}:${branding.aiSubtitle || ""}:${branding.aiUrl || ""}`);
        return parts.join("|");
    }

    /**
     * 面板顶栏那条蓝色广告位（插件里写死的「资源推荐 / 1元礼品代发 / 真实快递代发 /
     * 查降权旺旺号」）改成由后台广告位驱动：
     *   - 后台「插件管理 → 广告位」里配置 banner（没有 banner 就用专属的 tb_panel）位置的广告，
     *     这里按后台条目渲染成同样的胶囊，点击打开后台填的 linkUrl；
     *   - 后台没配就什么都不做，保留插件原有的条目（不会把广告条弄空）。
     */
    function renderPanelAdBar(ads) {
        const bar = document.querySelector(".h-00-col2");
        if (!bar) return;
        // 只认这个位置自己的广告（tb_panel，后台「投放位置」里选「淘宝面板顶栏」）。不用 banner 兜底：
        // banner 是面板顶部横幅那一条，混进来就会出现「后台没配置也显示」。
        // 插件自带的那几条一律摘掉：后台没配置就整条不显示。
        const rows = (ads && ads.tb_panel) || [];
        const list = Array.isArray(rows) ? rows.filter(ad => String(ad.title || ad.subtitle || "").trim()) : [];
        const signature = JSON.stringify(list.map(ad => [ad.title, ad.subtitle, ad.linkUrl, ad.updatedAt]));
        if (bar.dataset.qq1000AdSignature === signature) return;
        bar.dataset.qq1000AdSignature = signature;
        bar.textContent = "";
        bar.style.display = list.length ? "" : "none";
        list.forEach(ad => {
            const label = String(ad.title || ad.subtitle || "").trim();
            if (!label) return;
            const chip = document.createElement("div");
            chip.className = "h-00-col2-text gg-text-xhx";
            chip.setAttribute("data-qq1000-ad-rendered", "1");
            chip.textContent = label;
            const url = String(ad.linkUrl || "").trim();
            if (url) {
                chip.style.cursor = "pointer";
                chip.title = url;
                chip.addEventListener("click", () => window.open(url, "_blank"));
            }
            bar.appendChild(chip);
        });
    }

    /**
     * 搬家面板里的两个推广入口（礼品代发 / 查降权号）改为读后台广告位：
     * placement = ``move_panel``，每条广告一个入口，互不影响。
     *   - 按标题关键词归位（含「礼品/代发」的进礼品代发位，含「降权」的进查降权位），
     *     其余按后台顺序补位；
     *   - 后台没配置这个位置时不动，保留插件原来的条目；
     *   - 只配了一条时，另一个入口下线（这样「单独配置」才真的可控）。
     * 节点定位沿用「自身直接文本 + 插件类名前缀」的方式，不依赖具体类名。
     */
    const MOVE_AD_SLOTS = [
        { label: "礼品代发", match: /礼品|代发/ },
        { label: "查降权号", match: /降权/ }
    ];
    const PLUGIN_OWNED_CLASS = /^(cj-|jc-|gg-|gm-|uc-|kd-|kdcm|qq1000-|h-00|plugin-)/;

    function directLabelNode(label) {
        const found = [];
        document.querySelectorAll("div, span, a, li, p").forEach(node => {
            if (!node.parentElement || node.closest("[data-qq1000-tools]")) return;
            if (normalizeText(directTextOf(node)) !== label) return;
            let cursor = node;
            let depth = 0;
            while (cursor && depth < 5) {
                if (PLUGIN_OWNED_CLASS.test(String(cursor.className || ""))) {
                    found.push(node);
                    return;
                }
                cursor = cursor.parentElement;
                depth += 1;
            }
        });
        return found.length ? found[found.length - 1] : null;
    }

    function applyMovePanelAds(ads) {
        // 搬家的两个入口只认 move_panel（后台选「搬家面板入口」），与顶部广告条互不串用。
        const source = (ads && ads.move_panel) || [];
        const rows = Array.isArray(source) ? source.slice() : [];
        // 后台没配置：插件自带的这两个入口一并彻底移除（用户要求：后台没设置就不要显示）
        const assigned = [];
        MOVE_AD_SLOTS.forEach(slot => {
            const hit = rows.find(row => !assigned.includes(row) && slot.match.test(String(row.title || "")));
            slot.ad = hit || null;
            if (hit) assigned.push(hit);
        });
        const rest = rows.filter(row => !assigned.includes(row));
        MOVE_AD_SLOTS.forEach(slot => {
            if (!slot.ad && rest.length) slot.ad = rest.shift();
        });
        MOVE_AD_SLOTS.forEach(slot => {
            const node = directLabelNode(slot.label);
            if (!node) return;
            if (!slot.ad) {
                // 摘「整行」：图标与文字在同一行里，只删文字会留下孤零零的图标。
                // 向上走，只要祖先的文本仍等于这个标签（图标不带文字），就再往上一层。
                let row = node;
                let up = node.parentElement;
                let guard = 0;
                while (up && guard < 3) {
                    if (normalizeText(up.textContent) !== slot.label) break;
                    row = up;
                    up = up.parentElement;
                    guard += 1;
                }
                removeNode(row);
                return;
            }
            const title = String(slot.ad.title || "").trim();
            if (title && normalizeText(node.textContent) !== title) node.textContent = title;
            const url = String(slot.ad.linkUrl || "").trim();
            if (!url) return;
            const entry = node.closest("li, a, [class*='entry'], [class*='menu'], [class*='item']") || node.parentElement;
            if (!entry || entry.dataset.qq1000AdUrl === url) return;
            entry.dataset.qq1000AdUrl = url;
            entry.addEventListener("click", event => {
                // 拦掉插件自己的跳转，改跳后台配置的地址
                event.preventDefault();
                event.stopPropagation();
                window.open(url, "_blank");
            }, true);
        });
    }

    /** 用最新一份门户配置重绘侧栏文案、顶部横幅与弹窗广告。 */
    function renderPortalConfig(data) {
        const branding = data.branding || {};
        const ads = data.adsByPlacement || {};

        const sidebar = pickAd(ads, "sidebar") || pickAd(ads, "vip");
        if (sidebar) {
            if (sidebar.title) adConfig.label = sidebar.title;
            if (sidebar.subtitle) adConfig.subtitle = sidebar.subtitle;
            adConfig.url = absoluteUrl(sidebar.linkUrl || "/vip/plugin");
        } else if (branding.aiUrl) {
            if (branding.aiLabel) adConfig.label = branding.aiLabel;
            if (branding.aiSubtitle) adConfig.subtitle = branding.aiSubtitle;
            adConfig.url = absoluteUrl(branding.aiUrl);
        }

        try {
            injectBannerAd(pickAd(ads, "banner"));
            showPopupAd(pickAd(ads, "popup"));
            renderPanelAdBar(ads);
            lastAdsByPlacement = ads;
            applyMovePanelAds(ads);
        } catch (error) {}
    }

    /**
     * 依次取线上「品牌 + 广告位」：
     *  - 侧栏入口（.cj-gm-entry--xingtu）用 sidebar/vip 广告位，退化到品牌里的 AI 文案
     *  - 面板顶部横幅用 banner 广告位
     *  - 站内弹窗用 popup 广告位
     * 未登录直接跳过（服务端本来也不给）。
     *
     * 后台改广告后插件必须尽快跟上，所以：
     *  1. 每次请求带 `_t` cache-buster + `cache: no-store` —— tu.qq1000.com 走
     *     Cloudflare，GET 会被边缘缓存 30 秒，只靠 no-store 不够；
     *  2. 15 秒 TTL，防止 MutationObserver 高频触发把接口打爆；
     *  3. 内容签名变了才重渲染，否则会闪屏。
     */
    function loadOnlinePortalConfig(force) {
        const now = Date.now();
        if (!force) {
            if (portalInflight) return portalInflight;
            if (now - portalFetchedAt < PORTAL_TTL) return Promise.resolve();
        }
        portalInflight = readUserToken()
            .then(token => {
                if (!token) return null;
                const url = `${API_HOST}/plugin/api/index/getPluginFeatures?_t=${Date.now()}`;
                return fetch(url, {
                    headers: {
                        "user-token": token,
                        "Cache-Control": "no-cache",
                        "Pragma": "no-cache"
                    },
                    cache: "no-store",
                    credentials: "omit"
                })
                    .then(response => response.json())
                    .catch(() => null);
            })
            .then(payload => {
                portalFetchedAt = Date.now();
                if (!payload || payload.state === false || Number(payload.code) !== 0) return;
                const data = payload.data || {};
                const signature = portalSignatureOf(data);
                if (signature !== portalSignature) {
                    portalSignature = signature;
                    renderPortalConfig(data);
                }
                scheduleApply();
            })
            .catch(() => {
                portalFetchedAt = Date.now();
            })
            .then(() => {
                portalInflight = null;
            });
        return portalInflight;
    }

    /**
     * 选品库顶部的「免费体验 AI 换图」推广条下线。
     *
     * 插件自己的关闭逻辑是读 `localStorage['cj_selection_pool_ai_banner_dismiss_v1']`
     * （常量 zg，`aiIntroBannerVisible = !localStorage.getItem(zg)`），所以写入 "1"
     * 就是从数据层真正关掉 —— 组件压根不会渲染这条 banner；已经渲染出来的再摘掉。
     */
    const POOL_AI_BANNER_KEY = "cj_selection_pool_ai_banner_dismiss_v1";
    function dismissUnwantedBanners() {
        try {
            if (window.localStorage.getItem(POOL_AI_BANNER_KEY) !== "1") {
                window.localStorage.setItem(POOL_AI_BANNER_KEY, "1");
            }
        } catch (error) {}
        document.querySelectorAll(".pool-ai-intro-banner").forEach(node => node.remove());
    }

    applyOverrides();
    // 尽早写入，保证选品库弹窗首次挂载时就读到「已关闭」。
    dismissUnwantedBanners();

    // 后台改完广告/品牌，最迟 30 秒内反映到已经打开的页面上；
    // 切回标签页时再强制拉一次，做到「改完切回来就是新的」。
    setInterval(() => {
        if (document.visibilityState === "visible") loadOnlinePortalConfig(true);
    }, PORTAL_REFRESH_MS);
    document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") loadOnlinePortalConfig(true);
    });

    // 注意：这个观察器跑在**所有页面**（含 tu.qq1000.com 这类重 DOM 的 SPA）。
    // 原来每次 DOM 变动都先做 11 次 document.querySelector 全文扫描，页面每秒几百上千次
    // 变动时会直接把主线程打满（表现为网站卡死）。这里加两道闸：
    //   1) 先看面板在不在，绝大多数页面/时刻直接返回（getElementById 比全文扫描便宜得多）；
    //   2) 整体节流到每 800ms 最多检查一次 —— 这些覆盖项都是外观调整，晚一点生效没关系。
    let lastObserverCheckAt = 0;
    const observer = new MutationObserver(mutations => {
        // 面板（侧栏形态 #cj-goods-side-panel-root / 停靠横条形态 #gg-top）刚插入时先别显示：
        // MutationObserver 回调在浏览器绘制之前执行，在这里同步把工具按钮分类、
        // 把要下线的东西摘掉，再放开显示，用户就看不到「原始排版 -> 整理后排版」的跳变。
        // 统计格与指定工具按钮也在这一瞬间摘掉（Vue 重渲染后会再次触发这里补摘）。
        if (mutationTouchesTools(mutations)) {
            try {
                // 只扫「这次新增的那几棵子树」，不做面板全量查询：
                // 之前每次变动都全量扫，页面元素多的时候会把主线程拖住。
                mutations.forEach(mutation => {
                    Array.from(mutation.addedNodes || []).forEach(node => {
                        if (node && node.nodeType === 1) purgeRemovedNodes(node);
                    });
                });
            } catch (error) {
            }
        }
        syncPanelMount();
        const now = Date.now();
        if (now - lastObserverCheckAt < 800) return;
        const panel = document.getElementById(PANEL_ID) || document.getElementById("gg-top");
        if (!panel) return;
        lastObserverCheckAt = now;
        if (
            document.querySelector(".buyer-show-dialog") ||
            document.querySelector(".plugin-wrapper") ||
            document.querySelector(".kd-dialog") ||
            document.querySelector("#gg-top") ||
            document.querySelector("#loginApp-gg") ||
            document.querySelector(".download-user-info") ||
            document.querySelector(".select-catery-user") ||
            document.querySelector(".cj-wg-overlay") ||
            document.querySelector("#kdds-contact-dialog") ||
            // 用户中心弹窗（会员订购 / 功能导航两个 Tab 要在这里面移除）：
            // 它不一定挂在侧栏面板里，所以必须单独识别，否则面板外渲染时
            // 观察器不会触发，Tab 就删不掉。
            document.querySelector(".uc-overlay") ||
            document.querySelector(".uc-modal") ||
            document.querySelector(".uc-tab-bar")
        ) {
            scheduleApply();
            return;
        }
        const changedInsidePanel = mutations.some(mutation => {
            if (mutation.target === panel || panel.contains(mutation.target)) return true;
            return Array.from(mutation.addedNodes || []).some(node =>
                node === panel || (node && node.nodeType === 1 && typeof node.contains === "function" && node.contains(panel))
            );
        });
        if (changedInsidePanel) scheduleApply();
    });
    // 性能：不监听 characterData —— 页面每次文字变化都会触发回调，重页面上量非常大，
    // 而我们的规则只需要「节点增删」。代价是「只有文字变化、没有节点增删」的更新不再触发整理，
    // 所以补一个 5 秒一次的低频兜底：只扫面板范围（几十个节点），把该清的再清一遍。
    observer.observe(document.documentElement, { childList: true, subtree: true });
    setInterval(() => {
        try {
            applyRemovals();
            applyMovePanelAds(lastAdsByPlacement);
            ensurePanelTitle();   // 顶栏标题兜底：面板重渲染后也保证还在
        } catch (error) {
        }
    }, 5000);
})();
