// 权限模式只有三种，IDE、Agent Runtime 和权限引擎必须使用同一组枚举。
export type PermissionMode = "default" | "autoReview" | "fullAccess";

// 网络模式不会自动切换；用户必须明确选择需要的运行环境。
export type NetworkMode = "offline" | "lan" | "internet";

// Tool 风险等级用于权限审核和自生成 Tool 的晋级判断。
export type ToolRiskLevel =
  | "pure-compute"
  | "workspace-read"
  | "workspace-write"
  | "process"
  | "network"
  | "browser"
  | "computer-use"
  | "security-core";

// 所有高权限行为使用明确能力标识，避免只凭工具名称判断权限。
export type Capability =
  | "workspace.read"
  | "workspace.write"
  | "workspace.propose"
  | "workspace.delete"
  | "process.execute"
  | "process.background"
  | "git.write"
  | "network.loopback"
  | "network.lan"
  | "network.internet"
  | "browser.navigate"
  | "browser.interact"
  | "computer.inspect"
  | "computer.interact"
  | "tool.install"
  | "skill.install";

// Plan 状态由独立状态机维护，UI 只能通过 IPC 提交审核决定。
export type PlanStatus =
  | "reviewing"
  | "approved"
  | "rejected"
  | "executing"
  | "completed"
  | "failed"
  | "cancelled";

export interface PlanStep {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly affectedFiles: readonly string[];
  readonly capabilities: readonly Capability[];
}

// Agent 运行过程通过不可变事件传给 IDE；UI 只投影事件，不保存另一份事实状态。
export type AgentEvent =
  | { type: "session.created"; sessionId: string; workspaceId?: string }
  | { type: "session.renamed"; sessionId: string; title: string }
  | { type: "session.compacted"; sessionId: string; sourceMessageCount: number }
  | { type: "session.compaction.failed"; sessionId: string; code: string; message: string }
  | { type: "session.input.queued"; sessionId: string; queueId: string; priority: "guide" | "next" | "immediate" }
  | { type: "session.input.dequeued"; sessionId: string; queueId: string }
  | { type: "session.started"; sessionId: string; runId: string }
  | { type: "user.message.added"; sessionId: string; messageId: string; content: string }
  | {
    type: "plan.created";
    sessionId: string;
    planId: string;
    title: string;
    summary: string;
    confidence: number;
    affectedFiles: string[];
    steps: PlanStep[];
    status: "reviewing";
    createdAt: string;
  }
  | {
    type: "plan.resolved";
    sessionId: string;
    planId: string;
    decision: "approved" | "rejected";
    updatedAt: string;
  }
  | {
    type: "plan.status.changed";
    sessionId: string;
    planId: string;
    status: Exclude<PlanStatus, "reviewing" | "approved" | "rejected">;
    updatedAt: string;
    message?: string;
  }
  | { type: "model.started"; sessionId: string; turn: number }
  | { type: "assistant.started"; sessionId: string; messageId: string; turn: number }
  | { type: "assistant.delta"; sessionId: string; messageId: string; delta: string }
  | { type: "assistant.completed"; sessionId: string; messageId: string }
  | {
    type: "session.usage.updated";
    sessionId: string;
    inputTokens: number;
    outputTokens: number;
  }
  | {
    type: "tool.requested";
    sessionId: string;
    toolCallId: string;
    toolName: string;
    description: string;
    riskLevel: ToolRiskLevel;
    capabilities: Capability[];
  }
  | {
    type: "tool.inspected";
    sessionId: string;
    toolCallId: string;
    toolName: string;
    riskLevel: ToolRiskLevel;
    affectedFiles: string[];
    networkTargets?: string[];
    commands?: string[];
    commandText?: string;
  }
  | { type: "tool.started"; sessionId: string; toolName: string; toolCallId: string }
  | {
    type: "tool.progress";
    sessionId: string;
    toolName: string;
    toolCallId: string;
    message: string;
  }
  | {
    type: "permission.requested";
    sessionId: string;
    requestId: string;
    toolCallId: string;
    toolName: string;
    riskLevel: ToolRiskLevel;
    capabilities: Capability[];
    affectedFiles: string[];
    networkTargets?: string[];
    commands?: string[];
    commandText?: string;
    reason: string;
    permission: string;
    patterns: string[];
    always: string[];
    metadata: Record<string, unknown>;
  }
  | {
    type: "permission.resolved";
    sessionId: string;
    requestId: string;
    decision: "allow" | "deny";
    reply: "once" | "always" | "reject";
  }
  | {
    type: "tool.completed";
    sessionId: string;
    toolName: string;
    success: boolean;
    toolCallId: string;
  }
  | {
    type: "tool.result";
    sessionId: string;
    toolName: string;
    toolCallId: string;
    outputPreview: string;
    truncated: boolean;
    isError: boolean;
  }
  | { type: "diff.proposed"; sessionId: string; proposalId: string; affectedFiles: string[] }
  | {
    type: "diff.resolved";
    sessionId: string;
    proposalId: string;
    decision: "accepted" | "rejected" | "conflict";
    checkpointId?: string;
  }
  | { type: "checkpoint.created"; sessionId: string; checkpointId: string; proposalId: string }
  | { type: "checkpoint.restored"; sessionId: string; checkpointId: string; affectedFiles: string[] }
  | {
    type: "subagent.task.created";
    sessionId: string;
    taskId: string;
    role: "planner" | "explorer" | "implementer" | "reviewer" | "tester";
    depth: number;
    planId?: string;
    planStepId?: string;
    attemptId?: string;
  }
  | { type: "subagent.task.started"; sessionId: string; taskId: string; workspaceId: string }
  | {
    type: "subagent.task.completed";
    sessionId: string;
    taskId: string;
    role: "planner" | "explorer" | "implementer" | "reviewer" | "tester";
    verdict?: "approved" | "rejected";
    outputCommitId?: string;
    stableReason?: string;
  }
  | { type: "subagent.task.failed"; sessionId: string; taskId: string; code: string; message: string }
  | { type: "subagent.task.aborted"; sessionId: string; taskId: string }
  | {
    type: "subagent.task.interrupted";
    sessionId: string;
    taskId: string;
    status: "interrupted" | "gateInterrupted";
    code: string;
    message: string;
  }
  | {
    type: "subagent.task.status";
    sessionId: string;
    taskId: string;
    status: "gating" | "noChanges" | "patchRejected";
    gateTaskIds?: string[];
    message?: string;
  }
  | {
    type: "subagent.gate.attempt";
    sessionId: string;
    taskId: string;
    targetTaskId: string;
    role: "reviewer" | "tester";
    status: "approved" | "rejected" | "failed" | "interrupted";
    summary?: string;
  }
  | {
    type: "subagent.patch.proposed";
    sessionId: string;
    taskId: string;
    proposalId: string;
    gateTaskIds: string[];
  }
  | { type: "subagent.task.merged"; sessionId: string; taskId: string; proposalId: string }
  | { type: "session.completed"; sessionId: string }
  | { type: "session.failed"; sessionId: string; code: string; message: string }
  | { type: "session.aborted"; sessionId: string };
