"use strict";

(function installPddRecoveryNotice() {
    if (window !== window.top || window.location.origin !== "https://mms.pinduoduo.com" || window.__QQ1000_PDD_RECOVERY__) return;
    window.__QQ1000_PDD_RECOVERY__ = true;
    const NOTICE_ID = "qq1000-pdd-recovery-notice";
    let status = { needsAttention: false, message: "" };
    let busy = false;
    let requestSequence = 0;
    let notice = null;

    function render() {
        if (!status.needsAttention) {
            if (notice) notice.remove();
            notice = null;
            return;
        }
        if (!document.body) return;
        if (!document.getElementById(NOTICE_ID + "-style")) {
            const style = document.createElement("style");
            style.id = NOTICE_ID + "-style";
            style.textContent = `#${NOTICE_ID}{position:fixed;left:16px;bottom:16px;z-index:2147483647;max-width:350px;padding:16px;border:1px solid #f5bf73;border-radius:10px;background:#fffcf5;color:#344054;box-shadow:0 8px 24px #0002;font:13px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif}#${NOTICE_ID} strong{display:block;color:#93370d;font-size:14px}#${NOTICE_ID} p{margin:8px 0}#${NOTICE_ID} button{cursor:pointer;padding:7px 12px;border:1px solid #b54708;border-radius:6px;background:#fff;color:#93370d;font:inherit}#${NOTICE_ID} button:disabled{cursor:wait;opacity:.65}`;
            (document.head || document.documentElement).appendChild(style);
        }
        if (!notice) {
            notice = document.createElement("aside");
            notice.id = NOTICE_ID;
            notice.setAttribute("role", "alert");
            const title = document.createElement("strong");
            title.textContent = "搬家任务需要确认";
            const reason = document.createElement("p");
            reason.className = "qq1000-pdd-recovery-reason";
            const hint = document.createElement("p");
            hint.textContent = "请先确认上次商品是否已保存，再重置本页搬家任务并重新采集。";
            const button = document.createElement("button");
            button.type = "button";
            button.className = "qq1000-pdd-recovery-reset";
            button.addEventListener("click", resetTask);
            notice.appendChild(title);
            notice.appendChild(reason);
            notice.appendChild(hint);
            notice.appendChild(button);
            document.body.appendChild(notice);
        }
        notice.querySelector(".qq1000-pdd-recovery-reason").textContent = status.message;
        const button = notice.querySelector(".qq1000-pdd-recovery-reset");
        button.disabled = busy;
        button.textContent = busy ? "正在重置…" : "重置本页搬家任务";
    }

    function applyStatus(value) {
        status = {
            needsAttention: Boolean(value && value.needsAttention),
            message: String(value && value.message || "").slice(0, 1000),
        };
        render();
    }

    function request(message) {
        return new Promise(resolve => {
            let done = false;
            const finish = response => {
                if (done) return;
                done = true;
                clearTimeout(timer);
                resolve(response);
            };
            const timer = setTimeout(() => finish({ success: false, error: "插件暂时没有响应，请稍后重试。" }), 12000);
            try {
                chrome.runtime.sendMessage(message, response => {
                    const error = chrome.runtime.lastError;
                    finish(error ? { success: false, error: error.message } : response || { success: false, error: "无法读取任务状态，请刷新页面后重试。" });
                });
            } catch (error) { finish({ success: false, error: "插件连接已失效，请重载插件后刷新页面。" }); }
        });
    }

    async function refreshStatus() {
        const sequence = ++requestSequence;
        const response = await request({ type: "qq1000:pdd-recovery-state" });
        if (sequence !== requestSequence) return;
        if (response.success) applyStatus(response.status);
        else applyStatus({ needsAttention: true, message: response.error || "无法读取任务状态，请稍后重试。" });
    }

    async function resetTask() {
        if (busy) return;
        const sequence = ++requestSequence;
        busy = true;
        render();
        const response = await request({ type: "pdd_clear_hijack_flag" });
        busy = false;
        if (sequence !== requestSequence) { render(); return; }
        if (response.success) applyStatus({ needsAttention: false, message: "" });
        else applyStatus({ needsAttention: true, message: "重置未完成：" + (response.error || "请稍后重试。") });
    }

    chrome.runtime.onMessage.addListener(message => {
        if (!message || message.type !== "qq1000:pdd-state") return false;
        requestSequence++;
        applyStatus(message.status);
        return false;
    });
    window.addEventListener("focus", () => { if (!busy) void refreshStatus(); });
    document.addEventListener("visibilitychange", () => { if (!busy && document.visibilityState === "visible") void refreshStatus(); });
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => { render(); void refreshStatus(); }, { once: true });
    else void refreshStatus();
})();
