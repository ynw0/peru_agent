# OpenTUI Renderer Migration

## 根因

Ink 的输入模型和 OpenCode 当前使用的 OpenTUI renderer 不同。为了在 Ink 中同时实现全屏滚动和拖选复制，项目曾自行启用 xterm `1000/1002/1006`，再解析 SGR 鼠标、维护 Hit Region、Selection 坐标和 OSC52 剪贴板。这形成了第二套终端输入/选择引擎：滚轮、拖选、Ink `useInput` 和终端原生行为会争夺同一 stdin，实机表现不可稳定复现。

关闭 alternate screen 再依赖终端 scrollback 也不是正确修复，因为滚轮会看到启动 TUI 之前的 PowerShell/npm 输出，而不是只浏览 Agent Session。

## 决策

1. 产品 TUI renderer 迁到 `@opentui/core` + `@opentui/react`，固定 0.4.5。
2. OpenTUI 是终端键盘、鼠标、Selection 和滚动的唯一所有者；新 renderer 禁止导入旧 `mouse.ts`、`hit-regions.ts`、`selection.ts` 或 `TuiInputRouter`。
3. Session 使用原生 `<scrollbox scrollY stickyScroll stickyStart="bottom">`；滚轮和 PageUp/PageDown 由 ScrollBox 处理。
4. 文本选择使用 renderer `getSelection()` / `clearSelection()`；不再根据终端坐标手算字符范围。
5. Windows 剪贴板采用 OpenCode 同类策略：Selection 文本通过 PowerShell 7 `Set-Clipboard` 写入系统剪贴板。Phase 1 不提供 OSC52/clipboardy fallback。
6. OpenTUI 原生 renderer 使用 Bun；Windows 启动脚本明确要求 Bun >= 1.3，不回退到 Node 22/Ink。
7. Agent Controller、Runtime、Session、Tool、Permission、Diff 和 Sandbox 都保持为既有事实来源；renderer 只订阅状态并调用 Controller API。

## 迁移边界

Phase 1 已覆盖 renderer bootstrap、首次配置、会话 ScrollBox、键盘输入、粘贴、Selection copy、Permission/Diff/Plan 审核以及常用 slash command。运行期 `/config`、外部路径授权对话框、Shell 确认、完整详情面板和 OpenTUI E2E 在后续阶段迁移；缺失能力必须明确拒绝，不能回退到 Ink。

## 回归要求

- `tui.ps1` 不得引用 `dist/src/tui/main.js` 或 `node.exe`。
- OpenTUI main 必须使用 alternate-screen 且 `useMouse: true`。
- Session 必须使用原生 ScrollBox，而不是终端主缓冲区 scrollback。
- 新 renderer 不得导入手写 SGR 鼠标/Selection 实现。
- Selection 的 Ctrl+C 优先于“取消 Agent”；没有 Selection 时 Ctrl+C 才取消当前运行。
