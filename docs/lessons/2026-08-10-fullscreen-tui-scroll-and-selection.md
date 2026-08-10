# 全屏 TUI 的滚动与拖选

## 根因

Ink 的 `alternateScreen` 与普通终端 scrollback 是两套不同的历史模型。关闭 `alternateScreen` 后，Windows Terminal 的滚轮会浏览整个 Shell 缓冲区，因此会看到启动 TUI 之前的 `npm run build`、PowerShell 提示符等内容。这不是会话滚动。

另一方面，启用 xterm 鼠标跟踪后，终端会把滚轮和拖动编码成 CSI/SGR 报告交给应用。此时应用必须自己维护会话 Viewport 与文本 Selection；不能同时期待终端原生 scrollback/拖选继续承担 TUI 交互。

## 规则

1. 全屏会话保持 `alternateScreen: true`，启动前 Shell 输出不进入 TUI 视图。
2. 生命周期统一启用/关闭 `1000 + 1002 + 1006` 鼠标模式。
3. 滚轮只修改当前 TUI 的 Timeline/Detail Viewport；在主会话中不依赖鼠标恰好停在正文字符上。
4. 左键拖选继续使用现有 Selection；拖动结束复用既有 Clipboard 复制路径，不新增第二套剪贴板实现。
5. 单独的 `Esc` 是键盘输入，不能被鼠标 CSI 分片识别吞掉。

## 回归测试

至少覆盖：SGR 鼠标分片、滚轮事件、普通 `Esc`、主会话全屏 hit fallback、拖选结束触发复制动作，以及 Selection 在 Timeline 外点击时不会错误延续。
