# Phase 11 执行报告：Tool/Skill 自进化候选系统

## 结论

Phase 11 已完成 Capability Gap Detector、Tool Forge、Skill Forge、Candidate Registry、保守静态分析、隔离验证证明、双 Reviewer、Ed25519 签名、Signed Whitelist、自动/人工晋级状态机、停用与回滚、Typed IPC 和 Code OSS Candidate Center。

本阶段严格维持两条已锁定规则：

- 只有纯计算 Tool 和严格 `workspace.read` Tool，经过全部验证后可以自动进入签名白名单；
- 任何写文件、进程、网络、浏览器、Computer Use、安全核心或凭据相关 Tool/Skill，即使验证全部通过，也只能等待人工审批。

候选源码不会在主 Runtime 中 `eval`、动态导入或直接注册到 Tool Registry。验证流水线只接受隔离 Evaluator 的结构化证明；“晋级”表示进入可独立验签的 Signed Whitelist，不表示在主进程内立即加载候选代码。

## 完成内容

### Capability Gap Detector

实现结构化 Gap 观测和聚合：

- 同一工作区、目标结果和缺失 Capability 至少重复出现两次才形成 Proposal；
- Gap Evidence 会清理 API Key、Token、Password 和 Secret；
- 不把聊天原文和敏感凭据直接送入 Forge；
- 只有 `workspace.read` Gap 可以标记为自动 Forge 候选；其他 Capability 必须人工决策。

### Tool Forge 与 Skill Forge

Tool Forge：

- 只调用结构化 Forge Model 生成候选源码、测试和 SDK 版本；
- 输出 `generated=true` 的候选 Manifest；
- 不注册、不执行、不加载生成源码；
- 声明能力必须覆盖 Gap 所需能力。

Skill Forge：

- 只组合已有 Tool Manifest；
- 步骤只能引用已声明 Tool；
- 不复制 Tool 实现；
- 不扩大引用 Tool 的 Capability。

### Candidate Registry

实现：

- `InMemoryCandidateRegistry`；
- `JsonCandidateRegistry`；
- 原子临时文件加 `rename`；
- 串行 mutation queue；
- Candidate、Audit 和 Signed Whitelist 持久化；
- 损坏 JSON 明确失败；
- 候选状态转换白名单。

候选状态：

```text
draft
→ validating
→ validationFailed / awaitingManualApproval / promoted
→ disabled / rolledBack
```

非法跳转会被拒绝。

### 保守静态分析

Tool 候选只允许无依赖或 `@independent-ai-ide/tool-sdk`，并拒绝：

- `eval`、`Function`、动态 `import()`、`require()`；
- Node.js 文件、进程、网络、VM、Worker 和模块 API；
- Fetch、XMLHttpRequest、WebSocket；
- Deno、Bun、WebAssembly；
- `@ts-ignore`、`@ts-nocheck`；
- Prototype 和 Global mutation；
- 权限、沙箱、签名、凭据、更新器和 Windows Broker 等安全核心引用；
- 未声明 Capability；
- 缺少 `defineTool()`；
- 缺少测试入口。

纯计算 Tool 不得导入 SDK 或访问工作区。严格只读 Tool 只能声明和使用 `workspace.read`。

### 验证流水线

完整验证要求：

- Manifest 一致性；
- 静态分析；
- 依赖审计；
- 单元测试；
- 属性测试；
- Fuzz Test；
- 对抗测试；
- 隔离动态测试；
- Capability 一致性；
- 可复现包；
- 两个独立 Reviewer。

主 Runtime 不执行候选源码。`CandidateSandboxEvaluator` 必须返回：

- `isolated=true`；
- 精确 Candidate Digest；
- Evaluator ID；
- Environment Fingerprint；
- 全部必需 Gate 的结构化证明。

两个 Reviewer 必须使用不同 Reviewer ID，并审核完全相同的 Candidate Digest。

### Ed25519 签名和独立验签

签名绑定：

```text
Candidate Digest
+ Validation Digest
+ Package Digest
+ Signer Key ID
+ Signed At
```

Signed Whitelist 保存独立验签所需全部字段，不依赖 Candidate Registry 即可使用公钥验证。除 Candidate Artifact 签名外，Whitelist 的 `active/disabled/rolledBack`、Promotion Mode、Capability 和更新时间还使用第二个 Ed25519 决策签名，状态篡改会导致验签失败。

私钥：

- 只在 Runtime 构造时注入；
- 不进入 Typed IPC；
- 不进入 Workbench Snapshot；
- 不进入 Candidate Registry；
- 不写入项目配置。

### 晋级边界

自动晋级只允许：

- `pure-compute` Tool；
- 严格 `workspace-read` Tool；
- 只包含上述低风险 Tool 的 Skill；
- 且全部验证、双 Reviewer 和签名通过。

高权限候选：

```text
完整验证
→ 签名
→ awaitingManualApproval
→ 人工批准并记录审批人/原因
→ 再次比较当前候选、验证报告和签名 Artifact Digest
→ 加入 Signed Whitelist
```

任何候选内容在验证或签名后变化，晋级都会失败。

### 原子晋级、停用与回滚

Candidate 状态和 Signed Whitelist 条目使用 Registry 单次原子提交。若持久化失败，不会留下 `promoted + 无白名单` 或 `disabled + active 白名单` 的分裂状态。

已晋级候选可以：

- `disabled`：暂停使用并更新白名单；
- `rolledBack`：回滚并更新白名单；
- 记录原因、操作者和审计事件。

### Typed IPC 和 Candidate Center

IPC 协议升级到 Version 7，新增：

```text
evolution.gaps.list
evolution.candidates.list
evolution.candidate.get
evolution.candidate.validate
evolution.candidate.approve
evolution.candidate.promote
evolution.candidate.disable
evolution.candidate.rollback
evolution.whitelist.list
evolution.audit.list
```

Code OSS 新增第六个 Workbench 容器：

```text
independentAiIde.evolution
```

Candidate Center 可以查看：

- Gap Proposal；
- 候选状态；
- Validation Gate；
- Reviewer 结果；
- 人工审批；
- 晋级、停用和回滚；
- Signed Whitelist。

Workbench 只通过 Bridge 和 Typed IPC 请求状态转换，不持有签名私钥、候选执行能力、文件、进程或网络能力。

## 关键修复

1. 历史 Phase 10 测试把 IPC Version 6 写死，合法升级到 Version 7 被误判；改为验证最低版本和必需方法。
2. 人工晋级最初只验证旧签名，没有重新计算当前候选 Digest；现强制 Candidate、Validation 和 Artifact 三方一致。
3. Signed Whitelist 最初缺少 Candidate Digest、Validation Digest 和 Signed At，无法脱离 Registry 独立验签；现已补齐。
4. Computer Use View 已注册但缺少 `switch` 渲染分支，实际会显示空白；现已修复，并增加所有 ViewKind 必须可渲染的契约测试。
5. Evolution 源码审计最初会因注释中提及 `ToolRegistry` 误报；现只检测真实 import、实例化和注册调用。
6. `import.meta.dirname` 不兼容较旧 Node.js；源码验证脚本改用 `fileURLToPath(import.meta.url)`。
7. Candidate Artifact 签名没有覆盖 Whitelist 激活状态；现增加独立决策签名，状态、Capability 和 Promotion Mode 篡改都会失败。
8. Candidate 与 Whitelist 分两次保存可能产生安全状态分裂；现改为单次原子提交并增加故障测试。

## 验证结果

```text
npm run audit                   → 通过
npm run check                   → 通过
npm test                        → 146 passed
npm run build                   → 通过
npm run smoke                   → Phase 0～11 全部通过
npm run evolution:verify-source → 通过
npm run code-oss:check-overlay  → 通过
npm run code-oss:verify-applied → 通过
```

Phase 11 Overlay 已从原始 `code-main.zip` 重新导入后应用到固定 Code OSS 1.74.0，不是基于已修改的旧上游目录叠加验证。

## 未完成门禁

以下不宣称完成：

- 真实隔离 Candidate Sandbox Evaluator；
- 候选源码在 Windows Sandbox 中的动态运行；
- Tool SDK 正式包和版本兼容策略；
- 真实 Forge Model 端点接入；
- Gap Detector 与生产 Agent 失败遥测自动接线；
- 多模型 Reviewer 的真实独立性验证；
- HSM、Windows Credential Manager 或企业密钥服务中的生产私钥；
- 签名密钥轮换、吊销列表和离线根信任；
- Signed Whitelist 到生产 Tool Loader 的受控加载链；
- 候选成功率、误报率和自动停用监控；
- 第三方安全审计。

因此当前“自动晋级”准确含义是：通过完整模拟/结构化验证后进入可验签白名单状态机。真实候选代码仍不会在产品主进程内自动执行。

## Code OSS 完整编译

已真实执行：

```text
npm run compile
```

仍在构建工具加载前失败：

```text
Cannot find module './node_modules/gulp/bin/gulp.js'
```

当前环境：

- Node.js 22.16.0；
- Yarn 未安装；
- `node_modules` 不存在；
- Code OSS 1.74.0 要求 Node.js 16.14.x 和 Yarn 1。

详情见 `PHASE11_CODE_OSS_BUILD_LOG.txt`。该错误不是 Candidate Center Overlay TypeScript 编译错误，因为完整构建尚未进入 Workbench 编译阶段。
