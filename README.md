# QQ1000电商 · Chrome 扩展（在线版）

淘宝 / 天猫 / 京东 / 1688 等平台的电商工具面板扩展，登录和功能配置由 tu.qq1000.com 提供。

## 安装

1. [下载最新扩展 ZIP](https://github.com/QQ1000COM/qq1000-chrome-extension/releases/latest/download/qq1000-chrome-extension.zip)，或在[发布页面](https://github.com/QQ1000COM/qq1000-chrome-extension/releases/latest)查看版本说明与 SHA-256 校验文件
2. 解压到任意目录
3. 打开 `chrome://extensions` → 打开「开发者模式」→「加载已解压的扩展程序」→ 选择解压目录
4. 首次使用：在插件图标里粘贴 `tu.qq1000.com` 用户中心的**用户密钥**完成登录

> 更新时：点击插件弹窗的「下载新版」，解压覆盖原目录，再通过「如何更新插件 → 打开扩展管理页」点击本插件的「重新加载」，最后刷新商品页面。

## 5.80.0 更新内容

- 修复登录切换、数据保存、资源加载和拼多多任务恢复问题。
- 广告统一由后台配置；没有配置、未启用或无效的广告不显示，已删除的定时广告不会在原定时间重新出现。
- 移除个人中心功能导航、选品库 AI 推广与教程。这些界面由线上模块提供，更新扩展后需刷新已打开的业务页面。

此前安装过 **5.80.0 候选测试版**的用户也需要下载正式 ZIP、覆盖原目录并重新加载扩展。候选版与正式版的数值版本号相同，版本检测不会额外弹出升级提示。

## 版本与更新检测

- **版本号唯一来源**：`manifest.json` 的 `version` 字段。
- **`version.json`**：发布流程自动生成，扩展内置的更新检测会读取它
  （`https://raw.githubusercontent.com/QQ1000COM/qq1000-chrome-extension/main/version.json`），
  发现远端版本更高时在页面上提示「插件有新版本」。成功检查缓存 12 小时；镜像超时会自动尝试备用地址，全部失败后 5 分钟可再次检查。升级通知会跨页面保留。
- **`updates.xml`**：保留合法的 Chrome 更新响应，当前返回 `noupdate`。
  此仓库只发布 ZIP，不生成或宣称提供已签名 CRX；「加载已解压」不会自动替换安装目录。
  用户收到版本提示后需下载新 ZIP、覆盖原目录并在扩展管理页重新加载。
- **发布流程**：`.github/workflows/release.yml` —— 推送 `main` 时自动
  运行插件回归、打包 ZIP（包含本说明）、发布 Release 与 SHA-256 校验文件（tag 为 `v版本号`），
  并同步 `version.json`、`updates.xml` 和 `config/app-config.json` 的版本字段。下载地址固定到具体版本。

## 发版步骤

1. 设置 `manifest.json` 的新版本号，并同步 `version_name` 与 `version.json` 的更新说明
2. 将改动合入并推送到 `main`；仅推送开发分支不会生成正式发布包
3. 等待 Actions 成功，确认 `main/version.json`、对应 Release 标签和 ZIP 都是同一版本，再向用户提供下载入口

## 本地回归

运行 `node --test tests/*.test.mjs`。用例覆盖登录、升级、后台消息、网络资源、页面注入、广告配置与权限边界；涉及真实店铺的采集和发布表单还需在登录后验证。

## 目录结构

```
manifest.json     扩展清单（含版本号、content_scripts 注入范围）
config/           扩展运行配置（CDN/API 域名、登录地址、品牌信息）
icons/            扩展图标（新 LOGO）
script/           扩展逻辑：面板增强、登录态桥接、页面注入等
rules/            网络请求规则
source/           面板静态资源
popup.html/js     扩展弹窗
```
