# Phase 8 执行报告：子 Agent 调度、隔离与 Patch 合并

## 结论

Phase 8 已完成 Planner、Explorer、Implementer、Reviewer、Tester 五类子 Agent 的策略、调度、预算、父子取消、快照式隔离工作区、恢复、Reviewer/Tester 门禁、Diff Proposal 合并链、Typed IPC 和 Workbench 状态投影。

本阶段没有绕过 Windows Sandbox Broker 直接执行 Git，也没有把快照目录冒充为真实 Git Worktree。

## 完成内容

### 调度与预算

- 全局和父会话并发限制；
- 最大深度 2；
- 最大运行时长、轮次、ToolCall 和 Token 预算；
- 重复启动幂等；
- queued、调度准备中和 running 取消；
- 父会话取消传播；
- EventJournal 和 JSON Store；
- 中断任务恢复为明确失败。

### 权限边界

- Planner、Explorer、Reviewer 只读；
- Implementer 仅在隔离 Workspace 写入；
- Tester 不继承父 Agent 权限；
- 模型可见 Tool、Tool Manifest、实际执行和动态 Capability 四层校验。

### 隔离与审核

- 受路径、文件数和总字节限制的快照式隔离工作区；
- 持久化根目录和 Workspace ID 绑定；
- Reviewer/Tester 审核 Implementer 的精确隔离结果；
- 非 Implementer 完成后清理隔离目录和失效引用。

### Patch 合并

- Implementer 变化转换为父工作区 Diff Proposal；
- 父工作区 SHA-256 冲突检查；
- Reviewer 和 Tester 必须同时批准；
- 用户接受 Diff 前父工作区保持不变；
- 接受后才能 `finalizeMerge`。

### IPC 与 Workbench

Typed IPC 协议升级至版本 4，新增子 Agent 派发、启动、取消、查询、列表、提出合并和完成合并方法。Workbench Snapshot 和 Code OSS Tasks View 可以展示子 Agent 生命周期和 Patch 状态。

## 验证

```text
npm run audit                  → 通过
npm run check                  → 通过
npm test                       → 97 passed
npm run build                  → 通过
npm run smoke                  → Phase 0～8 全部通过
npm run code-oss:check-overlay → 通过
npm run code-oss:verify-applied→ 通过
```

## 未完成门禁

以下不宣称完成：

- 真实 `git worktree` Backend；
- Git Tool 和 Git 进程沙箱；
- Windows 11 上的子 Agent 进程级隔离；
- 多模型、多 GPU 的真实性能和并发测试；
- Code OSS 桌面程序中的生产 IPC Transport；
- Electron Workbench 完整构建和桌面启动；
- 子 Agent 真实 LM Studio、vLLM 或云端模型集成测试。

真实 Git Worktree 必须等待 Windows Sandbox Broker 完成真机门禁，不能在当前 Linux 环境中通过普通进程调用提前启用。

## Code OSS 完整编译

已在应用 Phase 8 Overlay 后的固定 Code OSS 1.74.0 源码中真实执行 `npm run compile`。当前归档仍不包含锁定依赖，构建失败于：

```text
Cannot find module './node_modules/gulp/bin/gulp.js'
```

详情见 `PHASE8_CODE_OSS_BUILD_LOG.txt`。该结果不影响 Overlay 源码契约验证，但说明 Electron Workbench 尚未完成真实编译和启动。
