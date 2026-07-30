import type { Capability } from "../agent-protocol.js";
import type { AgentRunLimits } from "../agent/types.js";
import type { WorkspaceFileSnapshot } from "../workspace/types.js";

export const MAX_SUBAGENT_DEPTH = 2;

export type SubagentRole = "planner" | "explorer" | "implementer" | "reviewer" | "tester";

export type SubagentReviewPolicy = "none" | "reviewer" | "reviewerAndTester";

export type SubagentTaskStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "aborted"
  | "patchProposed"
  | "merged"
  | "gating"
  | "noChanges"
  | "patchRejected"
  | "interrupted"
  | "gateInterrupted";

export type SubagentVerdict = "approved" | "rejected";

export interface GateReport {
  readonly verdict: SubagentVerdict;
  readonly summary: string;
  readonly issues: readonly string[];
  readonly evidence: readonly string[];
  readonly tests: readonly string[];
  readonly createdAt: string;
}

export interface GateAttempt {
  readonly taskId: string;
  readonly role: "reviewer" | "tester";
  readonly status: "queued" | "running" | "completed" | "rejected" | "failed" | "interrupted";
  readonly report?: GateReport;
  readonly error?: { readonly code: string; readonly message: string };
  readonly updatedAt: string;
}

export interface RepairTaskMetadata {
  readonly repairOfTaskId: string;
  readonly sourceCommitId: string;
  readonly rejectionCount: number;
}

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
  readonly reviewPolicy: SubagentReviewPolicy;
  readonly planId?: string;
  readonly planStepId?: string;
  readonly sourceCommitId?: string;
  readonly repairOfTaskId?: string;
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
  readonly gateReport?: GateReport;
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
  readonly gateTaskIds?: readonly string[];
  readonly attemptId: string;
  readonly sourceCommitId?: string;
  readonly outputCommitId?: string;
  readonly repairOfTaskId?: string;
  readonly rejectionCount: number;
  readonly gateAttempts?: readonly GateAttempt[];
  readonly stableReason?: "completed" | "noChanges" | "patchProposed" | "patchRejected" | "failed" | "interrupted" | "gateInterrupted" | "merged" | "aborted";
  readonly error?: { readonly code: string; readonly message: string };
}

export interface SubagentCommitFile {
  readonly path: string;
  readonly before: WorkspaceFileSnapshot;
  readonly after: WorkspaceFileSnapshot;
}

export interface SubagentCommit {
  readonly id: string;
  readonly taskId: string;
  readonly parentSessionId: string;
  readonly baseWorkspaceId: string;
  readonly planId?: string;
  readonly planStepId?: string;
  readonly files: readonly SubagentCommitFile[];
  readonly createdAt: string;
}

export interface SubagentPatchChange {
  readonly path: string;
  readonly before: WorkspaceFileSnapshot;
  readonly afterContent: string;
}
