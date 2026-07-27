import type { Capability, ToolRiskLevel } from "../agent-protocol.js";
import type { ToolManifest } from "../tool-runtime.js";

export type EvolutionCandidateKind = "tool" | "skill";
export type EvolutionCandidateStatus =
  | "draft"
  | "validating"
  | "validationFailed"
  | "awaitingManualApproval"
  | "promoted"
  | "disabled"
  | "rolledBack";

export type ValidationGate =
  | "manifest"
  | "static-analysis"
  | "dependency-audit"
  | "unit-tests"
  | "property-tests"
  | "fuzz-tests"
  | "adversarial-tests"
  | "sandbox-dynamic"
  | "capability-consistency"
  | "reviewer-one"
  | "reviewer-two"
  | "reproducible-package"
  | "signature";

export interface GapObservation {
  readonly id: string;
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly outcome: string;
  readonly missingCapability: Capability;
  readonly missingToolName?: string;
  readonly evidence: readonly string[];
  readonly createdAt: string;
}

export interface CapabilityGapProposal {
  readonly id: string;
  readonly signature: string;
  readonly workspaceId: string;
  readonly outcome: string;
  readonly requiredCapabilities: readonly Capability[];
  readonly observationIds: readonly string[];
  readonly occurrenceCount: number;
  readonly suggestedKind: EvolutionCandidateKind;
  readonly autoForgeAllowed: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ToolCandidatePayload {
  readonly manifest: ToolManifest;
  readonly source: string;
  readonly testSource: string;
  readonly sdkVersion: string;
}

export interface SkillStepCandidate {
  readonly id: string;
  readonly toolName: string;
  readonly instruction: string;
}

export interface SkillCandidatePayload {
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly toolManifests: readonly ToolManifest[];
  readonly steps: readonly SkillStepCandidate[];
}

export type EvolutionCandidatePayload = ToolCandidatePayload | SkillCandidatePayload;

export interface StaticAnalysisFinding {
  readonly severity: "info" | "warning" | "error";
  readonly code: string;
  readonly message: string;
  readonly line?: number;
}

export interface StaticAnalysisReport {
  readonly passed: boolean;
  readonly sourceSha256: string;
  readonly declaredCapabilities: readonly Capability[];
  readonly observedCapabilities: readonly Capability[];
  readonly findings: readonly StaticAnalysisFinding[];
}

export interface ValidationGateResult {
  readonly gate: ValidationGate;
  readonly passed: boolean;
  readonly summary: string;
  readonly evidenceSha256: string;
  readonly completedAt: string;
}

export interface ReviewerAttestation {
  readonly reviewerId: string;
  readonly approved: boolean;
  readonly summary: string;
  readonly reviewedDigest: string;
  readonly completedAt: string;
}

export interface SandboxEvaluationAttestation {
  readonly evaluatorId: string;
  readonly environmentFingerprint: string;
  readonly isolated: true;
  readonly candidateDigest: string;
  readonly gates: readonly ValidationGateResult[];
}

export interface CandidateValidationReport {
  readonly candidateId: string;
  readonly candidateDigest: string;
  readonly staticAnalysis: StaticAnalysisReport;
  readonly sandbox?: SandboxEvaluationAttestation;
  readonly reviewers: readonly ReviewerAttestation[];
  readonly gates: readonly ValidationGateResult[];
  readonly complete: boolean;
  readonly autoPromotionAllowed: boolean;
  readonly completedAt: string;
}

export interface SignedCandidateArtifact {
  readonly candidateId: string;
  readonly candidateDigest: string;
  readonly validationDigest: string;
  readonly packageDigest: string;
  readonly signerKeyId: string;
  readonly algorithm: "ed25519";
  readonly signatureBase64: string;
  readonly signedAt: string;
}

export interface ManualApproval {
  readonly approverId: string;
  readonly decision: "approved" | "rejected";
  readonly reason: string;
  readonly decidedAt: string;
}

export interface EvolutionCandidateRecord {
  readonly id: string;
  readonly kind: EvolutionCandidateKind;
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly riskLevel: ToolRiskLevel;
  readonly capabilities: readonly Capability[];
  readonly payload: EvolutionCandidatePayload;
  readonly sourceGapIds: readonly string[];
  readonly status: EvolutionCandidateStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly validation?: CandidateValidationReport;
  readonly artifact?: SignedCandidateArtifact;
  readonly manualApproval?: ManualApproval;
  readonly promotedAt?: string;
  readonly disabledAt?: string;
  readonly rollbackReason?: string;
}

export interface SignedWhitelistEntry {
  readonly candidateId: string;
  readonly kind: EvolutionCandidateKind;
  readonly name: string;
  readonly version: string;
  readonly riskLevel: ToolRiskLevel;
  readonly capabilities: readonly Capability[];
  readonly candidateDigest: string;
  readonly validationDigest: string;
  readonly packageDigest: string;
  readonly signerKeyId: string;
  readonly signatureBase64: string;
  readonly signedAt: string;
  readonly decisionSignatureBase64: string;
  readonly status: "active" | "disabled" | "rolledBack";
  readonly promotionMode: "automatic" | "manual";
  readonly activatedAt: string;
  readonly updatedAt: string;
}

export interface EvolutionAuditEntry {
  readonly id: string;
  readonly candidateId?: string;
  readonly action:
    | "gap.detected"
    | "candidate.created"
    | "validation.started"
    | "validation.completed"
    | "manual.approved"
    | "manual.rejected"
    | "candidate.promoted"
    | "candidate.disabled"
    | "candidate.rolledBack";
  readonly actor: string;
  readonly summary: string;
  readonly createdAt: string;
}

export interface ToolForgeRequest {
  readonly gap: CapabilityGapProposal;
  readonly name: string;
  readonly description: string;
  readonly riskLevel: ToolRiskLevel;
  readonly capabilities: readonly Capability[];
}

export interface SkillForgeRequest {
  readonly gap: CapabilityGapProposal;
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly toolManifests: readonly ToolManifest[];
  readonly steps: readonly SkillStepCandidate[];
}
