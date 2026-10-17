# dsh-file-actions

给 DeepSeek Harness Web 界面里的文件引用加右键菜单。

Right-click menu for file references in the DeepSeek Harness web UI.

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![DSH](https://img.shields.io/badge/DeepSeek%20Harness-0.1.1--rc.2-blue.svg)](https://github.com/deepseek-ai/deepseek-harness)
[![Topic: dsh-plugin](https://img.shields.io/badge/topic-dsh--plugin-0284c7.svg)](https://github.com/topics/dsh-plugin)

---

## 它解决什么问题 / The problem

DSH 会把消息里的文件引用渲染成蓝色 chip，例如 `index.html`、`@src/app.tsx`。它们看起来像可以点的链接，实际只能看，想打开文件还得手动去资源管理器里翻。

`dsh-file-actions` 让这些引用支持右键：直接打开文件、在资源管理器里定位、用浏览器预览、复制完整路径。

DSH renders file mentions as blue chips (`index.html`, `@src/app.tsx`). They look clickable but are not. This plugin adds a context menu so you can open the file, reveal it in Explorer, preview it in a browser, or copy its absolute path.

## 功能 / Features

| 菜单项 | 适用文件 | 行为 |
|---|---|---|
| 用默认程序打开 | 全部 | 交给 Windows 文件关联 |
| 用浏览器打开 | html / svg / md / txt / json / xml / yaml / css / js / ts 等文本类 | 以 `file:///` URL 交给默认浏览器 |
| 在文件夹中显示 | 全部 | 打开资源管理器并选中该文件 |
| 复制完整路径 | 全部 | 写入剪贴板 |

菜单头部显示文件名与完整路径，长路径左侧渐隐，方便确认打开的是哪一个。

以下三种引用形态都能识别：

- `[data-ref-chip]` 元素（DSH 渲染的蓝色文件 chip）
- `file:///` 形式的链接
- 内容像本地路径的行内代码（`code` 元素）

## 安装 / Install

### 方式一：dsh plugin 命令（推荐）

```bash
dsh plugin --profile desktop add "link:/absolute/path/to/dsh-file-actions"
```

随后在 `$DSH_HOME/profiles/desktop/package.json` 的 `dsh.profile.bundles` 里追加 `"dsh-file-actions"`，重启桌面应用。

> `dsh plugin` 会把参数原样转发给 pnpm。路径含空格时会被拆词，此时请改用方式二。

### 方式二：手工 link（路径含空格时）

1. 在 `profiles/<profile>/package.json` 的 `dependencies` 加一条：
   ```json
   "dsh-file-actions": "link:E:/path/to/dsh-file-actions"
   ```
2. 在 `dsh.profile.bundles` 追加 `"dsh-file-actions"`。
3. 在 `profiles/<profile>/node_modules/` 下建一个指向本目录的目录联接（Junction）：
   ```powershell
   New-Item -ItemType Junction -Path "<profile>/node_modules/dsh-file-actions" -Target "E:\path\to\dsh-file-actions"
   ```
4. 重启 DSH 桌面应用。

`$DSH_HOME` 默认是 `~/.dsh`。桌面端使用 `desktop` profile，纯 Web 端使用 `web` profile。

### 卸载

删掉 `node_modules/dsh-file-actions` 与 `bundles` 里的那一行即可。插件不修改任何既有文件。

## 权限与安全边界 / Permissions & safety

这是一个**会执行本机命令**的插件，装之前请明确知道它做了什么。

- **三个动作，白名单**：`reveal` / `open` / `browser`。接口不接受任意命令字符串。
- **路径必须真实存在**：宿主在执行前做 `existsSync` 与 `stat` 校验，不存在的路径直接返回 400。
- **不做 shell 字符串拼接**：全部通过 `spawn` 的参数数组传递，路径不会被当作命令解释。
- **不读文件内容**：宿主只做定位与打开，不读取、不上传任何文件正文。
- **无外部网络请求**：客户端只向同源的 `/api/file-actions/exec` 发 POST。
- **无依赖**：`dependencies` 为空，没有生命周期脚本（`preinstall` / `install` / `postinstall` / `prepare` 都不存在）。

This plugin spawns local Windows processes. It exposes exactly three whitelisted actions, validates that the target path exists, passes arguments as arrays (never shell-interpolated strings), never reads file contents, and makes no outbound network requests.

## 兼容性 / Compatibility

- 在 DeepSeek Harness `0.1.1-rc.2` + Windows 上开发与验证。
- 依赖 DSH 把文件引用渲染为 `[data-ref-chip]`、`file://` 链接或 `code` 元素。三者任一变体都可识别；若上游渲染结构整体更换，右键会失效，需要在 `lib/client.js` 的 `resolveFromEvent` 里补选择器。
- 系统动作部分使用 Windows 的 `explorer.exe` 与 `cmd.exe /c start`，其他平台需要替换 `lib/index.js` 里的 `launch` 调用。

## 已知限制 / Known limitations

- 相对路径引用（如 `index.html`）按宿主进程当前工作目录解析，解析不到会提示 `path does not exist`。
- 菜单样式跟随 DSH 设计 token，深浅色主题自动适配。
- 未做键盘全流程导航（Esc 关闭已实现，方向键在菜单项间移动尚未实现）。
- 系统动作（真的弹出资源管理器/浏览器）没有自动化测试覆盖，需要人工点一次确认。

## 开发 / Development

```
lib/index.js         宿主侧：注册 /api/file-actions 路由，执行系统动作
lib/client.js        客户端侧：捕获 contextmenu，识别引用，渲染菜单
scripts/verify.mjs   自检
```

自检：

```bash
node scripts/verify.mjs
```

覆盖包元数据、客户端语法、路由注册、健康检查，以及未知动作 / 不存在路径 / 空路径 / 非法路由四个拒绝分支。共 12 项。

健康检查接口：

```
GET /api/file-actions/health
```

## 许可证 / License

[MIT](LICENSE)

---

如果这个插件帮你省了几次在资源管理器里翻文件的时间，点个 Star 会让更多人看到它。
