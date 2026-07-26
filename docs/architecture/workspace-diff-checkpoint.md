# Workspace、Diff 与 Checkpoint 架构

## 目标

Phase 4 建立独立 AI IDE 的安全文件修改链：模型只能提出修改，不能直接覆盖用户文件。

```text
模型调用 Write/Edit/ApplyPatch
→ Tool validate
→ Tool inspect
→ 创建 Diff Proposal
→ IDE 展示统一 Diff
→ 用户接受或拒绝
→ 接受前重新校验文件 SHA-256
→ 创建 Checkpoint
→ 原子写入
→ 记录事件和状态
```

## 组件职责

### WorkspaceService

- 所有文件访问的唯一入口；
- 只接受工作区相对路径；
- 拒绝绝对路径、盘符路径、UNC 和 `..`；
- 拒绝经过符号链接访问；
- 读取 UTF-8 文本并计算 SHA-256；
- 写入前后两次检查期望哈希；
- 同一工作区内部写入串行化；
- 提供 Glob 和 Grep。

### DiffManager

- 保存 `proposed/accepted/rejected/conflict` 状态；
- Proposal 包含修改前快照、修改后内容和统一 Diff；
- 接受前一次性检查全部文件；
- 多文件写入中途失败时回滚已经写入的文件；
- 将 Proposal 写入可持久化 Store；
- 发布 `diff.proposed` 和 `diff.resolved` 事件。

### CheckpointManager

- Diff 接受前保存修改前完整文本；
- 接受后保存预期的修改后哈希和内容；
- 恢复前检查文件是否仍与接受后状态一致；
- 用户在接受后继续修改文件时拒绝恢复；
- 恢复中途失败时恢复到修改后的状态，避免半恢复。

### WorkspaceRuntime

- IDE 对工作区、Diff 和 Checkpoint 的统一服务入口；
- 接受、拒绝和恢复操作使用同一串行队列；
- 通过 Typed IPC 暴露工作区读取、Diff 审核和 Checkpoint 恢复。

## 权限设计

新增 `workspace.propose` 能力：

- 允许模型生成 Diff Proposal；
- 不代表拥有真实 `workspace.write` 权限；
- 真正写盘只能来自 IDE 的 `diff.accept`；
- 高权限生成 Tool 仍不能自动晋级。

因此 `Write`、`Edit` 和 `ApplyPatch` 的风险等级仍为 `workspace-write`，但运行能力只声明读取和提议修改。

## 冲突规则

以下情况全部停止，不覆盖用户内容：

- Proposal 创建后目标文件哈希变化；
- 新文件 Proposal 创建后同名文件出现；
- Checkpoint 接受后用户再次修改文件；
- 路径包含符号链接或越出根目录；
- 多文件 Proposal 中任意一个文件冲突。

## 当前明确边界

- Phase 4 只处理 UTF-8 文本文件；
- 不支持二进制文件修改；
- Git 命令必须等 Windows Sandbox Broker 完成后才能执行；
- LSP 与 Diagnostics 在真实 Code OSS Runtime 接通后实施；
- 应用层哈希检查不能替代 Phase 5 的操作系统级文件沙箱。
