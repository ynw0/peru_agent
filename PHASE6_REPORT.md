# Phase 6 执行报告

## 阶段目标

实现 AI IDE 交互层，包括 Agent Chat、Plan Review、Tool 卡片、权限窗口、Diff Review、Checkpoint、会话恢复和事件溯源 UI。

阶段计划置信度：94/100。当前平台无关 Runtime 与 Code OSS Overlay 契约部分置信度：96/100；完整 Code OSS 桌面编译和运行仍受上游依赖门禁限制。

## 修改范围

新增或修改：

- `src/agent-protocol.ts`；
- `src/agent/agent-loop.ts`；
- `src/agent/permission-coordinator.ts`；
- `src/plan/plan-manager.ts`；
- `src/runtime/workbench-*`；
- `src/runtime/plan-ipc-bridge.ts`；
- `src/runtime/ipc-bridge.ts`；
- `src/workbench/workbench-state.ts`；
- `src/workbench/workbench-controller.ts`；
- `src/ipc/protocol.ts`、`src/ipc/validation.ts`；
- Code OSS `independentAiIde` Overlay；
- `tests/phase6.test.ts`；
- `src/phase6-smoke.ts`；
- `package.json` 和项目文档。

## 完成内容

### Agent Chat

- 用户消息事件；
- Assistant 开始、delta 和完成事件；
- 稳定 `messageId`；
- 流式文本投影；
- Token 用量显示；
- 发送、继续、停止和 Retry Controller；
- Retry 创建新会话，保留原失败会话审计记录。

### Plan Review

- Plan 状态机；
- 置信度、影响文件和步骤；
- 批准/拒绝 Typed IPC；
- 执行、完成、失败和取消状态；
- EventJournal 重放和原始时间戳恢复。

### Tool 与权限卡片

Tool 卡片展示：

- ToolCall ID；
- 描述；
- 风险等级；
- Capability；
- 影响文件；
- 命令；
- 网络目标；
- 进度；
- 完成状态。

权限卡片展示：

- Tool 名称；
- 风险；
- 请求原因；
- Capability；
- 影响文件；
- 允许一次和拒绝。

### Diff 与 Checkpoint

- Diff Proposal 列表；
- 接受/拒绝按钮；
- Conflict 状态；
- Checkpoint 列表和恢复按钮；
- 所有操作继续通过 Phase 4 Runtime 与 Typed IPC。

### 会话与恢复

- `session.list`；
- `session.events`；
- `session.retry`；
- 按 Session 隔离 Workbench Snapshot；
- EventJournal 重放；
- 时间线显式加载，避免 delta 请求风暴。

### Code OSS 原生视图

占位 View 已替换为可交互 ViewPane：

- AI Agent；
- Tasks；
- Permissions；
- Browser 明确不可用提示。

View 不导入 `node:fs`、`node:child_process`，也不直接执行 Tool。

## 测试结果

```text
npm run audit                  → 通过
npm run check                  → 通过
npm test                       → 69 passed
npm run build                  → 通过
npm run smoke                  → Phase 0~6 全部通过
npm run code-oss:check-overlay → 通过
```

## 未完成门禁

- Code OSS 1.74.0 完整依赖安装；
- Electron Workbench 完整编译；
- 桌面 IDE 实际启动；
- 主进程到独立 Agent Runtime 的生产 IPC Transport 安装；
- Windows Sandbox Broker Windows 11 真机门禁；
- 真实 LM Studio/vLLM 模型端点验证。

因此当前准确状态是：交互领域模型、Typed IPC Controller 和 Code OSS View Overlay 已完成并通过契约测试；尚未把“完整桌面 IDE 已运行”标记为完成。

## 根因经验

详见：

- `docs/lessons/2026-07-26-workbench-event-projection-and-ipc.md`

## 下一阶段

Phase 7：低延迟代码补全。

- 独立 FIM Provider；
- Inline Completion；
- 请求取消和去重；
- Prefix/Suffix 上下文缓存；
- 模型能力探测；
- TTFT 和接受率基准。
