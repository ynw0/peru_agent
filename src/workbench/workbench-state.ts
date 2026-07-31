import type {
  AgentEvent,
  Capability,
  PlanStatus,
  PlanStep,
  ToolRiskLevel,
} from "../agent-protocol.js";
import type { AgentSessionStatus } from "../agent/types.js";

export interface ChatMessageView {
  readonly id: string;
  /** Run that produced this projection. Persisted Session messages remain the source of truth. */
  readonly runId: string;
  readonly role: "user" | "assistant";
  readonly content: string;
  readonly state: "streaming" | "completed";
}

export interface PendingPermissionView {
  readonly requestId: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly riskLevel: ToolRiskLevel;
  readonly capabilities: readonly Capability[];
  readonly affectedFiles: readonly string[];
  readonly networkTargets: readonly string[];
  readonly commands: readonly string[];
  readonly commandText?: string;
  readonly reason: string;
}

export interface ToolActivityView {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly description: string;
  readonly riskLevel: ToolRiskLevel;
  readonly capabilities: readonly Capability[];
  readonly affectedFiles: readonly string[];
  readonly networkTargets: readonly string[];
  readonly commands: readonly string[];
  readonly commandText?: string;
  readonly progressMessages: readonly string[];
  readonly outputPreview?: string;
  readonly outputTruncated?: boolean;
  readonly outputIsError?: boolean;
  readonly state: "requested" | "running" | "completed" | "failed";
}

export interface PlanReviewView {
  readonly planId: string;
  readonly title: string;
  readonly summary: string;
  readonly confidence: number;
  readonly affectedFiles: readonly string[];
  readonly steps: readonly PlanStep[];
  readonly status: PlanStatus;
  readonly message?: string;
}

export interface DiffProposalView {
  readonly proposalId: string;
  readonly status: "proposed" | "accepted" | "rejected" | "conflict";
  readonly affectedFiles: readonly string[];
  readonly checkpointId?: string;
}

export interface CheckpointView {
  readonly checkpointId: string;
  readonly proposalId?: string;
  readonly restored: boolean;
}

export interface SubagentTaskView {
  readonly taskId: string;
  readonly role: "planner" | "explorer" | "implementer" | "reviewer" | "tester";
  readonly depth: number;
  readonly status: "queued" | "running" | "completed" | "failed" | "aborted" | "patchProposed" | "merged" | "gating" | "noChanges" | "patchRejected" | "interrupted" | "gateInterrupted";
  readonly workspaceId?: string;
  readonly verdict?: "approved" | "rejected";
  readonly proposalId?: string;
  readonly error?: { readonly code: string; readonly message: string };
  readonly planId?: string;
  readonly planStepId?: string;
  readonly attemptId?: string;
  readonly outputCommitId?: string;
  readonly sourceCommitId?: string;
  readonly repairOfTaskId?: string;
  readonly rejectionCount?: number;
  readonly stableReason?: string;
  readonly gateTaskIds?: readonly string[];
  readonly gateAttempts?: readonly { readonly taskId: string; readonly role: "reviewer" | "tester"; readonly status: string; readonly report?: unknown; readonly updatedAt: string }[];
}

// WorkbenchSnapshot 是 UI 可恢复状态；UI 组件不得各自维护另一份事实来源。
export interface WorkbenchSnapshot {
  readonly activeSessionId?: string;
  readonly activeRunId?: string;
  readonly sessionStatus: AgentSessionStatus | "none";
  readonly chatMessages: readonly ChatMessageView[];
  readonly plans: readonly PlanReviewView[];
  readonly affectedFiles: readonly string[];
  readonly pendingPermissions: readonly PendingPermissionView[];
  readonly tools: readonly ToolActivityView[];
  readonly diffProposals: readonly DiffProposalView[];
  readonly checkpoints: readonly CheckpointView[];
  readonly subagents: readonly SubagentTaskView[];
  readonly usage: {
    readonly inputTokens: number;
    readonly outputTokens: number;
  };
  readonly completed: boolean;
  readonly failed?: { readonly code: string; readonly message: string };
  readonly aborted: boolean;
}

export const EMPTY_WORKBENCH_SNAPSHOT: WorkbenchSnapshot = {
  sessionStatus: "none",
  chatMessages: [],
  plans: [],
  affectedFiles: [],
  pendingPermissions: [],
  tools: [],
  diffProposals: [],
  checkpoints: [],
  subagents: [],
  usage: { inputTokens: 0, outputTokens: 0 },
  completed: false,
  aborted: false,
};

// Projector 只根据 AgentEvent 计算新状态，便于崩溃后重放事件恢复 UI。
export function projectWorkbenchSnapshot(
  current: WorkbenchSnapshot,
  event: AgentEvent,
): WorkbenchSnapshot {
  switch (event.type) {
    case "session.created":
      return {
        activeSessionId: event.sessionId,
        sessionStatus: "idle",
        chatMessages: [],
        plans: [],
        affectedFiles: [],
        pendingPermissions: [],
        tools: [],
        diffProposals: [],
        checkpoints: [],
        subagents: [],
        usage: { inputTokens: 0, outputTokens: 0 },
        completed: false,
        aborted: false,
      };
    case "session.renamed":
    case "session.compacted":
    case "session.input.queued":
    case "session.input.dequeued":
      return current;
    case "session.compaction.failed":
      return { ...current, failed: { code: event.code, message: event.message } };
    case "session.started":
      {
        const { failed: _failed, ...rest } = current;
        return {
          ...rest,
          activeSessionId: event.sessionId,
          activeRunId: event.runId,
          sessionStatus: "running",
          completed: false,
          aborted: false,
        };
      }
    case "user.message.added":
      return {
        ...current,
        chatMessages: [
          ...current.chatMessages,
          {
            id: event.messageId,
            runId: current.activeRunId ?? "unknown",
            role: "user",
            content: event.content,
            state: "completed",
          },
        ],
      };
    case "plan.created":
      return {
        ...current,
        affectedFiles: mergeStrings(current.affectedFiles, event.affectedFiles),
        plans: [
          ...current.plans,
          {
            planId: event.planId,
            title: event.title,
            summary: event.summary,
            confidence: event.confidence,
            affectedFiles: [...event.affectedFiles],
            steps: event.steps.map(step => ({
              ...step,
              affectedFiles: [...step.affectedFiles],
              capabilities: [...step.capabilities],
            })),
            status: "reviewing",
          },
        ],
      };
    case "plan.resolved":
      return {
        ...current,
        plans: updatePlan(current.plans, event.planId, {
          status: event.decision,
        }),
      };
    case "plan.status.changed":
      return {
        ...current,
        plans: updatePlan(current.plans, event.planId, {
          status: event.status,
          ...(event.message === undefined ? {} : { message: event.message }),
        }),
      };
    case "model.started":
      return current;
    case "assistant.started":
      return {
        ...current,
        chatMessages: [
          ...current.chatMessages,
          {
            id: event.messageId,
            runId: current.activeRunId ?? "unknown",
            role: "assistant",
            content: "",
            state: "streaming",
          },
        ],
      };
    case "assistant.delta":
      return {
        ...current,
        chatMessages: current.chatMessages.map(message =>
          message.id === event.messageId
            ? { ...message, content: message.content + event.delta }
            : message),
      };
    case "assistant.completed":
      return {
        ...current,
        chatMessages: current.chatMessages.map(message =>
          message.id === event.messageId
            ? { ...message, state: "completed" }
            : message),
      };
    case "session.usage.updated":
      return {
        ...current,
        usage: {
          inputTokens: event.inputTokens,
          outputTokens: event.outputTokens,
        },
      };
    case "tool.requested":
      return {
        ...current,
        tools: [
          ...current.tools,
          {
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            description: event.description,
            riskLevel: event.riskLevel,
            capabilities: [...event.capabilities],
            affectedFiles: [],
            networkTargets: [],
            commands: [],
            progressMessages: [],
            state: "requested",
          },
        ],
      };
    case "tool.inspected":
      return {
        ...current,
        affectedFiles: mergeStrings(current.affectedFiles, event.affectedFiles),
        tools: updateTool(current.tools, event.toolCallId, tool => ({
          ...tool,
          affectedFiles: [...event.affectedFiles],
          networkTargets: [...(event.networkTargets ?? [])],
          commands: [...(event.commands ?? [])],
          ...(event.commandText === undefined ? {} : { commandText: event.commandText }),
        })),
      };
    case "tool.started":
      return {
        ...current,
        tools: updateTool(current.tools, event.toolCallId, tool => ({
          ...tool,
          state: "running",
        })),
      };
    case "tool.progress":
      return {
        ...current,
        tools: updateTool(current.tools, event.toolCallId, tool => ({
          ...tool,
          progressMessages: [...tool.progressMessages, event.message],
        })),
      };
    case "permission.requested":
      return {
        ...current,
        sessionStatus: "awaitingPermission",
        pendingPermissions: [
          ...current.pendingPermissions,
          {
            requestId: event.requestId,
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            riskLevel: event.riskLevel,
            capabilities: [...event.capabilities],
            affectedFiles: [...event.affectedFiles],
            networkTargets: [...(event.networkTargets ?? [])],
            commands: [...(event.commands ?? [])],
            ...(event.commandText === undefined ? {} : { commandText: event.commandText }),
            reason: event.reason,
          },
        ],
      };
    case "permission.resolved":
      return {
        ...current,
        sessionStatus: "running",
        pendingPermissions: current.pendingPermissions.filter(
          permission => permission.requestId !== event.requestId,
        ),
      };
    case "tool.completed":
      return {
        ...current,
        tools: updateTool(current.tools, event.toolCallId, tool => ({
          ...tool,
          state: event.success ? "completed" : "failed",
        })),
      };
    case "tool.result":
      return {
        ...current,
        tools: updateTool(current.tools, event.toolCallId, tool => ({
          ...tool,
          outputPreview: event.outputPreview,
          outputTruncated: event.truncated,
          outputIsError: event.isError,
        })),
      };
    case "diff.proposed":
      return {
        ...current,
        affectedFiles: mergeStrings(current.affectedFiles, event.affectedFiles),
        diffProposals: [
          ...current.diffProposals,
          {
            proposalId: event.proposalId,
            status: "proposed",
            affectedFiles: [...event.affectedFiles],
          },
        ],
      };
    case "diff.resolved":
      return {
        ...current,
        diffProposals: current.diffProposals.map(proposal =>
          proposal.proposalId === event.proposalId
            ? {
              ...proposal,
              status: event.decision,
              ...(event.checkpointId === undefined ? {} : { checkpointId: event.checkpointId }),
            }
            : proposal),
      };
    case "checkpoint.created":
      return {
        ...current,
        checkpoints: [
          ...current.checkpoints,
          { checkpointId: event.checkpointId, proposalId: event.proposalId, restored: false },
        ],
      };
    case "checkpoint.restored":
      return {
        ...current,
        affectedFiles: mergeStrings(current.affectedFiles, event.affectedFiles),
        checkpoints: current.checkpoints.map(checkpoint =>
          checkpoint.checkpointId === event.checkpointId
            ? { ...checkpoint, restored: true }
            : checkpoint),
      };
    case "subagent.task.created":
      return {
        ...current,
        subagents: [
          ...current.subagents,
          {
            taskId: event.taskId,
            role: event.role,
            depth: event.depth,
            status: "queued",
            ...(event.planId === undefined ? {} : { planId: event.planId }),
            ...(event.planStepId === undefined ? {} : { planStepId: event.planStepId }),
            ...(event.attemptId === undefined ? {} : { attemptId: event.attemptId }),
          },
        ],
      };
    case "subagent.task.started":
      return {
        ...current,
        subagents: updateSubagent(current.subagents, event.taskId, task => ({
          ...task,
          status: "running",
          workspaceId: event.workspaceId,
        })),
      };
    case "subagent.task.completed":
      return {
        ...current,
        subagents: updateSubagent(current.subagents, event.taskId, task => ({
          ...task,
          status: "completed",
          ...(event.verdict === undefined ? {} : { verdict: event.verdict }),
          ...(event.outputCommitId === undefined ? {} : { outputCommitId: event.outputCommitId }),
          ...(event.stableReason === undefined ? {} : { stableReason: event.stableReason }),
        })),
      };
    case "subagent.task.failed":
      return {
        ...current,
        subagents: updateSubagent(current.subagents, event.taskId, task => ({
          ...task,
          status: "failed",
          error: { code: event.code, message: event.message },
        })),
      };
    case "subagent.task.aborted":
      return {
        ...current,
        subagents: updateSubagent(current.subagents, event.taskId, task => ({ ...task, status: "aborted" })),
      };
    case "subagent.task.interrupted":
      return {
        ...current,
        subagents: updateSubagent(current.subagents, event.taskId, task => ({
          ...task,
          status: event.status,
          stableReason: event.status,
          error: { code: event.code, message: event.message },
        })),
      };
    case "subagent.task.status":
      return {
        ...current,
        subagents: updateSubagent(current.subagents, event.taskId, task => ({
          ...task,
          status: event.status,
          stableReason: event.status,
          ...(event.gateTaskIds === undefined ? {} : { gateTaskIds: [...event.gateTaskIds] }),
          ...(event.message === undefined ? {} : { error: { code: `SUBAGENT_${event.status.toUpperCase()}`, message: event.message } }),
        })),
      };
    case "subagent.gate.attempt":
      return {
        ...current,
        subagents: updateSubagent(current.subagents, event.targetTaskId, task => ({
          ...task,
          gateAttempts: [
            ...(task.gateAttempts ?? []).filter(item => item.taskId !== event.taskId),
            {
              taskId: event.taskId,
              role: event.role,
              status: event.status,
              ...(event.summary === undefined ? {} : { report: { summary: event.summary } }),
              updatedAt: new Date().toISOString(),
            },
          ],
        })),
      };
    case "subagent.patch.proposed":
      return {
        ...current,
        subagents: updateSubagent(current.subagents, event.taskId, task => ({
          ...task,
          status: "patchProposed",
          proposalId: event.proposalId,
          gateTaskIds: [...event.gateTaskIds],
        })),
      };
    case "subagent.task.merged":
      return {
        ...current,
        subagents: updateSubagent(current.subagents, event.taskId, task => ({
          ...task,
          status: "merged",
          proposalId: event.proposalId,
        })),
      };
    case "session.completed":
      return {
        ...withoutActiveRun(current),
        sessionStatus: "completed",
        completed: true,
      };
    case "session.failed":
      return {
        ...withoutActiveRun(current),
        sessionStatus: "failed",
        failed: { code: event.code, message: event.message },
        completed: false,
      };
    case "session.aborted":
      return {
        ...withoutActiveRun(current),
        sessionStatus: "aborted",
        aborted: true,
        completed: false,
      };
  }
}

function updateSubagent(
  tasks: readonly SubagentTaskView[],
  taskId: string,
  updater: (task: SubagentTaskView) => SubagentTaskView,
): readonly SubagentTaskView[] {
  let found = false;
  const updated = tasks.map(task => {
    if (task.taskId !== taskId) {
      return task;
    }
    found = true;
    return updater(task);
  });
  if (!found) {
    throw new Error(`Workbench 收到未知子 Agent 任务事件：${taskId}`);
  }
  return updated;
}

function updateTool(
  tools: readonly ToolActivityView[],
  toolCallId: string,
  updater: (tool: ToolActivityView) => ToolActivityView,
): readonly ToolActivityView[] {
  let found = false;
  const updated = tools.map(tool => {
    if (tool.toolCallId !== toolCallId) {
      return tool;
    }
    found = true;
    return updater(tool);
  });
  if (!found) {
    throw new Error(`Workbench 收到未知 ToolCall 事件：${toolCallId}`);
  }
  return updated;
}

function updatePlan(
  plans: readonly PlanReviewView[],
  planId: string,
  changes: Partial<Pick<PlanReviewView, "status" | "message">>,
): readonly PlanReviewView[] {
  let found = false;
  const updated = plans.map(plan => {
    if (plan.planId !== planId) {
      return plan;
    }
    found = true;
    return { ...plan, ...changes };
  });
  if (!found) {
    throw new Error(`Workbench 收到未知 Plan 事件：${planId}`);
  }
  return updated;
}

function mergeStrings(left: readonly string[], right: readonly string[]): readonly string[] {
  return [...new Set([...left, ...right])];
}

function withoutActiveRun(snapshot: WorkbenchSnapshot): WorkbenchSnapshot {
  const runId = snapshot.activeRunId;
  const { activeRunId: _activeRunId, ...rest } = snapshot;
  if (runId === undefined) return rest;
  // An assistant that never reached SessionStore is an in-flight projection,
  // not historical conversation. Remove it when the run reaches a terminal
  // state so it cannot be appended to a later turn.
  return {
    ...rest,
    chatMessages: rest.chatMessages.filter(message => message.runId !== runId || message.state !== "streaming"),
  };
}
