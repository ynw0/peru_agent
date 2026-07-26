# Phase 4 执行报告：Workspace、Diff 与 Checkpoint

## 阶段结论

- 状态：完成；
- 置信度：93/100；
- 分支：`phase-4-workspace-diff`；
- 版本：`0.5.0`；
- Claude Agent SDK：未使用；
- 第三方运行时依赖：未新增。

## 影响文件

### 新增模块

```text
src/workspace/
src/diff/
src/checkpoint/
src/tools/workspace-tools.ts
src/runtime/workspace-runtime.ts
src/runtime/workspace-ipc-bridge.ts
src/phase4-smoke.ts
tests/phase4.test.ts
```

### 修改模块

```text
src/agent-protocol.ts
src/agent/agent-loop.ts
src/tool-runtime.ts
src/permission-engine.ts
src/ipc/protocol.ts
src/ipc/validation.ts
src/workbench/workbench-state.ts
src/node-shims.d.ts
package.json
```

## 已完成能力

- Read；
- Write Proposal；
- Edit Proposal；
- ApplyPatch Proposal；
- Glob；
- Grep；
- FileDiff；
- CheckpointRead；
- 工作区相对路径边界；
- Windows 盘符和 UNC 拒绝；
- 符号链接拒绝；
- SHA-256 冲突检测；
- Diff 接受、拒绝和冲突状态；
- 多文件提交预检查和回滚；
- 自动 Checkpoint；
- Checkpoint 冲突检测和恢复；
- Diff/Checkpoint JSON Store；
- Diff/Checkpoint 事件投影；
- Typed IPC 工作区、Diff 和 Checkpoint 方法。

## 安全决策

模型工具不能直接写盘。

```text
Write/Edit/ApplyPatch
→ workspace.propose
→ Diff Proposal
→ IDE 用户接受
→ Checkpoint
→ workspace.write
```

`workspace.propose` 在默认和自动审核模式下可以执行，因为它没有文件副作用；真正写入只能通过 IDE 的 `diff.accept` 请求。

## 测试结果

```text
npm run audit → 通过
npm run check → 通过
npm test      → 48 passed
npm run build → 通过
npm run smoke → Phase 0~4 全部通过
```

新增测试覆盖：

- 目录穿越、绝对路径、Windows 盘符和 UNC；
- 符号链接越界；
- 根目录和嵌套 Glob；
- Grep；
- Proposal 不直接落盘；
- 接受、拒绝和冲突；
- 新文件恢复；
- 多文件冲突时零写入；
- Checkpoint 恢复冲突；
- AgentLoop Write Proposal；
- Typed IPC；
- JSON 持久化恢复；
- Workbench 事件重放。

## 未完成且未伪装完成

- 二进制文件修改；
- Git 命令执行；
- LSP、Diagnostics 和 Rename；
- Windows PowerShell AST；
- Windows Sandbox Broker；
- Code OSS 完整编译和桌面启动；
- 真实 IDE Diff UI。

Git 依赖进程执行，必须在 Phase 5 沙箱完成后启用；LSP 和 Diagnostics 依赖真实 Code OSS Runtime，转入后续 IDE 集成阶段。
