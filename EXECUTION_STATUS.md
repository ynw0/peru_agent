# 执行状态

## 当前阶段

- Phase 0：完成；
- Phase 1：独立产品身份、Typed IPC 和 Workbench 容器设计完成；
- Phase 2：真实 Code OSS 1.74.0 源码导入、Overlay 应用和 API 契约验证完成；
- Phase 3：自研 Agent Core 完成；
- Phase 4：Workspace、Diff、Checkpoint 和文件冲突检测完成；
- 下一开发阶段：Phase 5 PowerShell AST 与 Windows Sandbox Broker 安全原型。

## Phase 4 已完成

- WorkspaceService 与工作区注册；
- Read、Write、Edit、ApplyPatch、Glob、Grep；
- 模型写工具只生成 Diff Proposal；
- Diff 接受、拒绝和冲突状态；
- 自动 Checkpoint 和恢复；
- 多文件事务检查和失败回滚；
- 路径穿越、UNC、盘符和符号链接拒绝；
- JSON 持久化和运行时校验；
- Typed IPC 与 Workbench 事件投影。

## 验证结果

```text
npm run audit → 通过
npm run check → 通过
npm test      → 48 passed
npm run build → 通过
npm run smoke → Phase 0~4 全部通过
```

## 未通过或未执行门禁

- 未对真实 OpenAI 兼容模型服务执行联网调用；
- Code OSS 完整编译和桌面启动仍未完成；
- Git、PowerShell 和其他子进程工具未启用，因为 Windows Sandbox Broker 尚未完成；
- LSP 与 Diagnostics 尚未接入真实 Code OSS Runtime；
- Phase 4 只支持 UTF-8 文本文件。
