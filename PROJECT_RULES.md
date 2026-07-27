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

## FIM 补全规则

- Agent 模型与补全模型必须独立配置、独立 Provider 和独立预算，禁止共用长任务请求队列。
- 补全模型必须同时支持 FIM、流式和 AbortSignal 取消；主动探测失败时禁止启用。
- Provider 声明的 Capability 必须与主动探测结果完全一致，禁止根据模型名称猜测能力。
- FIM 请求格式必须显式选择 `prompt + suffix` 或 Token Template，禁止静默互相回退。
- 同一文档补全必须使用 latest-wins，新请求启动时终止旧请求。
- UI/IPC 取消必须传播到 Server Handler 和模型 HTTP 请求，禁止只删除客户端 Promise。
- Prefix、Suffix 和所有元数据必须分别受预算控制，禁止把完整仓库或完整大文件放入补全请求。
- LSP、Diagnostics 和最近编辑缓存必须绑定精确文档版本，版本变化立即失效。
- Workbench 侧上下文提取必须限制行数和字符数，禁止在主线程读取完整大文件。
- 候选缓存必须设置 TTL 和容量上限，并包含 Provider、Prefix、Suffix、语言和元数据哈希。
- 补全接受指标必须按已交付 `requestId` 幂等记录，未知请求和重复事件不得污染接受率。
- FIM 控制 Token、代码围栏、非法控制字符和与 Prefix/Suffix 重复的候选必须过滤。
- 未通过真实模型和真实硬件基准前，不得宣称达到 P50、P95、取消或主线程延迟目标。

## 子 Agent 规则

- Planner、Explorer 和 Reviewer 必须只读；Implementer 只能在隔离工作区写入；Tester 不得继承父 Agent 权限。
- 子 Agent Capability 必须同时限制模型可见 Tool、静态 Manifest、实际执行和 `inspect()` 动态能力。
- 调度器选中任务时必须原子登记全局槽位、父会话槽位和 `AbortController`，之后才能执行异步准备工作。
- 父会话取消必须覆盖尚未 `start()`、排队、调度准备中和运行中的全部子任务。
- 同一 queued 任务重复 `start()` 必须幂等，禁止重复创建工作区或执行模型。
- 隔离工作区必须限制允许路径、可写路径、文件数、总字节数，并绑定确定性根目录和 Workspace ID。
- Reviewer 和 Tester 必须审核 Implementer 的精确隔离结果，禁止重新从父工作区创建无修改副本。
- Implementer 结果必须同时通过 Reviewer 和 Tester，之后只能生成父工作区 Diff Proposal；用户接受前禁止写入父工作区。
- 生成 Patch 前必须比较父工作区当前哈希与隔离基线，任一变化都停止合并。
- queued/running 恢复时必须明确标记中断失败；持久化校验应允许可安全收敛的崩溃窗口中间状态。
- 清理隔离目录后必须同时移除持久化 Worktree 引用，禁止重启时恢复失效路径。
- Git Worktree 和 Git Tool 在 Windows Sandbox Broker 真机门禁完成前禁止启用，快照式隔离不得冒充 Git Worktree。


## Egress、Web 与 Browser 规则

- 所有 WebSearch、WebFetch、下载和 Browser HTTP/HTTPS 资源必须通过统一 Egress Broker，禁止 Tool、View 或 Driver 直接联网。
- 网络授权必须校验规范 URL、端口和 DNS 返回的全部地址；混合公网/私网、Loopback、链路本地、元数据和保留地址必须拒绝。
- Egress 授权必须一次性、短时有效并绑定 URL 哈希和已审核 IP；传输阶段禁止重新 DNS 解析。
- 每个 HTTP 重定向必须重新审核；跨源时必须删除 Authorization、Cookie 和其他认证凭据。
- IPv6 字面量在地址分类、Socket 和代理校验前必须去除 URL 方括号并规范化。
- 响应大小、超时和取消只能结算一次；销毁流时禁止再次注入 Error 造成未处理异常。
- WebFetch 必须分离 HTML 标题和正文，并在正文预算前删除 head、script、style、noscript 和注释。
- WebSearch 必须使用显式配置和验证过的 Provider；Provider 缺失或响应不合法时明确失败，禁止切换搜索源。
- 远端下载只能写入产品管理的 Artifact 根目录；文件名必须清理，使用临时文件和原子 rename，禁止自动执行或解压。
- Browser Driver 必须声明并实际使用 Broker Proxy；本机 URL 不能作为代理身份证明，启动 Chromium 前必须完成固定协议能力握手。
- Browser 会话必须使用独立 AbortController，禁止复用一次 IPC 请求的取消信号作为长期会话生命周期。
- DOM 动作必须绑定 Snapshot ID、元素 ID、role、accessible name 和 disabled 证据，并在动作前复核、动作后返回新证据。
- Workbench Browser View 只能通过 Bridge 和 Typed IPC 操作，禁止导入文件系统、进程、Fetch、XMLHttpRequest 或 WebSocket。
- 真实 Browser Proxy、Playwright 和 Chromium E2E 未通过前，产品不得宣称浏览器可以安全联网。

## 认证应用 Computer Use 规则

- 可执行文件名和窗口标题不能作为应用认证身份；必须绑定绝对路径、Publisher、Signer Thumbprint、精确文件 SHA-256、完整版本正则和 Window Class。
- 未认证应用只允许列出窗口、读取 UI Tree 和截图，任何点击、输入或快捷键必须明确拒绝。
- Secure Desktop、UAC、Windows Security、凭据窗口以及高、System 或未知完整性进程禁止交互。
- HWND 必须在动作准备、执行前和执行后重新绑定 PID 与完整应用身份，禁止假设窗口句柄永久有效。
- UI 元素动作必须绑定 Snapshot ID/SHA、Runtime ID、Role、Name、Automation ID、Class 和 Bounds，禁止使用元素序号作为证据。
- 所有跨进程坐标必须是有限数字，Width 和 Height 必须非负。
- Password 元素和名称、Automation ID 命中密码、Token、API Key 等敏感词的元素禁止输入。
- Click 必须使用 Invoke、Selection 或 Toggle Pattern；Type 必须使用 Value Pattern；快捷键必须同时通过应用清单和 Broker 固定白名单。
- Prepared Computer Action 必须一次性、短时有效并绑定应用身份、Manifest Hash 和 Snapshot；重复、过期或身份变化必须拒绝。
- 输入明文只能短暂保存在 Runtime 内存；事件、权限卡片、持久化记录和审计只能保存文本哈希，并在拒绝、过期、失败和完成路径清理明文。
- Workbench 和普通 Typed IPC 不得暴露直接 Computer Use 执行接口；交互只能由声明 `computer.interact` 的 Agent Tool 经 PermissionCoordinator 发起。
- Windows Broker 必须在动作前独立重验应用和元素证据，并在动作后返回新 Snapshot；Runtime 必须再次认证应用。
- 同步动作准备方法禁止 fire-and-forget 异步事件；监听器错误必须可由调用栈观察或由显式调度器处理。
- Windows UI Automation Broker 未在 Windows 11 x64 完成编译、真实应用兼容性和红队测试前，产品不得启用 Computer Use 交互。
- 历史阶段的源码契约应验证协议最低版本和必需方法，禁止固定旧 `IPC_PROTOCOL_VERSION` 文本阻止后续合法升级。

## Tool/Skill 自进化规则

- Capability Gap 必须基于重复的结构化证据，单次失败不得自动触发 Forge；Evidence 写入前必须清理密钥、Token、密码和 Secret。
- Forge 只能生成候选包，禁止获得 Tool Registry、PermissionEngine、签名私钥或候选执行能力。
- Skill 只能组合已有 Tool Manifest，Capability 必须等于引用 Tool 能力并集，禁止权限扩张。
- 候选只能依赖受限 Tool SDK 或无依赖；未知依赖、动态执行、直接网络、Node Runtime API 和安全核心引用必须失败。
- 静态分析是前置门禁，不得冒充沙箱；动态测试必须由隔离 Evaluator 执行并返回绑定精确 Candidate Digest 的结构化证明。
- 完整验证必须包含单元、属性、Fuzz、对抗、隔离动态、Capability 一致性、可复现包和两个独立 Reviewer。
- 两个 Reviewer 必须使用不同身份并审核相同 Candidate Digest。
- 只有纯计算 Tool、严格 `workspace.read` Tool 以及只包含这些 Tool 的 Skill 可以自动晋级。
- 写文件、进程、网络、浏览器、Computer Use、凭据、安全核心等高权限 Tool/Skill 永远需要人工审批。
- 人工审批必须记录审批人、决定和原因，禁止匿名或空理由批准。
- 候选签名必须绑定 Candidate Digest、Validation Digest、Package Digest、Signer Key ID 和 Signed At。
- 晋级时必须重新计算当前 Candidate Digest，并同时匹配 Validation 和 Signed Artifact；旧签名不得授权修改后的候选。
- Signed Whitelist 必须包含独立验签所需全部字段，不能依赖 Candidate Registry 才能验证。
- Candidate Artifact 签名和 Whitelist Decision 签名必须分离；白名单状态、Promotion Mode、Capability 和时间字段必须纳入决策签名。
- Candidate 状态与 Signed Whitelist 必须单次原子提交，禁止先后写入造成 `promoted/active`、`disabled/active` 等状态分裂。
- 晋级只表示进入签名白名单，禁止在主进程中 `eval`、动态导入或自动注册候选代码。
- 签名私钥不得进入 Typed IPC、Workbench、Candidate Registry、日志或普通配置文件。
- Candidate Center 只能通过 Typed IPC 请求状态转换，禁止直接访问文件、进程、网络、签名器或候选执行对象。
- 停用和回滚必须同步 Signed Whitelist 并写入不可省略的审计原因。
- 历史 IPC 契约必须验证最低支持版本和必需方法，禁止写死旧版本阻止合法升级。
- 每个注册的 Workbench ViewKind 必须有渲染分支和契约测试；注册成功不得被视为界面可用。
- 源码安全审计应匹配真实 import、实例化或调用行为，禁止仅因注释提及敏感类型产生误报。
- 真实隔离 Evaluator、生产 Loader、密钥轮换和第三方审计完成前，不得宣称自进化候选可安全自动执行。
