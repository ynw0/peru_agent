# PowerShell 与 Windows Sandbox Broker 架构

## 1. 目标

Phase 5 建立 Windows 11 x64 上的进程执行安全边界。Windows 主 Shell 固定为 PowerShell 7，不调用 Windows PowerShell 5.1，也不在 Broker 失败时改用 `cmd.exe`、Bash、普通 `spawn` 或无沙箱执行。

## 2. 调用链

```text
AgentLoop
→ PowerShell Tool validate
→ Windows Sandbox Broker powershell.analyze
→ PowerShell 官方 AST 与安全规则
→ ToolInspection / PermissionCoordinator
→ powershell.execute
→ Restricted Token + AppContainer + Job Object
→ stdout/stderr/audit result
→ Tool Result
```

PowerShell Tool 本身不直接启动 `pwsh.exe`。只有 Broker 完成强制能力握手后，Tool 才允许进入分析和执行流程。

## 3. Broker 能力握手

Broker 必须同时报告：

- PowerShell AST；
- Restricted Token；
- AppContainer；
- Job Object；
- 文件 ACL；
- 网络隔离；
- 进程树终止；
- UTF-8 JSONL。

任一能力缺失，TypeScript Runtime 将 Broker 标记为不健康并拒绝执行。

## 4. 分析与执行绑定

安全分析结果包含：

- `analysisId`；
- 脚本 SHA-256；
- 命令列表；
- 影响文件；
- 网络目标；
- 动态 Capability；
- 拒绝原因。

执行请求还包含 `executionId`。Broker 执行结果必须原样返回 `executionId + analysisId + scriptSha256`，客户端再次校验。分析结果只能使用一次，默认五分钟过期；权限拒绝或 Tool 结束后，客户端调用 `powershell.discard-analysis` 释放临时状态。

## 5. AST 安全规则

使用 `System.Management.Automation.Language.Parser.ParseInput`，禁止用简单正则替代 AST。

Phase 5 明确拒绝：

- `Invoke-Expression`、`Add-Type`、远程会话、凭据相关 Cmdlet；
- 动态命令名、call operator 和 dot source；
- .NET 类型表达式和成员方法调用；
- 文件重定向；
- PowerShell Provider 路径、UNC、工作区外路径和通配路径；
- 不在静态命令白名单中的命令；
- LAN 或互联网模式执行。

第一版 PowerShell Tool 只允许读取工作区和执行受沙箱约束的命令，不允许用 PowerShell 写工作区。工作区修改仍必须使用 Diff Proposal。

## 6. 原生进程隔离

原生 Broker 源码位于：

```text
native/windows-sandbox-broker/
```

执行器组合：

- `CreateRestrictedToken` 删除最大权限；
- AppContainer Profile 和 Security Capabilities；
- Job Object，设置关闭即杀死、进程数和内存上限；
- AppContainer SID 的工作区只读 ACL；
- 独立临时目录可写 ACL；
- 清理过的环境变量；
- `-NoLogo -NoProfile -NonInteractive -Command -`；
- UTF-8 stdin/stdout/stderr；
- 超时或取消时终止整个 Job Object；
- JSONL 审计日志。

ACL 清理只移除 Broker 自己加入的精确 ACE，不恢复整份旧 ACL，避免覆盖执行期间其他程序的 ACL 修改。

## 7. 取消协议

客户端取消 `powershell.execute` 时：

1. 移除本地 Pending；
2. 将原请求 ID 标记为允许迟到响应；
3. 发送 `powershell.cancel(executionId)`；
4. Broker 取消对应执行；
5. 原生执行器终止整个 Job Object。

已取消请求的迟到响应只被忽略，不会作为未知 ID 终止其他正常请求。

## 8. 网络边界

Phase 5 不向 AppContainer 授予任何直接网络 Capability。即使用户设置为 `lan` 或 `internet`，Broker 也会返回 `EGRESS_BROKER_NOT_AVAILABLE`。

原因：项目规则要求所有网络统一经过 Egress Broker。该能力属于 Phase 9，不能提前通过 AppContainer 的 Internet Capability 绕过统一审计。

## 9. 当前验证状态

已验证：

- TypeScript Broker 协议、运行时校验和 Tool 集成；
- 能力握手失败关闭；
- 分析/执行哈希绑定；
- 动态 Capability 权限；
- 分析释放；
- 输出结果绑定；
- 原生 C# 源码契约。

尚未验证：

- Windows 11 上的 C# 编译；
- AppContainer、Restricted Token、Job Object 的真实运行；
- PowerShell 7 AST 集成测试；
- 进程逃逸、路径逃逸和网络逃逸红队测试。

这些门禁必须在 Windows 11 x64、PowerShell 7 和 .NET SDK 8 环境中执行。
