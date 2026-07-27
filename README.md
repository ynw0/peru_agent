# Independent AI IDE

完全自研 Agent Runtime、基于 Code OSS 的独立 AI IDE。Claude Code 源码仅作为只读架构参考，不参与产品构建。

## 当前完成状态

- Phase 0：安全规则、协议和 TypeScript strict 基线；
- Phase 1：独立产品身份、Typed IPC 和 Workbench 容器；
- Phase 2：Code OSS 1.74.0 真实源码 Overlay 接入；
- Phase 3：自研 Agent Core、OpenAI 兼容流协议和 Tool 循环；
- Phase 4：Workspace、Diff、Checkpoint 和安全文件修改链；
- Phase 5：PowerShell AST、Windows Sandbox Broker 协议和原生安全原型源码；
- Phase 6：Agent Chat、Plan、Tool、Permission、Diff、Checkpoint、Session 的交互层与 Code OSS 原生 View Overlay；
- Phase 7：独立 FIM Completion Runtime、缓存、跨 IPC 取消、性能指标和 Code OSS 原生 Inline Completion Provider；
- Phase 8：子 Agent 调度、预算、快照隔离、父子取消、Reviewer/Tester 门禁和 Patch 合并；
- Phase 9：统一 Egress、WebSearch、WebFetch、受控下载和 Browser Runtime 核心。
- Phase 10：认证应用 Computer Use、UI Tree、动作证据、权限 Tool、Typed IPC、Workbench View 和 Windows UI Automation Broker 原型；
- Phase 11：Capability Gap、Tool/Skill Forge、验证流水线、Ed25519 签名白名单、人工审批、停用和回滚；
- Phase 12：中英文本地化、Ed25519 发布清单、SPDX SBOM、原子更新、Release Center 和 Windows 发布门禁。

Agent Core 已支持：

- 会话、消息和事件持久化；
- 模型流式文本；
- ToolCall 增量拼装；
- Tool Registry、权限询问和 Tool Result 回灌；
- 最大轮次、ToolCall 和 Token 预算；
- 用户取消；
- 中断会话恢复；
- Typed IPC 创建、启动、中止和读取会话；
- Read、Write、Edit、ApplyPatch、Glob 和 Grep；
- Diff Proposal 接受/拒绝、SHA-256 冲突检测和 Checkpoint 恢复；
- Agent Chat 流式消息、Token 和 Tool 卡片；
- Plan Review、权限交互、Diff/Checkpoint 操作；
- 会话列表、事件时间线、Retry 和按 Session 的事件重放；
- WorkbenchController 只通过 Typed IPC 调用运行时；
- OpenAI 兼容 FIM `prompt + suffix` 与显式 Token Template；
- latest-wins 补全取消、版本化上下文缓存和 TTL/LRU 候选缓存；
- Code OSS 原生 Inline Completion、Ghost Text 和接受率回传；
- 首 Token/总延迟 P50/P95、取消、缓存命中和接受率指标；
- Planner、Explorer、Implementer、Reviewer、Tester 子 Agent；
- 子 Agent 并发、深度、Token、ToolCall 和时长预算；
- 快照式隔离工作区、父会话取消和中断恢复；
- Reviewer + Tester 双门禁与父工作区 Diff Proposal 合并；
- Egress URL/DNS/地址/重定向审核与固定 IP 传输；
- WebFetch、SearXNG WebSearch 和受控 Artifact 下载；
- Browser Runtime、DOM Snapshot、截图、元素证据和 Code OSS Browser View。
- 认证应用清单、窗口/进程/签名/文件哈希绑定；
- 未认证应用只读检查、认证应用一次性点击/输入/快捷键动作；
- Computer Use Agent Tool 权限链、审计和动作后重新认证；
- Code OSS Computer Use View 和 Windows UI Automation Broker C# 原型源码；
- Capability Gap 聚合和敏感证据清理；
- Tool/Skill 候选 Forge、Candidate Registry 和状态机；
- 静态分析、隔离证明、双 Reviewer 和完整 Validation Gate；
- Ed25519 Candidate Artifact、Whitelist Decision 签名、可独立验签 Signed Whitelist；
- 低风险自动晋级、高权限人工审批、停用和回滚；
- Code OSS Candidate Center 和 Evolution Typed IPC；
- `zh-CN` / `en-US` 严格本地化资源；
- Ed25519 Release Manifest、SPDX 2.3 SBOM 和文件级 SHA-256；
- A/B 版本目录、普通更新禁止降级、显式回滚；
- Code OSS Release Center 与 Windows Authenticode 构建/安装门禁。

## 尚未完成

- Code OSS 完整依赖安装、Electron Workbench 编译和桌面启动；
- 主进程到独立 Agent Runtime 的生产 IPC Transport；
- 真实 Git Worktree、Git、LSP 和 Diagnostics 工具；
- Windows Sandbox Broker 的 Windows 11 真机构建、运行和红队验证；
- 真实 Browser Egress Proxy和 Playwright/Chromium E2E；
- Windows UI Automation Broker 的 Windows 11 编译、真实应用兼容性和红队验证；
- 第一批认证应用清单签署；
- 真实 LM Studio/vLLM FIM 端点及补全性能门禁；
- 对真实 LM Studio、vLLM 或云端模型服务的联网集成测试；
- 真实 Candidate Sandbox Evaluator、Tool SDK、Signed Candidate Loader 和生产密钥托管；
- Node.js 16.14.x、Yarn 1.x 和 Code OSS 锁定依赖下的完整 Electron 编译；
- Windows Authenticode 真签名、恶意软件扫描、安装/更新 E2E 和第三方安全审计。

## 核心项目门禁

```powershell
npm run audit
npm run check
npm test
npm run build
npm run smoke
```

## Code OSS 基线

固定为用户提供的 Code OSS `1.74.0` 归档。归档哈希、版本、许可证、关键文件或 Overlay 锚点任一不匹配都会失败。

## 重要文档

- `FINAL_PLAN.md`：总体计划；
- `PROJECT_RULES.md`：强制开发和安全规则；
- `PHASE4_REPORT.md`：Workspace、Diff 与 Checkpoint 执行报告；
- `PHASE5_REPORT.md`：PowerShell 与 Windows Sandbox Broker 执行报告；
- `PHASE6_REPORT.md`：AI IDE 交互层执行报告；
- `PHASE7_REPORT.md`：低延迟 FIM 补全执行报告；
- `PHASE8_REPORT.md`：子 Agent 调度、隔离与 Patch 合并执行报告；
- `PHASE8_CODE_OSS_BUILD_LOG.txt`：Phase 8 Code OSS 完整编译失败记录；
- `PHASE9_REPORT.md`：Egress、Web 与 Browser Runtime 执行报告；
- `PHASE9_BROWSER_RUNTIME_LOG.txt`：真实 Playwright/Proxy 缺失门禁记录；
- `PHASE9_CODE_OSS_BUILD_LOG.txt`：Phase 9 Code OSS 完整编译失败记录；
- `PHASE10_REPORT.md`：认证应用 Computer Use 执行报告；
- `PHASE10_WINDOWS_BUILD_LOG.txt`：Windows UI Automation Broker 构建门禁日志；
- `PHASE10_CODE_OSS_BUILD_LOG.txt`：Phase 10 Code OSS 完整编译门禁日志；
- `PHASE11_REPORT.md`：Tool/Skill 自进化候选系统执行报告；
- `PHASE11_CODE_OSS_BUILD_LOG.txt`：Phase 11 Code OSS 完整编译门禁日志；
- `PHASE12_REPORT.md`：发布、本地化和原子更新执行报告；
- `PHASE12_CODE_OSS_BUILD_LOG.txt`：Phase 12 Code OSS 完整编译门禁日志；
- `PHASE12_WINDOWS_RELEASE_LOG.txt`：Windows 发布构建门禁日志；
- `docs/architecture/release-localization-and-update.md`：发布签名、本地化和原子更新架构；
- `docs/architecture/agent-core.md`：Agent Core 架构；
- `docs/architecture/workspace-diff-checkpoint.md`：安全文件修改链；
- `docs/architecture/powershell-windows-sandbox.md`：PowerShell 与 Windows 原生沙箱架构；
- `docs/architecture/ai-ide-interaction.md`：Agent Chat、Plan、Permission、Diff 与会话交互架构；
- `docs/architecture/low-latency-fim-completion.md`：FIM 补全、取消、缓存和指标架构；
- `docs/architecture/subagent-scheduler-and-isolation.md`：子 Agent 调度、隔离与合并架构；
- `docs/architecture/egress-web-browser.md`：Egress、Web、下载和 Browser Runtime 架构；
- `docs/architecture/certified-computer-use.md`：认证应用、UI Automation、动作证据和权限边界；
- `docs/architecture/tool-skill-evolution.md`：Capability Gap、Forge、验证、签名白名单和晋级架构；
- `docs/lessons/2026-07-26-agent-runtime-ordering-and-recovery.md`：本阶段根因经验。
