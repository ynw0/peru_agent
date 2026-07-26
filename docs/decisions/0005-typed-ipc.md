# ADR-0005：Workbench 与 Agent Runtime 使用 Typed IPC

状态：已批准

## 决策

- Workbench 与 Agent Runtime 分进程运行；
- 使用版本化请求/响应/事件协议；
- UI 不能直接执行 Tool；
- 所有请求支持明确超时，调用方可使用 `AbortSignal` 取消；
- 不支持协议版本自动兼容或消息字段猜测。

## 原因

分进程边界可以避免模型调用、工具执行和后台任务阻塞 IDE UI，同时让后续 Windows 沙箱 Broker、浏览器和子 Agent 使用统一事件流。
