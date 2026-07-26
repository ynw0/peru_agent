# PowerShell 沙箱绑定与取消经验

## 现象

Phase 5 初版已经有 Broker Client 和 PowerShell Tool，但存在以下隐患：

1. 执行结果只返回 stdout/stderr，无法证明属于当前审核；
2. 用户取消只删除本地 Pending，原生进程可能继续运行；
3. 权限拒绝后安全分析缓存可能残留；
4. 已取消请求的迟到响应会被当作未知 ID，误伤其他请求；
5. 仅使用 Cmdlet 白名单时，PowerShell 可通过 .NET 静态成员调用绕过；
6. 直接授予 AppContainer 网络 Capability 会绕过未来统一 Egress Broker。

## 根因

- 安全分析、权限决定和执行结果之间缺少不可变身份绑定；
- 取消被当作 Promise 状态，而不是进程树生命周期操作；
- Tool Runtime 没有临时检查状态释放钩子；
- IPC 实现假设请求响应总会正常按时到达；
- PowerShell 是完整语言，命令名不是唯一执行入口；
- 网络模式与网络执行通道被错误地视为同一概念。

## 修复

- 使用 `executionId + analysisId + scriptSha256` 三重绑定；
- 分析结果一次性使用，并设置五分钟过期；
- Tool 增加可选 `releaseInspection`，权限拒绝和执行结束都释放分析；
- 增加 `powershell.cancel`，原生侧终止 Job Object；
- 传输层记录已取消请求 ID并忽略迟到响应；
- AST 拒绝成员调用、类型表达式、动态调用和文件重定向；
- Phase 5 只允许 offline，LAN/互联网等待统一 Egress Broker；
- ACL 清理只删除自己添加的精确 ACE。

## 新增测试

- Broker 缺少能力时拒绝初始化；
- 分析脚本哈希不一致；
- Broker 返回未知 Capability；
- Tool 分析与执行 ID/哈希复用；
- 权限拒绝后释放分析；
- 绝对 affectedFiles 拒绝；
- 脚本变化拒绝发送；
- 执行结果绑定不匹配拒绝。

## 可复用规则

1. 安全检查结果必须与执行输入和执行结果双向绑定。
2. 取消进程工具必须终止进程树，不能只取消等待 Promise。
3. `inspect` 创建的临时状态必须在所有结束路径释放。
4. 迟到响应是正常并发状态，不能自动升级为全通道故障。
5. 脚本语言安全分析必须覆盖语言级执行入口，而非只检查命令名。
6. 权限模式不能替代实际网络通道控制。
7. 添加 ACL 时应移除精确新增规则，禁止用旧快照覆盖整份 ACL。
