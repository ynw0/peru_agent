# Ink 鼠标输入必须只有一个读取者

## 现象

Windows Terminal 已启用 SGR 鼠标追踪，但滚轮、拖选和右键复制同时失效。

## 根因

Ink 7 使用 `readable` 事件和 `stdin.read()` 读取原始输入。TUI 又给同一 stdin
添加了 `data` 监听，期望从第二条通道解析鼠标报告。Ink 先读取数据后，第二个
监听拿不到鼠标 CSI；而 `useInput` 收到完整 CSI 后只忽略，没有分发给鼠标处理器。

## 规则

- Ink `useInput` 是 TUI 的唯一输入入口。
- 鼠标 CSI 在进入文本输入 reducer 前交给统一路由器。
- 不给 Ink 管理的 stdin 再添加 `data` 或 `readable` 消费者。
- SGR 的小写 `m` 先判定为释放事件，再判断 motion 位，避免拖选状态无法结束。
