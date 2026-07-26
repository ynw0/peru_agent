# Phase 5 执行报告

## 阶段目标

实现 PowerShell AST 分析与 Windows Sandbox Broker 安全原型，并保证沙箱不可用时拒绝执行。

阶段计划置信度：90/100。当前环境可验证部分置信度：96/100；Windows 原生运行部分仍需真实 Windows 11 门禁，不能标记完成。

## 修改范围

新增或修改：

- `src/powershell/powershell-tool.ts`；
- `src/sandbox/*`；
- `src/tool-runtime.ts`；
- `src/agent/agent-loop.ts`；
- `src/agent/permission-coordinator.ts`；
- `native/windows-sandbox-broker/*`；
- `tools/windows-sandbox/verify-source.mjs`；
- `tests/phase5.test.ts`；
- `src/phase5-smoke.ts`；
- `package.json`、审计脚本和项目文档。

## 完成内容

### TypeScript Runtime

- Broker JSONL 协议；
- 强制能力握手；
- 运行时请求/结果校验；
- PowerShell Tool 参数校验；
- AST 分析、Tool Inspection 和动态 Capability 接入；
- `executionId + analysisId + SHA-256` 绑定；
- `powershell.cancel`；
- `powershell.discard-analysis`；
- 分析临时状态释放；
- 迟到响应隔离；
- 16 MiB Broker 协议缓冲区上限；
- Broker 异常时无 fallback。

### 原生 C# Broker 源码

- PowerShell 官方 AST；
- 危险语法和命令拒绝；
- 路径和凭据边界；
- Restricted Token；
- AppContainer；
- Job Object；
- 工作区只读 ACL和任务临时目录写 ACL；
- 清理环境变量；
- UTF-8 标准输入输出；
- 超时和取消终止进程树；
- JSONL 审计日志；
- 构建脚本和 Windows 集成测试脚本。

### 网络策略

Phase 5 明确不支持 LAN/互联网 PowerShell 执行。AppContainer 不获得直接网络 Capability，必须等待 Phase 9 统一 Egress Broker。

## 测试结果

```text
npm run audit  → 通过
npm run check  → 通过
npm test       → 60 passed
npm run build  → 通过
npm run smoke  → Phase 0~5 全部通过
```

`npm run audit` 同时检查：

- UTF-8；
- 硬编码密钥；
- 空 catch；
- Code OSS Overlay；
- 原生 Broker 必需源码和 Win32 安全 API；
- 禁止直接 `Process.Start`/shell fallback。

## Windows 原生构建结果

已真实执行：

```text
npm run sandbox:build-windows
```

当前环境结果：

```text
sh: 1: pwsh: not found
EXIT_CODE=127
```

环境为 Linux，且没有 PowerShell 7 和 .NET SDK 8。因此以下项目未完成：

- C# 编译和 NuGet 锁文件生成；
- Windows 11 AppContainer 运行；
- Restricted Token 和 Job Object 运行；
- PowerShell AST 真机测试；
- 路径、进程和网络逃逸红队测试。

没有把源码契约检查冒充成 Windows 原生沙箱已验证。

## 根因经验

详见：

- `docs/lessons/2026-07-26-powershell-sandbox-binding-and-cancellation.md`

## 下一阶段

Phase 6：AI IDE 交互层。

- Agent Chat；
- Plan Review；
- Tool 卡片；
- 权限窗口；
- Diff Review；
- 会话恢复和事件溯源 UI。

Windows 原生沙箱仍保留为独立发布门禁；在门禁通过前，产品构建不得启用 PowerShell Tool。
