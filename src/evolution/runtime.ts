import type { IdGenerator } from "../agent/id-generator.js";
import type { ToolRiskLevel } from "../agent-protocol.js";
import type { ToolManifest } from "../tool-runtime.js";
import { canAutoPromoteSkill } from "../self-evolution.js";
import { canAutoPromoteTool } from "../tool-runtime.js";
import type { CandidateRegistry } from "./registry.js";
import { EvolutionAuditFactory } from "./registry.js";
import { CandidateSigner, SignedWhitelistTrustStore, digestCandidate } from "./signing.js";
import type { CandidateValidationPipeline } from "./validator.js";
import type {
  EvolutionCandidateRecord,
  ManualApproval,
  SignedWhitelistEntry,
  SkillCandidatePayload,
  ToolCandidatePayload,
} from "./types.js";

export interface EvolutionRuntimeOptions {
  readonly actorId: string;
  readonly now?: () => string;
}

// EvolutionRuntime 是候选状态机唯一入口；Candidate 不会直接进入 ToolRegistry。
export class EvolutionRuntime {
  private readonly now: () => string;
  private readonly auditFactory: EvolutionAuditFactory;

  public constructor(
    private readonly registry: CandidateRegistry,
    private readonly ids: IdGenerator,
    private readonly validator: CandidateValidationPipeline,
    private readonly signer: CandidateSigner,
    private readonly trustStore: SignedWhitelistTrustStore,
    private readonly options: EvolutionRuntimeOptions,
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.auditFactory = new EvolutionAuditFactory(ids, this.now);
  }

  public async createToolCandidate(
    payload: ToolCandidatePayload,
    sourceGapIds: readonly string[],
  ): Promise<EvolutionCandidateRecord> {
    if (!payload.manifest.generated) throw new Error("Tool Forge 候选必须标记 generated=true");
    const record = this.createRecord({
      kind: "tool",
      name: payload.manifest.name,
      version: payload.manifest.version,
      description: payload.manifest.description ?? payload.manifest.name,
      riskLevel: payload.manifest.riskLevel,
      capabilities: payload.manifest.capabilities,
      payload,
      sourceGapIds,
    });
    await this.registry.save(record);
    await this.audit(record.id, "candidate.created", `创建 Tool 候选 ${record.name}`);
    return structuredClone(record);
  }

  public async createSkillCandidate(
    payload: SkillCandidatePayload,
    sourceGapIds: readonly string[],
  ): Promise<EvolutionCandidateRecord> {
    const capabilities = [...new Set(payload.toolManifests.flatMap(item => item.capabilities))];
    const riskLevel = highestRisk(payload.toolManifests);
    const record = this.createRecord({
      kind: "skill",
      name: payload.name,
      version: payload.version,
      description: payload.description,
      riskLevel,
      capabilities,
      payload,
      sourceGapIds,
    });
    await this.registry.save(record);
    await this.audit(record.id, "candidate.created", `创建 Skill 候选 ${record.name}`);
    return structuredClone(record);
  }

  public async validate(candidateId: string, signal: AbortSignal): Promise<EvolutionCandidateRecord> {
    const candidate = await this.requireCandidate(candidateId);
    if (!["draft", "validationFailed", "disabled", "rolledBack"].includes(candidate.status)) {
      throw new Error(`候选当前状态不能重新验证：${candidate.status}`);
    }
    const validating = { ...candidate, status: "validating" as const, updatedAt: this.now() };
    await this.registry.save(validating);
    await this.audit(candidate.id, "validation.started", `开始验证 ${candidate.name}`);

    try {
      const validation = await this.validator.validate(validating, signal);
      if (!validation.complete) {
        const failed: EvolutionCandidateRecord = {
          ...validating,
          status: "validationFailed",
          validation,
          updatedAt: this.now(),
        };
        await this.registry.save(failed);
        await this.audit(candidate.id, "validation.completed", "验证未通过，候选未签名");
        return structuredClone(failed);
      }

      const artifact = this.signer.sign(validating, validation);
      if (!this.trustStore.verifyArtifact(artifact)) {
        throw new Error("候选签名不在受信任白名单内");
      }
      const automatic = validation.autoPromotionAllowed && isAutoPromotionPolicyAllowed(validating);
      const next: EvolutionCandidateRecord = {
        ...validating,
        status: automatic ? "promoted" : "awaitingManualApproval",
        validation,
        artifact,
        ...(automatic ? { promotedAt: this.now() } : {}),
        updatedAt: this.now(),
      };
      if (automatic) {
        const entry = this.createWhitelistEntry(next, "automatic");
        await this.registry.commitCandidateAndWhitelist(next, entry);
        await this.audit(candidate.id, "candidate.promoted", "低风险候选通过完整验证后自动晋级");
      } else {
        await this.registry.save(next);
        await this.audit(candidate.id, "validation.completed", "验证通过，高权限候选等待人工审批");
      }
      return structuredClone(next);
    } catch (error: unknown) {
      const failed: EvolutionCandidateRecord = {
        ...validating,
        status: "validationFailed",
        updatedAt: this.now(),
      };
      await this.registry.save(failed);
      await this.audit(candidate.id, "validation.completed", `验证异常：${errorMessage(error)}`);
      throw error;
    }
  }

  public async decideManualApproval(
    candidateId: string,
    input: Omit<ManualApproval, "decidedAt">,
  ): Promise<EvolutionCandidateRecord> {
    const candidate = await this.requireCandidate(candidateId);
    if (candidate.status !== "awaitingManualApproval" || candidate.validation?.complete !== true
      || candidate.artifact === undefined) {
      throw new Error("候选未处于人工审批状态或缺少完整验证/签名");
    }
    const approval: ManualApproval = { ...input, decidedAt: this.now() };
    if (approval.approverId.trim() === "" || approval.reason.trim() === "") {
      throw new Error("人工审批必须记录审批人和原因");
    }
    const next: EvolutionCandidateRecord = approval.decision === "approved"
      ? { ...candidate, manualApproval: approval, updatedAt: this.now() }
      : {
        ...candidate,
        status: "validationFailed",
        manualApproval: approval,
        updatedAt: this.now(),
      };
    await this.registry.save(next);
    await this.audit(
      candidate.id,
      approval.decision === "approved" ? "manual.approved" : "manual.rejected",
      `${approval.approverId}：${approval.reason}`,
      approval.approverId,
    );
    return structuredClone(next);
  }

  public async promote(candidateId: string): Promise<EvolutionCandidateRecord> {
    const candidate = await this.requireCandidate(candidateId);
    if (candidate.status !== "awaitingManualApproval" || candidate.manualApproval?.decision !== "approved") {
      throw new Error("高权限候选必须先获得明确人工批准");
    }
    if (candidate.validation?.complete !== true || candidate.artifact === undefined
      || !this.trustStore.verifyArtifact(candidate.artifact)) {
      throw new Error("候选验证或签名无效");
    }
    const currentDigest = digestCandidate(candidate);
    if (currentDigest !== candidate.validation.candidateDigest
      || currentDigest !== candidate.artifact.candidateDigest) {
      throw new Error("候选内容在验证或签名后发生变化，拒绝晋级");
    }
    const promoted: EvolutionCandidateRecord = {
      ...candidate,
      status: "promoted",
      promotedAt: this.now(),
      updatedAt: this.now(),
    };
    const entry = this.createWhitelistEntry(promoted, "manual");
    await this.registry.commitCandidateAndWhitelist(promoted, entry);
    await this.audit(candidate.id, "candidate.promoted", "人工审批后的候选已加入签名白名单");
    return structuredClone(promoted);
  }

  public async disable(candidateId: string, reason: string): Promise<EvolutionCandidateRecord> {
    const candidate = await this.requireCandidate(candidateId);
    if (candidate.status !== "promoted") throw new Error("只有已晋级候选可以停用");
    const next: EvolutionCandidateRecord = {
      ...candidate,
      status: "disabled",
      disabledAt: this.now(),
      rollbackReason: requireReason(reason),
      updatedAt: this.now(),
    };
    const entry = await this.createUpdatedWhitelistEntry(next, "disabled");
    await this.registry.commitCandidateAndWhitelist(next, entry);
    await this.audit(candidate.id, "candidate.disabled", reason);
    return structuredClone(next);
  }

  public async rollback(candidateId: string, reason: string): Promise<EvolutionCandidateRecord> {
    const candidate = await this.requireCandidate(candidateId);
    if (candidate.status !== "promoted" && candidate.status !== "disabled") {
      throw new Error("只有已晋级或已停用候选可以回滚");
    }
    const next: EvolutionCandidateRecord = {
      ...candidate,
      status: "rolledBack",
      rollbackReason: requireReason(reason),
      updatedAt: this.now(),
    };
    const entry = await this.createUpdatedWhitelistEntry(next, "rolledBack");
    await this.registry.commitCandidateAndWhitelist(next, entry);
    await this.audit(candidate.id, "candidate.rolledBack", reason);
    return structuredClone(next);
  }

  public get(candidateId: string): Promise<EvolutionCandidateRecord | undefined> { return this.registry.load(candidateId); }
  public list(): Promise<readonly EvolutionCandidateRecord[]> { return this.registry.list(); }
  public async listWhitelist(): Promise<readonly SignedWhitelistEntry[]> {
    const entries = await this.registry.listWhitelist();
    for (const entry of entries) {
      if (!this.trustStore.verifyWhitelistEntry(entry)) {
        throw new Error(`Signed Whitelist 条目验签失败：${entry.candidateId}`);
      }
    }
    return entries;
  }
  public listAudit() { return this.registry.listAudit(); }

  private createRecord(input: Omit<EvolutionCandidateRecord, "id" | "status" | "createdAt" | "updatedAt">): EvolutionCandidateRecord {
    const timestamp = this.now();
    return {
      ...input,
      capabilities: [...new Set(input.capabilities)],
      sourceGapIds: [...new Set(input.sourceGapIds)],
      id: this.ids.next("evolution-candidate"),
      status: "draft",
      createdAt: timestamp,
      updatedAt: timestamp,
    };
  }

  private createWhitelistEntry(candidate: EvolutionCandidateRecord, mode: "automatic" | "manual"): SignedWhitelistEntry {
    if (candidate.artifact === undefined || !this.trustStore.verifyArtifact(candidate.artifact)) {
      throw new Error("不能将未签名或不受信任候选加入白名单");
    }
    if (digestCandidate(candidate) !== candidate.artifact.candidateDigest
      || candidate.validation?.candidateDigest !== candidate.artifact.candidateDigest) {
      throw new Error("候选当前内容与验证/签名 Digest 不一致");
    }
    const timestamp = this.now();
    const entry = this.signer.signWhitelistEntry({
      candidateId: candidate.id,
      kind: candidate.kind,
      name: candidate.name,
      version: candidate.version,
      riskLevel: candidate.riskLevel,
      capabilities: [...candidate.capabilities],
      candidateDigest: candidate.artifact.candidateDigest,
      validationDigest: candidate.artifact.validationDigest,
      packageDigest: candidate.artifact.packageDigest,
      signerKeyId: candidate.artifact.signerKeyId,
      signatureBase64: candidate.artifact.signatureBase64,
      signedAt: candidate.artifact.signedAt,
      status: "active",
      promotionMode: mode,
      activatedAt: timestamp,
      updatedAt: timestamp,
    });
    if (!this.trustStore.verifyWhitelistEntry(entry)) throw new Error("Signed Whitelist 决策签名无效");
    return entry;
  }

  private async createUpdatedWhitelistEntry(
    candidate: EvolutionCandidateRecord,
    status: "disabled" | "rolledBack",
  ): Promise<SignedWhitelistEntry> {
    const entry = (await this.listWhitelist()).find(item => item.candidateId === candidate.id);
    if (entry === undefined) throw new Error("候选不存在签名白名单记录");
    const updated = this.signer.signWhitelistEntry({
      ...entry,
      status,
      updatedAt: this.now(),
    });
    if (!this.trustStore.verifyWhitelistEntry(updated)) throw new Error("更新后的 Signed Whitelist 决策签名无效");
    return updated;
  }

  private async requireCandidate(id: string): Promise<EvolutionCandidateRecord> {
    const candidate = await this.registry.load(id);
    if (candidate === undefined) throw new Error(`候选不存在：${id}`);
    return candidate;
  }

  private async audit(
    candidateId: string,
    action: Parameters<EvolutionAuditFactory["create"]>[0]["action"],
    summary: string,
    actor = this.options.actorId,
  ): Promise<void> {
    await this.registry.appendAudit(this.auditFactory.create({ candidateId, action, actor, summary }));
  }
}

function isAutoPromotionPolicyAllowed(candidate: EvolutionCandidateRecord): boolean {
  if (candidate.kind === "tool") {
    return "manifest" in candidate.payload && canAutoPromoteTool(candidate.payload.manifest).allowed;
  }
  return canAutoPromoteSkill({
    name: candidate.name,
    toolManifests: (candidate.payload as SkillCandidatePayload).toolManifests,
  });
}

function highestRisk(manifests: readonly ToolManifest[]): ToolRiskLevel {
  const order: readonly ToolRiskLevel[] = [
    "pure-compute", "workspace-read", "workspace-write", "process", "network", "browser", "computer-use", "security-core",
  ];
  return manifests.reduce<ToolRiskLevel>((highest, manifest) =>
    order.indexOf(manifest.riskLevel) > order.indexOf(highest) ? manifest.riskLevel : highest, "pure-compute");
}
function requireReason(value: string): string { const result = value.trim(); if (result === "") throw new Error("必须记录停用或回滚原因"); return result; }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
