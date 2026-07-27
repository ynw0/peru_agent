import type { Capability } from "../agent-protocol.js";
import type { IdGenerator } from "../agent/id-generator.js";
import { digestValue } from "./canonical.js";
import type { CapabilityGapProposal, GapObservation } from "./types.js";

export interface GapDetectorOptions {
  readonly minimumOccurrences: number;
  readonly now?: () => string;
}

// Gap Detector 只聚合结构化失败证据，不把聊天原文或密钥写入候选提示。
export class CapabilityGapDetector {
  private readonly observations = new Map<string, GapObservation>();
  private readonly proposals = new Map<string, CapabilityGapProposal>();
  private readonly now: () => string;

  public constructor(
    private readonly ids: IdGenerator,
    private readonly options: GapDetectorOptions,
  ) {
    if (!Number.isInteger(options.minimumOccurrences) || options.minimumOccurrences < 2) {
      throw new Error("Gap Detector 最小出现次数必须至少为 2");
    }
    this.now = options.now ?? (() => new Date().toISOString());
  }

  public observe(input: Omit<GapObservation, "id" | "createdAt">): GapObservation {
    const observation: GapObservation = {
      ...input,
      outcome: normalizeText(input.outcome, "目标结果"),
      evidence: input.evidence.map(item => sanitizeEvidence(item)),
      id: this.ids.next("gap-observation"),
      createdAt: this.now(),
    };
    this.observations.set(observation.id, observation);
    this.recompute(observation.workspaceId, observation.outcome, observation.missingCapability);
    return structuredClone(observation);
  }

  public listObservations(): readonly GapObservation[] {
    return [...this.observations.values()].map(item => structuredClone(item));
  }

  public listProposals(): readonly CapabilityGapProposal[] {
    return [...this.proposals.values()]
      .sort((left, right) => right.occurrenceCount - left.occurrenceCount)
      .map(item => structuredClone(item));
  }

  private recompute(workspaceId: string, outcome: string, capability: Capability): void {
    const matches = [...this.observations.values()].filter(item =>
      item.workspaceId === workspaceId
      && normalizeSignatureText(item.outcome) === normalizeSignatureText(outcome)
      && item.missingCapability === capability);
    if (matches.length < this.options.minimumOccurrences) {
      return;
    }
    const signature = digestValue({ workspaceId, outcome: normalizeSignatureText(outcome), capability });
    const existing = this.proposals.get(signature);
    const timestamp = this.now();
    const autoForgeAllowed = capability === "workspace.read";
    const proposal: CapabilityGapProposal = {
      id: existing?.id ?? this.ids.next("capability-gap"),
      signature,
      workspaceId,
      outcome,
      requiredCapabilities: [capability],
      observationIds: matches.map(item => item.id).sort(),
      occurrenceCount: matches.length,
      suggestedKind: "tool",
      autoForgeAllowed,
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
    };
    this.proposals.set(signature, proposal);
  }
}

function normalizeText(value: string, label: string): string {
  const result = value.trim().replace(/\s+/g, " ");
  if (result === "") throw new Error(`${label}不能为空`);
  if (result.length > 500) throw new Error(`${label}不能超过 500 个字符`);
  return result;
}

function normalizeSignatureText(value: string): string {
  return value.trim().toLocaleLowerCase("en-US").replace(/\s+/g, " ");
}

function sanitizeEvidence(value: string): string {
  const text = normalizeText(value, "Gap 证据");
  if (/(api[_-]?key|token|password|secret)\s*[:=]/i.test(text)) {
    return "[REDACTED_SENSITIVE_EVIDENCE]";
  }
  return text;
}
