import type { ReleaseGateName, ReleaseGateResult } from "./types.js";

export const REQUIRED_PRODUCTION_GATES: readonly ReleaseGateName[] = [
  "source-audit", "typescript", "unit-tests", "smoke-tests", "code-oss-compile",
  "windows-sandbox-red-team", "computer-use-red-team", "sbom", "malware-scan", "authenticode",
];

export function evaluateReleaseGates(results: readonly ReleaseGateResult[]): { readonly ready: boolean; readonly blockers: readonly ReleaseGateName[] } {
  const byName = new Map<ReleaseGateName, ReleaseGateResult>();
  for (const result of results) {
    if (byName.has(result.gate)) throw new Error(`发布门禁重复：${result.gate}`);
    if (result.evidence.trim() === "" || Number.isNaN(Date.parse(result.completedAt))) throw new Error(`发布门禁证据无效：${result.gate}`);
    byName.set(result.gate, result);
  }
  const blockers = REQUIRED_PRODUCTION_GATES.filter(gate => byName.get(gate)?.passed !== true);
  return { ready: blockers.length === 0, blockers };
}
