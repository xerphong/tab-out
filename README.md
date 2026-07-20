# Tab Out

**Keep tabs on your tabs.**  
**把你的标签页重新变得可控。**

Tab Out is a Chrome extension that replaces your new tab page with a dashboard of everything you have open. Tabs are grouped by domain, with homepages pulled into their own group, so you can clean up faster.  
Tab Out 是一个 Chrome 扩展，会把新标签页替换成你的标签页总览面板。它会按域名分组，并把首页类页面单独归组，让整理标签更高效。

No server. No account. No external API calls. Just a Chrome extension.  
没有服务器，没有账号，没有外部 API 调用。它只是一个纯本地的 Chrome 扩展。

---

## What's Modified In This Fork / 本 Fork 的主要改动

- Added customizable quick links for frequently used sites.  
  增加了可自定义的 Quick Links，方便快速打开常用网站。
- Added keyword-based domain split rules for more precise grouping.  
  增加了基于关键词的 domain 拆分规则，让分组更精细。
- Enhanced Saved for Later with domain grouping plus domain-level restore and cleanup actions.  
  增强了 Saved for Later：按 domain 分组，并支持按 domain 批量恢复和清理。
- Added an expanded Saved for Later view to make closed pages easier to find.  
  增加了 Saved for Later 展开视图，方便查找已关闭的页面。
- Refined the tab list layout for denser, cleaner scanning across large domain groups.  
  优化了标签列表布局，让大量标签的 domain 分组更紧凑、更容易快速浏览。
- Added smart split keyword suggestions for domains with more than 10 tabs.  
  为超过 10 个 tabs 的 domain 自动推荐拆分关键词，点击即可生成新的 split group。

- Added a browser context-menu save action that sends the current page directly to Saved for Later, using the same local storage flow as the Tab Out dashboard save button.  
  增加了浏览器右键菜单保存功能，可以把当前页面直接加入 Saved for Later，并复用 Tab Out 页面中保存按钮的本地存储流程。
---

## Attribution / 来源说明

This project is based on [zarazhangrui/tab-out](https://github.com/zarazhangrui/tab-out), originally created by [Zara](https://x.com/zarazhangrui) and licensed under the MIT License.  
本项目基于 [zarazhangrui/tab-out](https://github.com/zarazhangrui/tab-out)，原作者是 [Zara](https://x.com/zarazhangrui)，并采用 MIT 协议。

Modified by [XerPhong](https://github.com/xerphong) with additional tab management features and workflow refinements.  
本 fork 由 [XerPhong](https://github.com/xerphong) 修改，加入了额外的标签管理功能和使用流程优化。

Many thanks to the original author for the idea and foundation.  
感谢原作者提供的创意与基础实现。

---

## Install With A Coding Agent / 使用 Coding Agent 安装

Send your coding agent (Claude Code, Codex, etc.) this repo and say **"install this"**:  
把这个仓库发给你的 coding agent（如 Claude Code、Codex），并告诉它 **"install this"**：

```text
https://github.com/xerphong/tab-out
```

The agent will walk you through it. Takes about 1 minute.  
Agent 会带你一步步安装，通常 1 分钟左右就能完成。

---

## Features / 功能

- **See all your tabs at a glance** on a clean grid, grouped by domain.  
  **在清晰的网格中一眼看清所有标签页**，并按域名分组。
- **Homepages group** pulls Gmail inbox, X home, YouTube, LinkedIn, GitHub homepages into one card.  
  **首页分组**会把 Gmail、X、YouTube、LinkedIn、GitHub 等首页聚合到一张卡片里。
- **Close tabs with style** with swoosh sound + confetti burst.  
  **带动效地关闭标签页**，包含 swoosh 音效和纸屑动画。
- **Duplicate detection** flags when you have the same page open twice, with one-click cleanup.  
  **重复标签检测**会标记重复页面，并支持一键清理。
- **Click any tab to jump to it** across windows, no new tab opened.  
  **点击任意标签即可跳转**，即使它在别的窗口里，也不会新开标签页。
- **Save for later** bookmarks tabs to a checklist before closing them.  
  **稍后保存**可以在关闭前把标签加入待办清单。
- **Expand Saved for later** into a wider view so closed pages are easier to find.  
  **展开 Saved for later** 可以用更宽的视图查找已关闭的页面。
- **Localhost grouping** shows port numbers next to each tab so you can tell local projects apart.  
  **Localhost 分组**会显示端口号，便于区分本地项目。
- **Expandable groups** show the first 8 tabs with a clickable `+N more`.  
  **可展开分组**默认显示前 8 个标签，并支持点击 `+N more` 展开。
- **100% local** your data never leaves your machine.  
  **100% 本地运行**，你的数据不会离开这台机器。
- **Pure Chrome extension** with no server, no Node.js, no npm, and almost zero setup.  
  **纯 Chrome 扩展**，不需要服务器、Node.js、npm，几乎零配置。

---

## Manual Setup / 手动安装

**1. Clone the repo / 克隆仓库**

```bash
git clone https://github.com/xerphong/tab-out.git
```

**2. Load the Chrome extension / 加载 Chrome 扩展**

1. Open Chrome and go to `chrome://extensions`.  
   打开 Chrome，进入 `chrome://extensions`。
2. Enable **Developer mode** in the top-right corner.  
   打开右上角的 **Developer mode（开发者模式）**。
3. Click **Load unpacked**.  
   点击 **Load unpacked（加载已解压的扩展程序）**。
4. Select the `extension/` folder inside the cloned repo.  
   选择仓库中的 `extension/` 文件夹。

**3. Open a new tab / 打开一个新标签页**

You'll see Tab Out.  
然后你就会看到 Tab Out。

---

## How It Works / 工作方式

```text
Open a new tab
  -> Tab Out shows your open tabs grouped by domain
  -> Homepages get their own group at the top
  -> Click any tab title to jump to it
  -> Close groups you're done with
  -> Save tabs for later before closing them
```

```text
打开一个新标签页
  -> Tab Out 会按域名展示你当前打开的标签页
  -> 首页类页面会单独放在顶部
  -> 点击任意标签标题即可跳转
  -> 可以关闭整个分组
  -> 也可以在关闭前先保存到稍后处理列表
```

Everything runs inside Chrome. Tab Out has no external server, API, or account. Saved tabs live in a dedicated Chrome bookmarks folder, so they survive extension reinstall and follow Chrome bookmark sync when it is enabled.
所有功能都在 Chrome 内运行，Tab Out 没有外部服务器、API 或独立账号。保存的标签会放在专用的 Chrome 书签文件夹中，因此重新安装扩展后仍然存在，并会在启用 Chrome 书签同步时跟随同步。

---

## Tech Stack / 技术栈

| What | How |
|------|-----|
| Extension | Chrome Manifest V3 |
| Storage | Synced Chrome bookmarks (Saved for Later) + chrome.storage.local (device settings) |
| Sound | Web Audio API (synthesized, no files) |
| Animations | CSS transitions + JS confetti particles |

| 项目 | 实现方式 |
|------|----------|
| 扩展 | Chrome Manifest V3 |
| 存储 | Chrome 同步书签（稍后处理）+ chrome.storage.local（设备设置） |
| 音效 | Web Audio API（实时合成，无音频文件） |
| 动画 | CSS transitions + JS confetti particles |

---

## License / 许可证

MIT

---

Built by [Zara](https://x.com/zarazhangrui), maintained in this fork by [XerPhong](https://github.com/xerphong).  
原始项目由 [Zara](https://x.com/zarazhangrui) 创建，本 fork 由 [XerPhong](https://github.com/xerphong) 维护。
