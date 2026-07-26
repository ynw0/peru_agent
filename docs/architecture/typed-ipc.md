# Typed IPC 架构

## 目标

在 Code OSS Workbench 与自研 Agent Runtime 之间建立严格类型化、可取消、可超时、可审计的通信协议。

## 约束

- 协议版本不一致时拒绝初始化；
- 请求必须有唯一 ID；
- 事件与请求使用不同消息类型；
- 外部输入先做运行时结构校验；
- 未注册方法返回明确错误；
- 请求超时或取消后删除 Pending 状态；
- UI 不直接调用 Tool，只能通过 Agent Runtime；
- 不传递任意异常对象、函数、类实例或密钥。

## Phase 1 方法

- `runtime.initialize`
- `session.create`
- `permission.resolve`
- `workbench.getSnapshot`

## Phase 1 事件

- `agent.event`
- `workbench.snapshot.changed`
- `runtime.health.changed`

后续新增方法必须同时修改 `IpcRequestMap`、运行时校验和测试。
