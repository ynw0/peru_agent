# AI IDE 交互层架构

## 目标

Phase 6 把已经存在的 Agent Runtime、权限、Diff 和 Checkpoint 能力映射成可恢复、可审核的 IDE 交互状态。

UI 不是事实来源。唯一状态来源仍然是：

```text
Agent / Workspace / Plan Runtime
        ↓ 不可变 AgentEvent
EventJournal
        ↓ 事件投影
WorkbenchRuntime
        ↓ Typed IPC
WorkbenchController
        ↓ Bridge
Code OSS ViewPane
```

## 主要组件

### `WorkbenchRuntime`

- 按 `sessionId` 保存独立 Snapshot；
- 后台会话事件不会覆盖当前会话；
- 可以从 EventJournal 重放恢复；
- 只发布 Snapshot，不暴露 Tool 或文件对象。

### `WorkbenchController`

- 是 UI 命令唯一入口；
- 只能调用 Typed IPC；
- 提供发送、继续、停止、重试、权限决定、计划决定、Diff 接受/拒绝和 Checkpoint 恢复；
- 会话列表和时间线通过明确请求加载。

### `PlanManager`

Plan 使用独立状态机：

```text
reviewing → approved → executing → completed/failed/cancelled
          ↘ rejected
```

UI 只能提交 `approved/rejected`，不能直接修改 PlanRecord。

### Code OSS ViewPane

- Agent View：消息、流式状态、Token、发送/停止/重试；
- Tasks View：计划、Tool、Diff、Checkpoint；
- Permissions View：风险、能力、影响文件和允许/拒绝；
- Browser View：明确显示尚未连接，不创建虚假浏览器能力。

## IPC 协议版本 2

新增：

```text
session.list
session.events
session.retry
plan.list
plan.get
plan.resolve
workbench.getSnapshot(sessionId?)
```

Agent Event 新增或增强：

- `user.message.added`；
- `assistant.started` 与带 `messageId` 的 delta；
- `session.usage.updated`；
- 完整 Tool 风险、影响文件、命令和网络目标；
- 完整 Permission 请求原因；
- Plan 创建、审核和状态事件。

## 安全边界

禁止：

```text
Workbench View → 文件系统
Workbench View → Shell
Workbench View → Tool.execute
Workbench View → PermissionEngine 内部对象
```

唯一允许路径：

```text
Workbench View
→ Workbench Bridge
→ WorkbenchController
→ Typed IPC
→ Runtime / Permission / Diff / Checkpoint
```

桥接未安装时，View 显示“Agent Runtime 未连接”，不会使用本地替代执行路径。

## 恢复策略

进程重启后：

1. SessionStore 恢复会话；
2. EventJournal 恢复事件；
3. WorkbenchRuntime 按会话重放；
4. PlanManager 使用事件中的原始时间戳恢复；
5. UI 读取 Snapshot 和时间线。

流式字符事件只更新 Snapshot，不为每个 delta 重新请求完整时间线。
