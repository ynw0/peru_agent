# 独立 AI IDE 最终实施计划

版本：1.0  
状态：已批准并开始执行  
目标平台：Windows 11 x64、PowerShell 7  
默认语言：中文，可切换英文  
总体置信度：91/100

## 1. 已锁定的产品决策

1. 产品形态是基于 Code OSS 的独立桌面 IDE，不先做 VS Code 插件。
2. Agent Runtime 完全自研，不使用 Claude Agent SDK。
3. 支持 OpenAI 兼容模型接口，Agent 模型和低延迟补全模型独立配置。
4. 不修改上传的 Claude Code 源码；它只作为只读架构参考。
5. 不在原 Code OSS 上游目录直接开发；建立独立产品仓库。
6. Windows 命令执行以 PowerShell 7 为主，不以 Bash 作为 Windows 主执行器。
7. 沙箱不可用、签名无效或策略无法证明安全时，拒绝执行，不静默降级。
8. 网络模式只有 `offline`、`lan`、`internet` 三种，不自动切换。
9. Computer Use 只支持经过认证的应用，不承诺操作任意 Windows 软件。
10. 高权限 Tool 和 Skill 不允许自动晋级；只能进入候选区等待显式审批。
11. 纯计算 Tool 和严格只读 Tool 通过完整验证后，才允许自动加入白名单。
12. 不兼容 Claude Code 会话、配置、工具名称、Agent SDK 协议或旧产品数据。
13. 不硬编码密钥、令牌、密码或服务凭据。
14. 用户可见文本和中文注释使用 UTF-8。
15. 不实现静默 fallback、旧系统兼容层或未声明兜底逻辑。

## 2. 产品目标

构建一套类似现代 AI IDE 的独立软件，至少具备：

- 完整代码编辑、文件浏览、Git、终端、调试和 LSP 能力；
- 多轮 Agent、计划模式、文件修改、Diff 审核、测试执行和会话恢复；
- 自研 Tool Runtime、权限系统、沙箱系统、子 Agent 和后台任务；
- OpenAI 兼容模型接口，包括本地 LM Studio、vLLM 等服务；
- 独立的低延迟 FIM 代码补全系统；
- 内置网页浏览器、联网搜索和受控 Computer Use；
- Tool Forge 与 Skill Forge 自进化候选系统；
- 中文和英文界面及回答语言；
- Windows 11 和 PowerShell 7 的优先兼容与测试。

## 3. 不复刻的 Claude Code 功能

| 不复刻内容 | 原因 |
|---|---|
| Claude Agent SDK 接口 | 运行时完全自研 |
| Anthropic 登录、订阅和计费 | 产品不绑定单一供应商 |
| Claude 专用模型和降级逻辑 | 使用统一 OpenAI 兼容 Provider |
| Ink 终端主界面 | 产品使用 Code OSS Workbench |
| Anthropic Analytics 与内部 Feature Flag | 无独立产品价值，增加隐私与依赖风险 |
| `ant-only`、内部远程服务 | 属于私有基础设施 |
| Claude Code 会话和配置格式 | 定义新的稳定协议，不兼容旧系统 |
| 任意 Windows 软件 Computer Use | 无法可靠验证目标和执行结果 |
| 高权限 Tool/Skill 自动白名单 | 无法仅靠自动测试证明长期安全 |
| 自动模型 fallback | 会掩盖真实故障和能力差异 |
| 沙箱失败后普通权限执行 | 违反安全边界 |

## 4. 总体架构

```text
Code OSS Desktop IDE
├── Editor / Explorer / SCM / Terminal / Debug / LSP
├── Agent Chat / Plan / Diff Review / Task / Permission UI
├── Completion UI / Ghost Text
└── Browser / Computer Use UI
             │ Typed IPC
             ▼
Agent Runtime
├── AgentSession / AgentLoop / EventJournal
├── ContextEngine / MemoryStore
├── ToolRuntime / PermissionEngine / TaskRuntime
├── ModelGateway / CompletionEngine
├── SubagentRuntime / WorktreeManager
├── BrowserRuntime / ComputerUseRuntime
├── NetworkPolicy / EgressBroker
└── SelfEvolution / ToolForge / SkillForge
             │
             ▼
Windows Native Brokers
├── Sandbox Broker
├── Computer Use Broker
└── Credential Broker
```

## 5. 代码模块

| 模块 | 主要职责 |
|---|---|
| `agent-protocol` | Agent 事件、会话、权限、网络模式和公共协议 |
| `agent-core` | Agent 循环、消息历史、事件日志、中断和恢复 |
| `model-gateway` | OpenAI 兼容 Chat/Responses/FIM 适配 |
| `tool-runtime` | Tool 接口、注册、校验、执行和结果映射 |
| `permission-engine` | 默认、自动审核、完全访问三种模式 |
| `network-policy` | offline、lan、internet 策略 |
| `completion-engine` | 低延迟 FIM 请求、取消、缓存和质量控制 |
| `subagent-runtime` | 子 Agent 任务、预算、深度和 Worktree 隔离 |
| `browser-runtime` | Playwright 浏览器会话、DOM、截图和下载 |
| `computer-use` | 认证应用注册、UIA 证据和动作授权 |
| `self-evolution` | Tool/Skill 候选生成、验证和晋级策略 |
| `workspace-service` | 文件、Git、LSP、Diagnostics 和项目索引 |
| `i18n` | `zh-CN` 与 `en-US` 资源 |
| `windows-sandbox-broker` | Restricted Token、AppContainer、Job Object |

## 6. 权限模式

### 6.1 默认权限 `default`

- 自动允许工作区只读操作、LSP 查询和 Git 状态。
- 文件写入、进程执行、网络、浏览器交互和 Computer Use 必须询问。
- 安全核心、密钥、系统目录和未认证应用操作直接拒绝。

### 6.2 自动审核 `autoReview`

- 只有规则能够证明安全时才允许。
- 不能证明安全时停止并报告，不弹出自动继续选项。
- 高权限 Tool/Skill 永不自动晋级。

### 6.3 完全访问 `fullAccess`

- 跳过普通操作询问。
- 仍受沙箱、签名、路径边界、认证应用列表和不可变核心限制。
- 不允许修改权限引擎、沙箱 Broker、签名系统和凭据系统。

## 7. Computer Use 认证应用制度

只有满足以下条件的应用才能进入认证列表：

1. 可通过 Windows UI Automation 稳定获得元素树；
2. 可获得稳定窗口标识、AutomationId 或可验证控件属性；
3. 每个动作可定义动作前证据和动作后预期状态；
4. 不涉及 UAC、安全桌面、密码框、支付或凭据管理；
5. 已完成版本、语言、缩放比例和 DPI 测试；
6. 已通过失败动作、窗口遮挡和焦点切换测试；
7. 认证清单带签名和应用版本范围。

第一批候选认证应用：

- 本 IDE；
- Windows 文件资源管理器；
- 记事本；
- 明确适配的标准 Win32/WPF/WinUI 企业应用。

未认证应用只允许截图和 UI 树检查，不允许点击、输入或快捷键操作。

## 8. 自进化策略

### 8.1 可自动晋级

- A 类：纯计算 Tool，无文件、网络、进程和随机副作用；
- B 类：严格工作区只读 Tool，仅能使用受限 Workspace API。

必须通过：

- TypeScript 严格编译；
- 静态安全分析；
- 无未声明依赖；
- 单元测试、属性测试、模糊测试；
- 沙箱动态测试；
- 输入输出范围检查；
- 两个独立 Reviewer 审核；
- 能力声明与实际行为一致性检查。

### 8.2 不允许自动晋级

以下 Tool/Skill 只能进入候选区：

- 文件写入或删除；
- 启动进程；
- 访问局域网或互联网；
- 浏览器点击、输入、上传和下载；
- Computer Use；
- Git 写操作；
- 调用第三方依赖；
- 修改工作流、Prompt 或子 Agent 权限。

以下能力永远禁止生成或安装：

- 修改权限引擎；
- 修改沙箱 Broker；
- 修改签名系统；
- 修改密钥存储；
- 修改自动更新器；
- 修改自进化验证器本身。

## 9. 低延迟代码补全

补全系统与 Agent Runtime 完全分离。

### 9.1 目标

- 本地固定模型首个候选 P50 小于 120ms；
- P95 小于 350ms；
- 请求取消小于 20ms；
- UI 主线程阻塞小于 8ms；
- 不支持 FIM 或取消的模型不能启用为补全模型。

### 9.2 请求上下文

- 光标前 Prefix；
- 光标后 Suffix；
- 当前函数与 Import；
- 最近编辑；
- LSP 类型和 Diagnostics；
- 项目规则摘要。

不把完整仓库直接放入补全请求。

## 10. Windows PowerShell 和沙箱

### 10.1 PowerShell

- 仅支持 PowerShell 7；
- 使用 `pwsh -NoLogo -NoProfile -NonInteractive -Command -`；
- 脚本经 stdin 传入；
- 使用 PowerShell AST 分析，不使用简单正则判断安全；
- 显式设置 UTF-8 输入输出；
- 超时或中止必须终止整个进程树。

### 10.2 Windows Sandbox Broker

组合使用：

- Restricted Token；
- AppContainer；
- Job Object；
- 文件 ACL；
- 网络 Capability；
- 签名和审计日志。

任何关键步骤失败都拒绝执行，不使用普通权限继续。

## 11. 网络模式

| 模式 | 允许范围 |
|---|---|
| `offline` | Loopback 和显式登记的本地模型端点 |
| `lan` | Loopback、显式 CIDR 和内部域名 |
| `internet` | 经统一 Egress Broker 审核的公网请求 |

所有受控进程默认没有直接 Socket 能力。浏览器、Git、包管理器和搜索均通过 Egress Broker。

## 12. 实施阶段

### Phase 0：只读审计和新仓库基线

置信度：98/100

- 建立独立仓库；
- 固化项目规则；
- 生成 Claude Code 功能映射；
- 建立 TypeScript strict 基线；
- 建立 UTF-8、测试和 CI 规则；
- 定义 Agent、Tool、Permission、Network、Computer Use 协议。

### Phase 1：Code OSS 独立产品骨架

置信度：92/100

- 导入并校验固定 Code OSS 1.74.0 归档；
- 重新命名和替换品牌；
- 删除微软产品专用配置；
- 添加 Agent Activity Bar、Chat、Task 和 Permission 容器；
- 建立 Typed IPC。

### Phase 2：真实 Code OSS Workbench 接入

置信度：92/100

- 导入并验证固定 Code OSS 1.74.0 源码；
- 应用独立产品 Overlay；
- 注册 Agent、Tasks、Permissions、Browser 原生容器；
- 验证固定版本 Workbench API 契约；
- 完整编译和桌面启动需匹配的上游依赖与 Node.js 16.14。

### Phase 3：自研 Agent Core

置信度：93/100

- AgentSession；
- AgentLoop；
- EventJournal；
- Tool Call/Result；
- 中断、恢复、最大轮次和预算；
- OpenAI 兼容 Model Gateway。

### Phase 4：工作区工具、Diff 与 Checkpoint

置信度：93/100

- Read、Write、Edit、ApplyPatch、Glob、Grep；
- 模型只生成 Diff Proposal，不直接写盘；
- Checkpoint；
- Diff 接受和拒绝；
- SHA-256 文件冲突检测；
- 多文件事务和回滚；
- Diff/Checkpoint 持久化；
- Git 进程工具在 Windows Sandbox 完成后实施；
- LSP 与 Diagnostics 在真实 Code OSS Runtime 接通后实施。

### Phase 5：PowerShell 和 Windows 沙箱

状态：TypeScript 集成与原生安全原型源码完成；Windows 11 真机构建和红队测试待执行。

置信度：90/100，需 Windows 真机安全门禁通过后最终确认。

- PowerShell AST；
- Sandbox Broker；
- 进程树管理；
- 路径、网络和凭据边界；
- 红队和逃逸测试。

### Phase 6：AI IDE 交互

状态：交互领域模型、Typed IPC Controller、事件重放和 Code OSS 原生 View Overlay 已完成；完整桌面编译、实际启动和生产 IPC Transport 待全局 Code OSS 门禁完成。

置信度：94/100

- [x] Agent Chat 状态、流式消息、Token 与发送/停止/重试；
- [x] Plan Review 状态机与批准/拒绝；
- [x] Tool 卡片、进度、风险、能力和影响范围；
- [x] 权限窗口与允许/拒绝 Typed IPC；
- [x] Diff Review、Checkpoint 和冲突状态交互；
- [x] 会话列表、事件时间线、Retry 和事件重放恢复；
- [x] Agent、Tasks、Permissions 原生 Code OSS ViewPane Overlay；
- [ ] Code OSS 完整依赖安装、Electron Workbench 编译与桌面启动；
- [ ] 主进程到独立 Agent Runtime 的生产 IPC Transport 安装。

### Phase 7：低延迟补全

状态：补全领域模型、OpenAI 兼容 FIM Provider、Typed IPC 取消、上下文和候选缓存、指标、基准框架及 Code OSS 原生 Inline Completion Overlay 已完成；真实模型和完整 Electron 性能门禁待执行。

置信度：92/100

- [x] Agent 与 Completion Provider 分离；
- [x] OpenAI 兼容 FIM Provider；
- [x] `prompt + suffix` 和显式 Token Template；
- [x] Code OSS Inline Completion Provider；
- [x] latest-wins 请求取消；
- [x] Typed IPC Cancel Message；
- [x] Prefix、Suffix 和元数据预算；
- [x] 精确文档版本上下文缓存；
- [x] TTL/LRU 候选缓存；
- [x] P50/P95、取消和接受率指标；
- [x] 性能目标评估框架；
- [x] 模型能力主动探测；
- [ ] 真实 LM Studio/vLLM/云端 FIM 模型集成测试；
- [ ] 真实硬件 P50 < 120ms、P95 < 350ms；
- [ ] 真实取消 < 20ms；
- [ ] Electron Workbench 主线程阻塞 < 8ms；
- [ ] 生产 IPC Transport 安装。

### Phase 8：子 Agent

置信度：92/100

- Planner、Explorer、Implementer、Reviewer、Tester；
- Worktree 隔离；
- 预算和深度限制；
- Patch 合并和测试。

### Phase 9：网络、搜索和浏览器

置信度：91/100

- 三种网络模式；
- Egress Broker；
- WebSearch、WebFetch；
- Playwright Chromium；
- DOM、截图、下载和动作验证。

### Phase 10：认证应用 Computer Use

置信度：90/100

- UI Automation Broker；
- 应用认证清单；
- 动作证据；
- 动作后验证；
- 未认证应用拒绝交互。

### Phase 11：Tool/Skill 自进化

置信度：低风险 Tool 91~95，高权限 Tool/Skill 不自动晋级

- Capability Gap Detector；
- Tool Forge；
- Skill Forge；
- Validator；
- Candidate Registry；
- Signed Whitelist；
- 停用与回滚机制。

### Phase 12：发布和本地化

置信度：92/100

- 中文、英文；
- Windows 安装包；
- 代码签名；
- 原子更新；
- E2E 和安全审计。

## 13. 每次修改的强制流程

1. 检索项目内相似实现；
2. 说明复用内容和不复用原因；
3. 列出影响文件；
4. 复杂任务输出计划和置信度；
5. 在新分支或 Worktree 修改；
6. 使用 UTF-8；
7. 删除重复逻辑；
8. 不引入无必要依赖和抽象；
9. 运行格式、Lint、TypeScript、测试、构建和启动；
10. Bug 修复总结根因；
11. 将可复用经验写入 `docs/lessons` 和 `PROJECT_RULES.md`。

## 14. 合并门禁

任何变更必须同时通过：

- Format；
- ESLint；
- TypeScript strict；
- Unit Test；
- Integration Test；
- Security Test；
- PowerShell Test；
- Network Policy Test；
- Completion Benchmark；
- Agent E2E；
- IDE Smoke Test。

禁止合并：

- 硬编码密钥；
- 静默 fallback；
- 未声明网络；
- 未受控进程；
- 越界文件访问；
- 高权限 Tool/Skill 自动晋级；
- 未认证应用 Computer Use；
- 吞掉错误的空 `catch`；
- 无法取消的后台任务。

## 15. 第一版验收标准

1. 独立 Code OSS IDE 能安装和启动；
2. OpenAI 兼容模型可配置；
3. Agent 能执行多文件开发任务；
4. 修改前展示影响文件和计划；
5. Diff 可逐文件接受和拒绝；
6. 支持 PowerShell 7；
7. Shell 必须在 Windows 沙箱运行；
8. 支持三种权限模式；
9. 支持三种网络模式；
10. 支持子 Agent 和后台任务；
11. 支持搜索、内置浏览器和网页操作；
12. Computer Use 仅限认证应用；
13. 支持低延迟行内补全；
14. 支持中文和英文；
15. 支持 Checkpoint；
16. 支持候选 Tool/Skill 生成；
17. 高权限 Tool/Skill 不允许自动晋级；
18. 不依赖 Claude Agent SDK；
19. 不包含 Claude Code 源码；
20. 不存在静默 fallback。

## 16. 当前执行状态

- [x] Phase 0：独立仓库、项目规则、安全策略和 TypeScript 基线；
- [x] Phase 1：独立产品身份、Typed IPC 和 Workbench 容器设计；
- [x] Phase 2：Code OSS 1.74.0 固定归档导入、Overlay 应用和 API 契约校验；
- [x] Phase 3：自研 AgentSession、AgentLoop、EventJournal、OpenAI 兼容流与 Tool 循环；
- [x] Phase 4：Workspace 工具、Diff Proposal、Checkpoint、冲突检测和事务回滚；
- [x] Phase 5：PowerShell AST、Broker 协议和 Windows 原生安全原型源码；
- [x] Phase 6：Agent Chat、Plan、Tool、Permission、Diff、Checkpoint、Session 的交互领域模型、Typed IPC 与 Code OSS View Overlay；
- [ ] 全局门禁：安装 Code OSS 锁定依赖并完成 Electron Workbench 编译与桌面启动；
- [ ] 全局门禁：在 Windows 11 x64 编译并红队验证 Windows Sandbox Broker；
- [ ] 全局门禁：安装主进程到独立 Agent Runtime 的生产 IPC Transport；
- [x] Phase 7：低延迟 FIM 代码补全 Runtime、缓存、取消、指标和 Code OSS Inline Completion Overlay；
- [ ] Phase 8：子 Agent；
- [ ] Phase 9：网络、搜索和浏览器；
- [ ] Phase 10：认证应用 Computer Use、自进化、发布与强化。
