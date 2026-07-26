# 子 Agent 调度、隔离与 Patch 合并架构

## 1. 边界

子 Agent 运行时复用现有 Agent Core、Tool Runtime、Workspace、Diff、Checkpoint、EventJournal 和 Typed IPC，但不继承父 Agent 的全部权限。

```text
Parent Agent / Workbench
→ SubagentController
→ Typed IPC
→ SubagentRuntimeIpcBridge
→ SubagentScheduler
→ SnapshotWorktreeManager
→ AgentRuntimeSubagentExecutor
→ Diff Proposal
→ Reviewer + Tester Gate
→ 用户接受 Diff
→ merged
```

子 Agent 不能直接修改父工作区。Implementer 只能修改隔离工作区，最终变化必须转换为 Phase 4 的 Diff Proposal。

## 2. 角色和权限

固定角色：

| 角色 | 默认能力 | 写入 |
|---|---|---|
| Planner | `workspace.read` | 禁止 |
| Explorer | `workspace.read` | 禁止 |
| Implementer | `workspace.read`、`workspace.propose`、`workspace.write` | 仅隔离工作区 |
| Reviewer | `workspace.read` | 禁止 |
| Tester | `workspace.read`；进程能力必须另行声明并经过 Broker | 禁止直接写父工作区 |

角色策略同时约束：

1. 发送给模型的 Tool Definition；
2. Tool 实际执行阶段；
3. Tool `inspect()` 返回的动态 Capability。

因此模型即使生成未展示的 ToolCall，也不能越过运行时能力边界。

## 3. 调度

`SubagentScheduler` 提供：

- 全局并发上限；
- 每个父会话并发上限；
- 最大深度 2；
- 最大轮次、ToolCall、Token 和时长预算；
- queued、running、completed、failed、aborted、patchProposed、merged 状态机；
- 重复 `start()` 幂等；
- 父会话取消传播；
- 事件日志和 JSON 持久化。

调度器在任务离开队列时原子登记：

- 全局并发槽；
- 父会话并发槽；
- `AbortController`。

之后才开始异步创建隔离工作区，避免取消和并发统计竞态。

## 4. 隔离工作区

当前实现为 `SnapshotWorktreeManager`：

- 只复制 `allowedPaths`；
- 默认最多 5,000 个文件；
- 默认总大小最多 100 MiB；
- 工作区 ID 固定为 `subagent:<taskId>`；
- 根目录固定绑定 `isolationRoot/<safeTaskId>`；
- 创建、复制和执行都接受同一个取消信号；
- 持久化恢复时重新验证根目录和 Workspace ID；
- Reviewer 和 Tester 从 Implementer 的隔离结果创建审查副本。

当前不执行 `git worktree` 命令。真实 Git Worktree Backend 必须等待 Windows Sandbox Broker 和 Git Tool 安全门禁通过。

## 5. Patch 合并

Implementer 完成后仍不能修改父工作区：

```text
隔离工作区变化
→ 比较隔离基线
→ 比较父工作区当前 SHA-256
→ Reviewer APPROVED
→ Tester APPROVED
→ 创建 Diff Proposal
→ 用户接受 Diff
→ finalizeMerge
```

任意父工作区文件在隔离任务后发生变化，Patch Proposal 都会停止，禁止覆盖用户新修改。

Reviewer 和 Tester 必须：

- 指向同一个 Implementer；
- 与 Implementer 属于同一父会话；
- 审核范围不超过 Implementer 允许范围；
- 返回严格的 `APPROVED` 或 `REJECTED` Verdict。

## 6. 恢复

进程重启后：

- queued 和 running 任务明确转为 `failed / SUBAGENT_INTERRUPTED_RECOVERED`；
- completed Implementer 和 patchProposed 任务恢复隔离工作区；
- 已清理的 Reviewer、Tester、Planner、Explorer 不保留失效 Worktree 引用；
- 损坏、重复 ID 或语义不一致的 JSON 记录明确失败。

持久化层允许读取“running 但工作树尚未落盘”的崩溃窗口状态，以便恢复器将其安全标记失败。

## 7. Typed IPC 与 Workbench

IPC 协议版本为 4，新增：

- `subagent.dispatch`
- `subagent.start`
- `subagent.abort`
- `subagent.get`
- `subagent.list`
- `subagent.proposeMerge`
- `subagent.finalizeMerge`

Workbench Snapshot 增加 `subagents`，Tasks View 显示角色、深度、状态、Workspace、Verdict、Proposal 和错误。UI 只能通过 Bridge 和 Typed IPC 请求操作，不能直接访问 Scheduler、Workspace 或 Tool。
