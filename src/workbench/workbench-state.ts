import type { AgentEvent, Capability } from "../agent-protocol.js";

export interface PendingPermissionView {
  readonly requestId: string;
  readonly capabilities: readonly Capability[];
}

export interface ToolActivityView {
  readonly toolName: string;
  readonly state: "requested" | "running" | "completed" | "failed";
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

// WorkbenchSnapshot 是 UI 可恢复状态；UI 组件不得各自维护另一份事实来源。
export interface WorkbenchSnapshot {
  readonly activeSessionId?: string;
  readonly activeRunId?: string;
  readonly lastPlanConfidence?: number;
  readonly affectedFiles: readonly string[];
  readonly pendingPermissions: readonly PendingPermissionView[];
  readonly tools: readonly ToolActivityView[];
  readonly diffProposals: readonly DiffProposalView[];
  readonly checkpoints: readonly CheckpointView[];
  readonly assistantText: string;
  readonly completed: boolean;
  readonly failed?: { readonly code: string; readonly message: string };
  readonly aborted: boolean;
}

export const EMPTY_WORKBENCH_SNAPSHOT: WorkbenchSnapshot = {
  affectedFiles: [],
  pendingPermissions: [],
  tools: [],
  diffProposals: [],
  checkpoints: [],
  assistantText: "",
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
        affectedFiles: [],
        pendingPermissions: [],
        tools: [],
        diffProposals: [],
        checkpoints: [],
        assistantText: "",
        completed: false,
        aborted: false,
      };
    case "session.started":
      return {
        ...current,
        activeSessionId: event.sessionId,
        activeRunId: event.runId,
        assistantText: "",
        completed: false,
        aborted: false,
      };
    case "plan.created":
      return {
        ...current,
        activeSessionId: event.sessionId,
        lastPlanConfidence: event.confidence,
        affectedFiles: [...event.affectedFiles],
      };
    case "model.started":
      return current;
    case "assistant.delta":
      return { ...current, assistantText: current.assistantText + event.delta };
    case "assistant.completed":
      return current;
    case "tool.requested":
      return {
        ...current,
        tools: [...current.tools, { toolName: event.toolName, state: "requested" }],
      };
    case "tool.inspected":
      return {
        ...current,
        affectedFiles: [...new Set([...current.affectedFiles, ...event.affectedFiles])],
      };
    case "tool.started":
      return {
        ...current,
        tools: updateLatestTool(current.tools, event.toolName, "running"),
      };
    case "tool.progress":
      return current;
    case "permission.requested":
      return {
        ...current,
        pendingPermissions: [
          ...current.pendingPermissions,
          { requestId: event.requestId, capabilities: [...event.capabilities] },
        ],
      };
    case "permission.resolved":
      return {
        ...current,
        pendingPermissions: current.pendingPermissions.filter(
          permission => permission.requestId !== event.requestId,
        ),
      };
    case "tool.completed":
      return {
        ...current,
        tools: updateLatestTool(
          current.tools,
          event.toolName,
          event.success ? "completed" : "failed",
        ),
      };
    case "diff.proposed":
      return {
        ...current,
        affectedFiles: [...new Set([...current.affectedFiles, ...event.affectedFiles])],
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
              status: event.decision === "accepted"
                ? "accepted"
                : event.decision === "rejected" ? "rejected" : "conflict",
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
        affectedFiles: [...new Set([...current.affectedFiles, ...event.affectedFiles])],
        checkpoints: current.checkpoints.map(checkpoint =>
          checkpoint.checkpointId === event.checkpointId
            ? { ...checkpoint, restored: true }
            : checkpoint),
      };
    case "session.completed":
      return { ...withoutActiveRun(current), completed: true };
    case "session.failed":
      return {
        ...withoutActiveRun(current),
        failed: { code: event.code, message: event.message },
        completed: false,
      };
    case "session.aborted":
      return { ...withoutActiveRun(current), aborted: true, completed: false };
  }
}

function updateLatestTool(
  tools: readonly ToolActivityView[],
  toolName: string,
  state: ToolActivityView["state"],
): readonly ToolActivityView[] {
  const result = [...tools];
  for (let index = result.length - 1; index >= 0; index -= 1) {
    const item = result[index];
    if (item?.toolName === toolName && (item.state === "requested" || item.state === "running")) {
      result[index] = { ...item, state };
      return result;
    }
  }
  return [...result, { toolName, state }];
}


function withoutActiveRun(snapshot: WorkbenchSnapshot): WorkbenchSnapshot {
  const { activeRunId: _activeRunId, ...rest } = snapshot;
  return rest;
}
