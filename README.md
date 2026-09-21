# QQ1000电商 · Chrome 扩展（在线版）

淘宝 / 天猫 / 京东 / 1688 等平台的电商工具面板扩展。扩展本身是外壳，
面板业务代码从 `https://tu.qq1000.com/plugin-static/` 在线拉取（带 `user-token` 鉴权）。

## 安装

1. 下载最新发布包：<https://github.com/QQ1000COM/qq1000-chrome-extension/releases/latest>
2. 解压到任意目录
3. 打开 `chrome://extensions` → 打开「开发者模式」→「加载已解压的扩展程序」→ 选择解压目录
4. 首次使用：在插件图标里粘贴 `tu.qq1000.com` 用户中心的**用户密钥**完成登录

> 更新时：下载新版本覆盖目录，然后在 `chrome://extensions` 点一次「重新加载」。

## 版本与更新检测

- **版本号唯一来源**：`manifest.json` 的 `version` 字段。
- **`version.json`**：发布流程自动生成，扩展内置的更新检测会读取它
  （`https://raw.githubusercontent.com/QQ1000COM/qq1000-chrome-extension/main/version.json`），
  发现远端版本更高时在页面上提示「插件有新版本」，12 小时最多检查一次。
- **`updates.xml`**：Chrome 自托管更新清单，同样由发布流程自动跟随版本号。
  注意 Chrome 的自动更新只对「用 CRX 安装」的扩展生效，且要求 CRX 用同一私钥签名
  （私钥请放 GitHub Secret，不要进仓库）；当前「加载已解压」的安装方式不会自动更新，
  所以实际生效的是上面那条内置检测。
- **发布流程**：`.github/workflows/release.yml` —— 推送 `main` 时自动
  打包 ZIP、发布 Release（tag 为 `v版本号`）、同步 `version.json` 与 `updates.xml`。

## 发版步骤

1. 改 `manifest.json` 里的 `version`（例如 `5.61`）
2. 提交并推送到 `main`
3. 等待 Actions 跑完，插件端 12 小时内会提示升级（也可在扩展详情页手动「更新」按钮刷新）

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
