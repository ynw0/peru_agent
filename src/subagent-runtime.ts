import type { Capability } from "./agent-protocol.js";
import { validateSubagentTaskRequest } from "./subagent/policy.js";
import { MAX_SUBAGENT_DEPTH, type SubagentTaskRequest } from "./subagent/types.js";

export { MAX_SUBAGENT_DEPTH };

// 保留稳定的基础 Assignment 接口，并将校验委托给 Phase 8 的完整策略。
export interface SubagentAssignment {
  readonly depth: number;
  readonly allowedPaths: readonly string[];
  readonly writablePaths: readonly string[];
  readonly tokenBudget: number;
  readonly maxTurns: number;
}

export function validateSubagentAssignment(assignment: SubagentAssignment): void {
  const capabilities: Capability[] = assignment.writablePaths.length === 0
    ? ["workspace.read"]
    : ["workspace.read", "workspace.write"];
  const request: SubagentTaskRequest = {
    parentSessionId: "validation",
    role: assignment.writablePaths.length === 0 ? "explorer" : "implementer",
    instruction: "validation",
    depth: assignment.depth,
    baseWorkspaceId: "validation",
    allowedPaths: assignment.allowedPaths,
    writablePaths: assignment.writablePaths,
    allowedCapabilities: capabilities,
    budget: {
      maxTurns: assignment.maxTurns,
      maxToolCalls: assignment.maxTurns,
      maxTotalTokens: assignment.tokenBudget,
      maxDurationMs: 60_000,
    },
    reviewPolicy: "reviewerAndTester",
  };
  validateSubagentTaskRequest(request);
}

export * from "./subagent/types.js";
export * from "./subagent/policy.js";
export * from "./subagent/task-store.js";
export * from "./subagent/worktree-manager.js";
export * from "./subagent/patch-merger.js";
export * from "./subagent/executor.js";
export * from "./subagent/scheduler.js";
