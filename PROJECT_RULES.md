# 项目强制规则

## 开发流程

- 开始前检索项目中是否已有相似实现，理解后复用，不重复造轮子。
- 修改前说明影响文件；复杂任务先输出计划。
- 计划必须给出 0~100 的置信度。
- 重构时创建新分支或 Worktree，不直接修改稳定版本。
- 原始参考源码和 Code OSS 上游副本保持只读。
- 修改后运行项目已有格式、检查、测试、构建和启动命令。
- Bug 修复后总结根因，并把可复用经验补充到项目规则和 `docs/lessons`。

## 代码规则

- 所有文本和中文注释使用 UTF-8。
- 代码尽量添加简洁明了的中文注释。
- 优先删除重复逻辑，不引入不必要的抽象和依赖。
- 不在代码中硬编码密钥、令牌或密码。
- 不使用空 `catch` 吞掉错误。
- 不允许隐式 fallback、静默兜底或自动切换能力。
- 不兼容旧系统、旧测试、旧用户数据、Claude Code 配置和 SDK 协议。

## 安全规则

- 沙箱不可用或校验失败时拒绝执行。
- Computer Use 只允许操作认证应用。
- 未认证应用只允许检查截图和 UI 树，不允许交互。
- 高权限 Tool 和 Skill 不允许自动晋级。
- 纯计算和严格只读 Tool 只有通过全部验证后才能自动晋级。
- 自进化系统不能修改权限、沙箱、签名、凭据、更新和验证器。
- 网络只能通过统一 Egress Broker。
- Tool 和子 Agent 默认不能读取密钥存储。

## 平台规则

- 第一目标平台为 Windows 11 x64。
- Windows 主 Shell 为 PowerShell 7。
- 不支持 Windows PowerShell 5.1、Windows 10 和 32 位系统。
- Agent 模型与低延迟补全模型独立配置。
- 跨进程、网络、文件和插件边界的数据必须运行时校验，禁止仅用 TypeScript 类型断言信任外部输入。
- 异步请求的成功、失败、超时、中止和关闭路径必须释放相同的监听器、计时器和 Pending 状态。
- Code OSS Overlay 使用的内部模块、Codicon、Registry 和 ViewPane API 必须针对固定上游版本执行源码契约检查，不能根据其他版本推断兼容。

## Agent Runtime 规则

- Tool 必须先完成 `validate` 和 `inspect`，并在权限判断前发布受影响文件。
- 会触发外部即时响应的事件必须先登记内部 Pending 状态，再发布事件。
- EventJournal 的 sequence 分配和文件追加必须串行化，禁止并发抢号。
- 进程恢复时，无法验证仍有执行资源的 `running/awaitingPermission` 会话必须标记失败。
- 模型流必须提供明确 `finish_reason` 和 Token 用量；缺失时停止运行，不猜测和估算。
- ToolCall 参数必须是可解析 JSON，并继续经过 Tool 自身运行时校验。
- 用户中止必须同时终止模型请求、权限等待和当前 Tool 执行。

## Workspace 与 Diff 规则

- 模型文件修改工具只能生成 Diff Proposal，禁止直接写入工作区。
- `workspace.propose` 与 `workspace.write` 必须是两个独立能力。
- Diff 接受前必须一次性校验所有目标文件哈希；任一冲突则零写入。
- 文件写入必须在临时文件写完后、原子替换前再次校验目标哈希。
- 同一工作区内的接受、拒绝、恢复和文件写入必须串行化。
- 多文件写入和 Checkpoint 恢复必须保存补偿数据并提供回滚测试。
- 工作区路径必须拒绝绝对路径、盘符、UNC、`..` 和符号链接。
- Diff、Checkpoint 和其他磁盘协议文件读取后必须运行时校验。
- Git 和其他进程型工具在 Windows Sandbox Broker 完成前禁止启用。

## PowerShell 与 Windows Sandbox 规则

- PowerShell Tool 只能通过通过能力握手的 Windows Sandbox Broker 执行，禁止直接 `spawn pwsh.exe`。
- PowerShell 安全分析必须使用官方 AST，并覆盖 Cmdlet、动态调用、成员调用、类型表达式、重定向和 Provider 路径。
- 安全分析必须用 `executionId + analysisId + script SHA-256` 绑定执行请求和执行结果。
- 分析结果必须一次性使用、设置过期时间，并在权限拒绝、执行完成和异常路径释放。
- 取消进程 Tool 必须终止整个 Job Object 进程树，禁止只取消本地 Promise。
- 已取消请求的迟到响应必须隔离处理，不能连带关闭其他正常 IPC 请求。
- PowerShell Tool 不允许直接修改工作区；所有工作区修改继续使用 Diff Proposal。
- Phase 9 Egress Broker 完成前，沙箱进程不得获得 LAN 或互联网 Capability。
- AppContainer ACL 清理只能删除 Broker 自己添加的精确 ACE，禁止恢复整份 ACL 快照覆盖外部修改。
- Windows 原生 Broker 未在 Windows 11 x64 真机完成构建和红队测试前，产品构建不得启用 PowerShell Tool。

## AI IDE 交互层规则

- 所有流式更新实体必须在第一个 delta 前生成并发布稳定 ID。
- Workbench 投影必须按 `sessionId` 隔离，后台会话事件不得覆盖当前会话状态。
- 用于审计、排序和恢复的领域时间戳必须写入事件，禁止在重放时重新生成。
- 高频流式事件只能执行 O(1) 本地投影，禁止每个 delta 请求完整事件时间线。
- Workbench View 只能通过 Bridge 和 Typed IPC 发出命令，禁止直接访问文件系统、Shell、Tool 或 PermissionEngine 内部对象。
- Workbench Bridge 未连接时必须明确禁用操作并显示原因，禁止创建本地替代执行路径。
- 未知 Plan ID、ToolCall ID 或不合法状态转换必须明确失败，禁止静默创建或跳过。
- Plan UI 只能提交批准或拒绝请求，不能直接修改 PlanRecord。
- UI Snapshot 是 EventJournal 的投影，不是运行时事实来源；恢复必须从持久化会话和事件重建。
