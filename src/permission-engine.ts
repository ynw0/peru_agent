import type { Capability, PermissionMode } from "./agent-protocol.js";

export type PermissionDecision = "allow" | "ask" | "deny";

const ALWAYS_DENIED: ReadonlySet<Capability> = new Set([
  "computer.interact",
]);

// 这里只实现 Phase 0 的基础规则；后续必须结合 Tool Inspection 和沙箱证据。
export function decidePermission(
  mode: PermissionMode,
  capability: Capability,
  certifiedComputerApplication: boolean,
): PermissionDecision {
  if (capability === "computer.interact" && !certifiedComputerApplication) {
    return "deny";
  }

  if (mode === "fullAccess") {
    return "allow";
  }

  if (mode === "autoReview") {
    return capability === "workspace.read" || capability === "workspace.propose" || capability === "computer.inspect"
      ? "allow"
      : "deny";
  }

  if (ALWAYS_DENIED.has(capability) && !certifiedComputerApplication) {
    return "deny";
  }

  return capability === "workspace.read" || capability === "workspace.propose" || capability === "computer.inspect"
    ? "allow"
    : "ask";
}
