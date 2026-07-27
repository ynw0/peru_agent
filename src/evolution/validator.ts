import { canAutoPromoteSkill } from "../self-evolution.js";
import { canAutoPromoteTool } from "../tool-runtime.js";
import { digestValue } from "./canonical.js";
import { digestCandidate } from "./signing.js";
import { CandidateStaticAnalyzer } from "./static-analyzer.js";
import type {
  CandidateValidationReport,
  EvolutionCandidateRecord,
  ReviewerAttestation,
  SandboxEvaluationAttestation,
  SkillCandidatePayload,
  ValidationGate,
  ValidationGateResult,
} from "./types.js";

export interface CandidateSandboxEvaluator {
  evaluate(candidate: EvolutionCandidateRecord, signal: AbortSignal): Promise<SandboxEvaluationAttestation>;
}

export interface CandidateReviewer {
  readonly reviewerId: string;
  review(candidate: EvolutionCandidateRecord, candidateDigest: string, signal: AbortSignal): Promise<ReviewerAttestation>;
}

const REQUIRED_SANDBOX_GATES: readonly ValidationGate[] = [
  "unit-tests",
  "property-tests",
  "fuzz-tests",
  "adversarial-tests",
  "sandbox-dynamic",
  "capability-consistency",
  "reproducible-package",
];

// Validator 不执行候选源码；只接受隔离 Evaluator 的结构化证明与两个独立 Reviewer。
export class CandidateValidationPipeline {
  public constructor(
    private readonly analyzer: CandidateStaticAnalyzer,
    private readonly evaluator: CandidateSandboxEvaluator,
    private readonly reviewers: readonly CandidateReviewer[],
    private readonly now: () => string = () => new Date().toISOString(),
  ) {
    if (new Set(reviewers.map(item => item.reviewerId)).size < 2) {
      throw new Error("验证流水线必须配置两个独立 Reviewer");
    }
  }

  public async validate(candidate: EvolutionCandidateRecord, signal: AbortSignal): Promise<CandidateValidationReport> {
    const candidateDigest = digestCandidate(candidate);
    const staticAnalysis = this.analyzer.analyze(candidate);
    const baseGates: ValidationGateResult[] = [
      gate("manifest", validateManifest(candidate), "Manifest 与候选类型一致", this.now()),
      gate("static-analysis", staticAnalysis.passed, staticAnalysis.passed ? "静态安全分析通过" : "静态安全分析失败", this.now()),
      gate(
        "dependency-audit",
        !staticAnalysis.findings.some(item => item.code === "UNDECLARED_DEPENDENCY" || item.code === "FORBIDDEN_NODE_IMPORT"),
        "只允许受限 Tool SDK 或无依赖候选",
        this.now(),
      ),
    ];

    if (baseGates.some(item => !item.passed)) {
      return {
        candidateId: candidate.id,
        candidateDigest,
        staticAnalysis,
        reviewers: [],
        gates: baseGates,
        complete: false,
        autoPromotionAllowed: false,
        completedAt: this.now(),
      };
    }

    const sandbox = await this.evaluator.evaluate(candidate, signal);
    validateSandboxAttestation(sandbox, candidateDigest);
    const selectedReviewers = this.reviewers.slice(0, 2);
    const reviewers = await Promise.all(selectedReviewers.map(reviewer => reviewer.review(candidate, candidateDigest, signal)));
    validateReviewers(reviewers, candidateDigest);

    const reviewerGates = reviewers.map((reviewer, index) => gate(
      index === 0 ? "reviewer-one" : "reviewer-two",
      reviewer.approved,
      reviewer.summary,
      reviewer.completedAt,
    ));
    const gates = [...baseGates, ...sandbox.gates, ...reviewerGates];
    const complete = requiredGatesPassed(gates);
    return {
      candidateId: candidate.id,
      candidateDigest,
      staticAnalysis,
      sandbox,
      reviewers,
      gates,
      complete,
      autoPromotionAllowed: complete && autoPromotionAllowed(candidate),
      completedAt: this.now(),
    };
  }
}

function validateManifest(candidate: EvolutionCandidateRecord): boolean {
  if (candidate.kind === "tool") {
    const payload = candidate.payload;
    return "manifest" in payload
      && payload.manifest.generated
      && payload.manifest.name === candidate.name
      && payload.manifest.version === candidate.version
      && payload.manifest.riskLevel === candidate.riskLevel
      && sameStrings(payload.manifest.capabilities, candidate.capabilities);
  }
  const payload = candidate.payload as SkillCandidatePayload;
  return payload.name === candidate.name && payload.version === candidate.version
    && sameStrings(payload.toolManifests.flatMap(item => item.capabilities), candidate.capabilities);
}

function autoPromotionAllowed(candidate: EvolutionCandidateRecord): boolean {
  if (candidate.kind === "tool") {
    const payload = candidate.payload;
    return "manifest" in payload && canAutoPromoteTool(payload.manifest).allowed;
  }
  return canAutoPromoteSkill({
    name: candidate.name,
    toolManifests: (candidate.payload as SkillCandidatePayload).toolManifests,
  });
}

function validateSandboxAttestation(attestation: SandboxEvaluationAttestation, candidateDigest: string): void {
  if (!attestation.isolated || attestation.candidateDigest !== candidateDigest
    || attestation.evaluatorId.trim() === "" || attestation.environmentFingerprint.trim() === "") {
    throw new Error("Sandbox Evaluator 证明无效或未绑定候选内容");
  }
  const gates = new Map(attestation.gates.map(item => [item.gate, item]));
  for (const required of REQUIRED_SANDBOX_GATES) {
    if (gates.get(required)?.passed !== true) {
      throw new Error(`Sandbox Evaluator 缺少通过的必需门禁：${required}`);
    }
  }
}

function validateReviewers(reviewers: readonly ReviewerAttestation[], digest: string): void {
  if (reviewers.length !== 2 || new Set(reviewers.map(item => item.reviewerId)).size !== 2) {
    throw new Error("必须由两个独立 Reviewer 审核");
  }
  for (const reviewer of reviewers) {
    if (reviewer.reviewedDigest !== digest) throw new Error(`Reviewer ${reviewer.reviewerId} 审核了错误候选版本`);
  }
}

function requiredGatesPassed(gates: readonly ValidationGateResult[]): boolean {
  const required: ValidationGate[] = [
    "manifest", "static-analysis", "dependency-audit", ...REQUIRED_SANDBOX_GATES,
    "reviewer-one", "reviewer-two",
  ];
  const byName = new Map(gates.map(item => [item.gate, item]));
  return required.every(item => byName.get(item)?.passed === true);
}

function gate(gateName: ValidationGate, passed: boolean, summary: string, completedAt: string): ValidationGateResult {
  return {
    gate: gateName,
    passed,
    summary,
    evidenceSha256: digestValue({ gate: gateName, passed, summary }),
    completedAt,
  };
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return JSON.stringify([...new Set(left)].sort()) === JSON.stringify([...new Set(right)].sort());
}
