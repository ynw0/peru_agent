# 执行状态

## 当前阶段

- Phase 0：完成；
- Phase 1：独立产品身份、Typed IPC 和 Workbench 容器设计完成；
- Phase 2：真实 Code OSS 1.74.0 源码导入、Overlay 应用和 API 契约验证完成；
- Phase 3：自研 Agent Core 完成；
- Phase 4：Workspace、Diff、Checkpoint 和文件冲突检测完成；
- Phase 5：PowerShell AST、Broker 协议和 Windows 原生安全原型源码完成；
- 下一开发阶段：Phase 6 AI IDE 交互层。

## Phase 5 已完成

- Windows Sandbox Broker JSONL 协议；
- 强制能力握手；
- PowerShell Tool 与官方 AST 分析接口；
- executionId、analysisId 和脚本 SHA-256 绑定；
- 动态 Capability 接入现有权限系统；
- 执行取消和分析释放协议；
- Restricted Token、AppContainer、Job Object、ACL 和审计日志 C# 源码；
- 禁止 PowerShell 直接修改工作区；
- Phase 9 之前禁止沙箱直接 LAN/互联网访问；
- Windows 构建和集成测试脚本。

## 验证结果

```text
npm run audit → 通过
npm run check → 通过
npm test      → 60 passed
npm run build → 通过
npm run smoke → Phase 0~5 全部通过
```

## 未通过或未执行门禁

- 当前环境为 Linux，没有 `pwsh` 和 .NET SDK 8；
- `npm run sandbox:build-windows` 已执行并以 exit code 127 明确失败；
- C# Broker 尚未在 Windows 11 x64 编译；
- AppContainer、Restricted Token、Job Object 和 ACL 尚未真机运行；
- 路径、进程树和网络逃逸红队测试尚未执行；
- Windows 真机门禁通过前，产品不得启用 PowerShell Tool；
- Code OSS 完整依赖安装和桌面启动仍未完成；
- 未对真实 OpenAI 兼容模型服务执行联网调用。
