import type { AgentEvent, Capability } from "../agent-protocol.js";

export interface PendingPermissionView {
  readonly requestId: string;
  readonly capabilities: readonly Capability[];
}

export interface ToolActivityView {
  readonly toolName: string;
  readonly state: "requested" | "completed" | "failed";
}

// WorkbenchSnapshot 是 UI 可恢复状态；UI 组件不得各自维护另一份事实来源。
export interface WorkbenchSnapshot {
  readonly activeSessionId?: string;
  readonly lastPlanConfidence?: number;
  readonly affectedFiles: readonly string[];
  readonly pendingPermissions: readonly PendingPermissionView[];
  readonly tools: readonly ToolActivityView[];
  readonly completed: boolean;
}

export const EMPTY_WORKBENCH_SNAPSHOT: WorkbenchSnapshot = {
  affectedFiles: [],
  pendingPermissions: [],
  tools: [],
  completed: false,
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
        completed: false,
      };
    case "plan.created":
      return {
        ...current,
        activeSessionId: event.sessionId,
        lastPlanConfidence: event.confidence,
        affectedFiles: [...event.affectedFiles],
      };
    case "tool.requested":
      return {
        ...current,
        tools: [
          ...current.tools,
          { toolName: event.toolName, state: "requested" },
        ],
      };
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
        tools: current.tools.map(tool =>
          tool.toolName === event.toolName && tool.state === "requested"
            ? { ...tool, state: event.success ? "completed" : "failed" }
            : tool,
        ),
      };
    case "session.completed":
      return { ...current, completed: true };
  }
}
