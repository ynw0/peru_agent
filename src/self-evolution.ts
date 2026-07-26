import type { ToolManifest } from "./tool-runtime.js";
import { canAutoPromoteTool } from "./tool-runtime.js";

// Skill 可能组合多个 Tool，因此风险等级按其使用的最高权限计算。
export interface SkillCandidate {
  readonly name: string;
  readonly toolManifests: readonly ToolManifest[];
}

// 高权限 Skill 永远不能自动晋级。
export function canAutoPromoteSkill(candidate: SkillCandidate): boolean {
  if (candidate.toolManifests.length === 0) {
    return false;
  }

  return candidate.toolManifests.every(manifest => canAutoPromoteTool(manifest).allowed);
}
