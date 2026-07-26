import type { Capability } from "../agent-protocol.js";
import type { AgentRunLimits } from "../agent/types.js";
import type { WorkspaceFileSnapshot } from "../workspace/types.js";

export const MAX_SUBAGENT_DEPTH = 2;

export type SubagentRole = "planner" | "explorer" | "implementer" | "reviewer" | "tester";

export type SubagentTaskStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "aborted"
  | "patchProposed"
  | "merged";

export type SubagentVerdict = "approved" | "rejected";

export interface SubagentBudget extends AgentRunLimits {
  readonly maxDurationMs: number;
}

export interface SubagentTaskRequest {
  readonly parentSessionId: string;
  readonly parentTaskId?: string;
  readonly role: SubagentRole;
  readonly instruction: string;
  readonly depth: number;
  readonly baseWorkspaceId: string;
  readonly allowedPaths: readonly string[];
  readonly writablePaths: readonly string[];
  readonly allowedCapabilities: readonly Capability[];
  readonly budget: SubagentBudget;
  readonly targetTaskId?: string;
}

export interface SubagentUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly turns: number;
  readonly toolCalls: number;
}

export interface SubagentExecutionResult {
  readonly summary: string;
  readonly usage: SubagentUsage;
  readonly childSessionId?: string;
  readonly verdict?: SubagentVerdict;
}

export interface SubagentWorktreeSnapshot {
  readonly id: string;
  readonly taskId: string;
  readonly baseWorkspaceId: string;
  readonly workspaceId: string;
  readonly root: string;
  readonly allowedPaths: readonly string[];
  readonly writablePaths: readonly string[];
  readonly baseFiles: readonly WorkspaceFileSnapshot[];
  readonly createdAt: string;
}

export interface SubagentTaskRecord extends SubagentTaskRequest {
  readonly id: string;
  readonly status: SubagentTaskStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly worktree?: SubagentWorktreeSnapshot;
  readonly result?: SubagentExecutionResult;
  readonly patchProposalId?: string;
  readonly error?: { readonly code: string; readonly message: string };
}

export interface SubagentPatchChange {
  readonly path: string;
  readonly before: WorkspaceFileSnapshot;
  readonly afterContent: string;
}
