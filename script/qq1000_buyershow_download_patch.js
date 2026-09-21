"use strict";

/*
 * Runs in the page MAIN world on Taobao/Tmall pages. The hosted buyer-show
 * module creates its ZIP files there, so text normalization must wrap the
 * page's JSZip instance rather than the isolated content-script world.
 */
(function installQq1000BuyerShowDownloadPatch() {
    if (window.__QQ1000_BUYER_SHOW_DOWNLOAD_PATCH_INSTALLED__) {
        try {
            if (typeof window.__QQ1000_REFRESH_BUYER_SHOW_PATCH__ === "function") {
                window.__QQ1000_REFRESH_BUYER_SHOW_PATCH__();
            }
        } catch (error) {}
        return;
    }
    window.__QQ1000_BUYER_SHOW_DOWNLOAD_PATCH_INSTALLED__ = true;
    let wrappedBlobConstructor = null;

    function cleanLine(value) {
        return String(value || "")
            .replace(/&nbsp;?/gi, " ")
            .replace(/\u00a0/g, " ")
            .replace(/[\t ]+/g, " ")
            .trim();
    }

    function sanitizeBuyerShowText(value) {
        const original = String(value == null ? "" : value).replace(/\r\n?/g, "\n");
        const lines = original.split("\n");
        const reviews = [];
        let captureMode = "";
        let recognized = false;

        function pushReview(line) {
            const cleaned = cleanLine(line);
            if (cleaned && cleaned !== "-" && cleaned !== "无评价内容") reviews.push(cleaned);
        }

        lines.forEach(line => {
            const cleaned = cleanLine(line);
            if (/^===\s*(?:首次评价|追加评价)\s*===$/.test(cleaned)) {
                recognized = true;
                captureMode = "block";
                return;
            }
            if (/^===/.test(cleaned)) {
                recognized = true;
                captureMode = "";
                return;
            }
            if (/^-{3,}$/.test(cleaned)) {
                recognized = true;
                captureMode = "";
                return;
            }

            const direct = cleaned.match(/^(?:评论内容|评价内容|内容评价|首评内容|首次评价内容|追评内容|追加评价内容|追加评论内容)\s*[:：]\s*(.*)$/i);
            if (direct) {
                recognized = true;
                pushReview(direct[1]);
                captureMode = "label";
                return;
            }

            const metadata = /^(?:评论\d+|买家昵称|用户昵称|会员等级|评论时间|评价时间|SKU(?:信息|规格)?|匿名评价|评价视频|视频链接|视频地址|图片地址|评论状态|AI内容|追评时间|追加评论时间|追加评价时间)\s*[:：]/i.test(cleaned);
            if (metadata) {
                recognized = true;
                if (captureMode === "label") captureMode = "";
                return;
            }

            if (captureMode && cleaned) pushReview(cleaned);
        });

        if (reviews.length) return reviews.join("\n");
        return recognized ? "" : original;
    }

    function shouldSanitize(filename, value) {
        if (typeof value !== "string") return false;
        if (!isReviewTextFilename(filename)) return false;
        return hasBuyerShowMetadata(value);
    }

    function isReviewTextFilename(filename) {
        const name = String(filename || "").replace(/\\/g, "/").split("/").pop();
        return /^(?:评论\d+|内容(?:汇总)?|买家秀).*\.txt$/i.test(name);
    }

    function hasReviewBodyMarker(value) {
        return /(?:评论内容|评价内容|内容评价|追加评论内容|追评内容|===\s*(?:首次评价|追加评价)\s*===)/i.test(String(value || ""));
    }

    function hasBuyerShowMetadata(value) {
        return hasReviewBodyMarker(value);
    }

    function patchBlobConstructor() {
        const NativeBlob = window.Blob;
        if (typeof NativeBlob !== "function") return false;
        if (NativeBlob === wrappedBlobConstructor) return true;
        try {
            const BlobProxy = new Proxy(NativeBlob, {
                construct(target, args, newTarget) {
                    const parts = args[0];
                    const options = args[1] || {};
                    let nextParts = parts;
                    if (
                        /^text\/plain(?:;|$)/i.test(String(options.type || "")) &&
                        Array.isArray(parts) &&
                        parts.length > 0 &&
                        parts.every(part => typeof part === "string")
                    ) {
                        const text = parts.join("");
                        if (hasReviewBodyMarker(text)) nextParts = [sanitizeBuyerShowText(text)];
                    }
                    return Reflect.construct(target, [nextParts, options], newTarget);
                }
            });
            wrappedBlobConstructor = BlobProxy;
            window.Blob = BlobProxy;
            return true;
        } catch (error) {
            return false;
        }
    }

    function patchJsZipConstructor(JsZip) {
        if (!JsZip || !JsZip.prototype || typeof JsZip.prototype.file !== "function") return false;
        const prototype = JsZip.prototype;
        const originalFile = prototype.file;
        if (originalFile.__qq1000BuyerShowTextPatched) return true;
        try {
            const wrappedFile = function qq1000BuyerShowFile(filename, value) {
                if (arguments.length >= 2 && shouldSanitize(filename, value)) {
                    const args = Array.from(arguments);
                    args[1] = sanitizeBuyerShowText(value);
                    return originalFile.apply(this, args);
                }
                if (
                    arguments.length >= 2 &&
                    isReviewTextFilename(filename) &&
                    value &&
                    typeof value.text === "function" &&
                    /^text\/plain(?:;|$)/i.test(String(value.type || ""))
                ) {
                    const args = Array.from(arguments);
                    args[1] = Promise.resolve(value.text()).then(text => {
                        if (!hasBuyerShowMetadata(text)) return value;
                        return new window.Blob([sanitizeBuyerShowText(text)], {
                            type: value.type || "text/plain;charset=utf-8"
                        });
                    });
                    return originalFile.apply(this, args);
                }
                return originalFile.apply(this, arguments);
            };
            Object.defineProperty(wrappedFile, "__qq1000BuyerShowTextPatched", {
                value: true,
                enumerable: false
            });
            prototype.file = wrappedFile;
            Object.defineProperty(prototype, "__qq1000BuyerShowTextPatched", {
                value: true,
                configurable: false,
                enumerable: false,
                writable: false
            });
            return true;
        } catch (error) {
            return false;
        }
    }

    function patchJsZip() {
        return patchJsZipConstructor(window.JSZip);
    }

    function installJsZipAssignmentHook() {
        try {
            const descriptor = Object.getOwnPropertyDescriptor(window, "JSZip");
            if (descriptor && descriptor.get && descriptor.get.__qq1000JsZipHook) {
                patchJsZip();
                return true;
            }
            if (descriptor && descriptor.configurable === false) return patchJsZip();

            let storedValue = descriptor && Object.prototype.hasOwnProperty.call(descriptor, "value")
                ? descriptor.value
                : window.JSZip;
            const originalGet = descriptor && descriptor.get;
            const originalSet = descriptor && descriptor.set;
            const getter = function qq1000GetJsZip() {
                return originalGet ? originalGet.call(window) : storedValue;
            };
            Object.defineProperty(getter, "__qq1000JsZipHook", {
                value: true,
                enumerable: false
            });
            const setter = function qq1000SetJsZip(nextValue) {
                if (originalSet) originalSet.call(window, nextValue);
                else storedValue = nextValue;
                patchJsZipConstructor(nextValue);
            };
            Object.defineProperty(window, "JSZip", {
                configurable: true,
                enumerable: descriptor ? descriptor.enumerable : true,
                get: getter,
                set: setter
            });
            patchJsZipConstructor(getter());
            return true;
        } catch (error) {
            return false;
        }
    }

    function refreshPatch() {
        patchBlobConstructor();
        installJsZipAssignmentHook();
        patchJsZip();
    }

    window.__QQ1000_PATCH_BUYER_SHOW_JSZIP__ = patchJsZip;
    window.__QQ1000_REFRESH_BUYER_SHOW_PATCH__ = refreshPatch;
    window.__QQ1000_SANITIZE_BUYER_SHOW_TEXT__ = sanitizeBuyerShowText;

    refreshPatch();
    window.addEventListener("qq1000-buyershow-download-start", refreshPatch, true);
    let attempts = 0;
    const timer = setInterval(() => {
        attempts += 1;
        refreshPatch();
        if (attempts >= 2400) clearInterval(timer);
    }, 250);
})();
