# Tool/Skill 自进化候选系统架构

## 目标

系统根据重复出现的 Capability Gap 生成 Tool 或 Skill 候选，并在严格隔离的候选区完成分析、验证、审核、签名和晋级。候选不能修改安全核心，也不能绕过既有 Tool Registry、PermissionEngine 或 Sandbox。

## 总体数据流

```text
Agent 失败或缺少 Capability
        ↓
Capability Gap Detector
        ↓
结构化 Gap Proposal
        ↓
Tool Forge / Skill Forge
        ↓
Candidate Registry（draft）
        ↓
静态分析 + 依赖审计
        ↓
隔离 Evaluator 结构化证明
        ↓
两个独立 Reviewer
        ↓
Ed25519 签名
        ↓
低风险：自动进入 Signed Whitelist
高权限：等待人工审批后进入 Signed Whitelist
        ↓
停用 / 回滚 / 审计
```

## 信任边界

### 不可信区域

- Forge Model 输出；
- 候选源码；
- 候选测试；
- Skill 指令；
- Gap Evidence；
- 外部 Reviewer 摘要。

### 受信任区域

- Candidate Registry 状态机；
- Static Analyzer；
- Validator；
- Signed Whitelist Trust Store；
- PermissionEngine；
- Windows Sandbox Broker；
- 生产 Tool Loader；
- 签名私钥存储。

候选不得导入或修改受信任区域代码。

## Capability Gap Detector

Gap 只聚合结构化失败证据：

```text
workspaceId
outcome
missingCapability
missingToolName
evidence
```

同一 Signature 至少出现两次才形成 Proposal。Evidence 在写入前删除敏感字段。该机制避免一次偶发错误直接触发生成。

## Forge

### Tool Forge

Tool Forge 只返回：

- Manifest；
- Source；
- Test Source；
- SDK Version。

它不获得 Tool Registry、文件系统、进程或签名私钥引用。

### Skill Forge

Skill 只组合既有 Tool Manifest 和步骤。Skill 的 Capability 是引用 Tool Capability 的并集，不允许声明额外权限。

## Static Analyzer

Static Analyzer 采用默认拒绝策略：

- 未知依赖失败；
- 动态执行失败；
- 直接网络失败；
- Node Runtime API 失败；
- 安全核心引用失败；
- 声明与观察 Capability 不一致失败。

静态分析只能作为前置门禁，不能替代真实 Sandbox。

## Validation Pipeline

Validator 本身不执行候选源码。动态结果必须来自 `CandidateSandboxEvaluator`，并绑定：

```text
candidateDigest
evaluatorId
environmentFingerprint
isolated=true
```

必需 Gate：

- unit-tests；
- property-tests；
- fuzz-tests；
- adversarial-tests；
- sandbox-dynamic；
- capability-consistency；
- reproducible-package。

此外必须有两个不同 Reviewer ID，且两者审核相同 Candidate Digest。

## 晋级策略

### 自动晋级

只允许：

- Pure Compute Tool；
- Strict Workspace Read Tool；
- 仅由上述 Tool 组成的 Skill。

自动晋级不是动态加载。它只把候选状态改为 `promoted` 并写入 Signed Whitelist。

### 人工晋级

高权限候选即使全部 Gate 通过，也进入 `awaitingManualApproval`。审批必须记录：

- Approver ID；
- Decision；
- Reason；
- Decided At。

晋级前必须重新计算当前 Candidate Digest，并与 Validation 和 Signed Artifact 同时比较。

## 签名

签名算法：Ed25519。

签名原文为 Canonical JSON：

```text
candidateDigest
validationDigest
packageDigest
signerKeyId
signedAt
```

Whitelist 条目保存所有验签字段，因此可以脱离 Candidate Registry 独立验证。

系统使用两层签名：

1. Candidate Artifact 签名证明候选和验证包未变化；
2. Whitelist Decision 签名证明 `active/disabled/rolledBack`、Promotion Mode、Capability 和时间字段未变化。

Candidate 状态和 Whitelist Decision 通过 Registry 单次原子提交，避免安全状态分裂。

私钥不会经过 IPC 或 Workbench。生产环境应改用 OS/硬件密钥提供者，而不是 PEM 字符串。

## Candidate Registry

Registry 保存：

- Candidate；
- Validation；
- Artifact；
- Manual Approval；
- Audit；
- Signed Whitelist。

JSON 实现使用串行写入、临时文件和原子 rename。读取后执行运行时结构校验。

## Typed IPC 与 Workbench

Candidate Center 只能调用状态机命令。Workbench 不获得：

- Forge Model；
- Sandbox Evaluator；
- Candidate Signer；
- 私钥；
- Tool Registry；
- 文件/进程/网络能力。

任何状态转换仍由 Evolution Runtime 校验。

## 生产化缺口

源码阶段尚缺：

- 真实 Sandbox Evaluator；
- Tool SDK 包；
- 受控 Candidate Loader；
- 密钥轮换和吊销；
- 成功率监控与自动停用；
- 真实多模型 Reviewer；
- 安全审计和供应链证明。
