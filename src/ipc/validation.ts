import { IPC_PROTOCOL_VERSION } from "./protocol.js";
import type {
  IpcEventMethod,
  IpcMessage,
  IpcRequestMethod,
} from "./protocol.js";

const ERROR_CODES = new Set([
  "INVALID_MESSAGE",
  "METHOD_NOT_FOUND",
  "HANDLER_NOT_REGISTERED",
  "HANDLER_FAILED",
  "REQUEST_ABORTED",
  "REQUEST_TIMEOUT",
  "PROTOCOL_VERSION_MISMATCH",
]);

const REQUEST_METHODS: ReadonlySet<string> = new Set<IpcRequestMethod>([
  "runtime.initialize",
  "session.create",
  "session.start",
  "session.abort",
  "session.get",
  "session.list",
  "session.events",
  "session.retry",
  "permission.resolve",
  "workspace.register",
  "workspace.read",
  "diff.list",
  "diff.get",
  "diff.accept",
  "diff.reject",
  "checkpoint.list",
  "checkpoint.restore",
  "plan.list",
  "plan.get",
  "plan.resolve",
  "workbench.getSnapshot",
]);

const EVENT_METHODS: ReadonlySet<string> = new Set<IpcEventMethod>([
  "agent.event",
  "workbench.snapshot.changed",
  "runtime.health.changed",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function isOptionalNonEmptyString(value: unknown): boolean {
  return value === undefined || isNonEmptyString(value);
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every(item => typeof item === "string");
}

function isNonNegativeInteger(value: unknown): boolean {
  return Number.isInteger(value) && Number(value) >= 0;
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every(key => allowed.has(key));
}

export function isRequestParams(method: IpcRequestMethod, value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }

  switch (method) {
    case "runtime.initialize":
      return hasOnlyKeys(value, ["protocolVersion", "clientId", "locale", "permissionMode", "networkMode"])
        && value.protocolVersion === IPC_PROTOCOL_VERSION
        && isNonEmptyString(value.clientId)
        && (value.locale === "zh-CN" || value.locale === "en-US")
        && isPermissionMode(value.permissionMode)
        && (value.networkMode === "offline" || value.networkMode === "lan" || value.networkMode === "internet");
    case "session.create":
      return hasOnlyKeys(value, ["workspaceId"]) && isNonEmptyString(value.workspaceId);
    case "session.start":
      return hasOnlyKeys(value, ["sessionId", "input"])
        && isNonEmptyString(value.sessionId)
        && isNonEmptyString(value.input);
    case "session.abort":
    case "session.get":
    case "session.events":
    case "session.retry":
      return hasOnlyKeys(value, ["sessionId"]) && isNonEmptyString(value.sessionId);
    case "session.list":
      return hasOnlyKeys(value, ["workspaceId"]) && isOptionalNonEmptyString(value.workspaceId);
    case "permission.resolve":
      return hasOnlyKeys(value, ["requestId", "decision"])
        && isNonEmptyString(value.requestId)
        && (value.decision === "allow" || value.decision === "deny");
    case "workspace.register":
      return hasOnlyKeys(value, ["workspaceId", "rootPath"])
        && isNonEmptyString(value.workspaceId)
        && isNonEmptyString(value.rootPath);
    case "workspace.read":
      return hasOnlyKeys(value, ["workspaceId", "path"])
        && isNonEmptyString(value.workspaceId)
        && isNonEmptyString(value.path);
    case "diff.list":
    case "checkpoint.list":
      return hasOnlyKeys(value, ["workspaceId"]) && isOptionalNonEmptyString(value.workspaceId);
    case "diff.get":
    case "diff.accept":
    case "diff.reject":
      return hasOnlyKeys(value, ["proposalId"]) && isNonEmptyString(value.proposalId);
    case "checkpoint.restore":
      return hasOnlyKeys(value, ["checkpointId"]) && isNonEmptyString(value.checkpointId);
    case "plan.list":
      return hasOnlyKeys(value, ["sessionId"]) && isOptionalNonEmptyString(value.sessionId);
    case "plan.get":
      return hasOnlyKeys(value, ["planId"]) && isNonEmptyString(value.planId);
    case "plan.resolve":
      return hasOnlyKeys(value, ["planId", "decision"])
        && isNonEmptyString(value.planId)
        && (value.decision === "approved" || value.decision === "rejected");
    case "workbench.getSnapshot":
      return hasOnlyKeys(value, ["sessionId"]) && isOptionalNonEmptyString(value.sessionId);
  }
}

export function isResponseResult(method: IpcRequestMethod, value: unknown): boolean {
  switch (method) {
    case "runtime.initialize":
      return isRecord(value)
        && isNonEmptyString(value.runtimeId)
        && value.protocolVersion === IPC_PROTOCOL_VERSION
        && isStringArray(value.enabledCapabilities);
    case "session.create":
      return isRecord(value) && isNonEmptyString(value.sessionId);
    case "session.start":
      return isRecord(value) && isNonEmptyString(value.runId);
    case "session.abort":
      return isRecord(value) && typeof value.aborted === "boolean";
    case "session.get":
      return isAgentSessionSnapshot(value);
    case "session.list":
      return isRecord(value) && Array.isArray(value.sessions) && value.sessions.every(isAgentSessionSnapshot);
    case "session.events":
      return isRecord(value) && Array.isArray(value.entries) && value.entries.every(isJournalEntry);
    case "session.retry":
      return isRecord(value) && isNonEmptyString(value.sessionId) && isNonEmptyString(value.runId);
    case "permission.resolve":
      return isRecord(value) && typeof value.accepted === "boolean";
    case "workspace.register":
      return isRecord(value) && value.registered === true;
    case "workspace.read":
      return isWorkspaceFileSnapshot(value);
    case "diff.list":
      return isRecord(value) && Array.isArray(value.proposals) && value.proposals.every(isDiffProposal);
    case "diff.get":
    case "diff.accept":
    case "diff.reject":
      return isDiffProposal(value);
    case "checkpoint.list":
      return isRecord(value) && Array.isArray(value.checkpoints) && value.checkpoints.every(isCheckpointRecord);
    case "checkpoint.restore":
      return isCheckpointRecord(value);
    case "plan.list":
      return isRecord(value) && Array.isArray(value.plans) && value.plans.every(isPlanRecord);
    case "plan.get":
    case "plan.resolve":
      return isPlanRecord(value);
    case "workbench.getSnapshot":
      return isWorkbenchSnapshot(value);
  }
}

function isAgentSessionSnapshot(value: unknown): boolean {
  return isRecord(value)
    && isNonEmptyString(value.id)
    && isNonEmptyString(value.workspaceId)
    && isPermissionMode(value.permissionMode)
    && isSessionStatus(value.status)
    && Array.isArray(value.messages)
    && value.messages.every(isAgentMessage)
    && isNonEmptyString(value.createdAt)
    && isNonEmptyString(value.updatedAt)
    && (value.activeRunId === undefined || isNonEmptyString(value.activeRunId))
    && (value.lastError === undefined || (isRecord(value.lastError)
      && isNonEmptyString(value.lastError.code)
      && isNonEmptyString(value.lastError.message)))
    && isRecord(value.usage)
    && isNonNegativeInteger(value.usage.inputTokens)
    && isNonNegativeInteger(value.usage.outputTokens);
}

function isAgentMessage(value: unknown): boolean {
  if (!isRecord(value) || !isNonEmptyString(value.id) || typeof value.role !== "string") {
    return false;
  }
  if (value.role === "user") {
    return typeof value.content === "string";
  }
  if (value.role === "assistant") {
    return typeof value.content === "string" && Array.isArray(value.toolCalls);
  }
  if (value.role === "tool") {
    return isNonEmptyString(value.toolCallId)
      && isNonEmptyString(value.toolName)
      && typeof value.content === "string"
      && typeof value.isError === "boolean";
  }
  return false;
}

function isWorkspaceFileSnapshot(value: unknown): boolean {
  return isRecord(value)
    && isNonEmptyString(value.path)
    && typeof value.exists === "boolean"
    && (value.content === null || typeof value.content === "string")
    && (value.sha256 === null || isSha256(value.sha256))
    && isNonNegativeInteger(value.byteLength);
}

function isDiffProposal(value: unknown): boolean {
  return isRecord(value)
    && isNonEmptyString(value.id)
    && isNonEmptyString(value.sessionId)
    && isNonEmptyString(value.workspaceId)
    && isNonEmptyString(value.toolCallId)
    && isNonEmptyString(value.createdAt)
    && (value.status === "proposed" || value.status === "accepted"
      || value.status === "rejected" || value.status === "conflict")
    && Array.isArray(value.changes)
    && value.changes.every(change => isRecord(change)
      && isNonEmptyString(change.path)
      && isWorkspaceFileSnapshot(change.before)
      && typeof change.afterContent === "string"
      && isSha256(change.afterSha256)
      && typeof change.unifiedDiff === "string")
    && (value.checkpointId === undefined || isNonEmptyString(value.checkpointId))
    && (value.conflictMessage === undefined || typeof value.conflictMessage === "string");
}

function isCheckpointRecord(value: unknown): boolean {
  return isRecord(value)
    && isNonEmptyString(value.id)
    && isNonEmptyString(value.workspaceId)
    && isNonEmptyString(value.sessionId)
    && isNonEmptyString(value.proposalId)
    && isNonEmptyString(value.createdAt)
    && (value.status === "active" || value.status === "restored")
    && Array.isArray(value.files)
    && value.files.every(file => isRecord(file)
      && isNonEmptyString(file.path)
      && isWorkspaceFileSnapshot(file.before)
      && (file.expectedAfterSha256 === null || isSha256(file.expectedAfterSha256))
      && (file.afterContent === null || typeof file.afterContent === "string"));
}

function isPlanRecord(value: unknown): boolean {
  return isRecord(value)
    && isNonEmptyString(value.id)
    && isNonEmptyString(value.sessionId)
    && isNonEmptyString(value.title)
    && isNonEmptyString(value.summary)
    && typeof value.confidence === "number"
    && value.confidence >= 0
    && value.confidence <= 100
    && isStringArray(value.affectedFiles)
    && Array.isArray(value.steps)
    && value.steps.every(isPlanStep)
    && isPlanStatus(value.status)
    && isNonEmptyString(value.createdAt)
    && isNonEmptyString(value.updatedAt)
    && (value.message === undefined || typeof value.message === "string");
}

function isPlanStep(value: unknown): boolean {
  return isRecord(value)
    && isNonEmptyString(value.id)
    && isNonEmptyString(value.title)
    && isNonEmptyString(value.description)
    && isStringArray(value.affectedFiles)
    && isStringArray(value.capabilities);
}

function isJournalEntry(value: unknown): boolean {
  return isRecord(value)
    && Number.isInteger(value.sequence)
    && Number(value.sequence) > 0
    && isNonEmptyString(value.recordedAt)
    && isAgentEvent(value.event);
}

function isWorkbenchSnapshot(value: unknown): boolean {
  return isRecord(value)
    && (value.activeSessionId === undefined || isNonEmptyString(value.activeSessionId))
    && (value.activeRunId === undefined || isNonEmptyString(value.activeRunId))
    && (value.sessionStatus === "none" || isSessionStatus(value.sessionStatus))
    && Array.isArray(value.chatMessages)
    && value.chatMessages.every(message => isRecord(message)
      && isNonEmptyString(message.id)
      && (message.role === "user" || message.role === "assistant")
      && typeof message.content === "string"
      && (message.state === "streaming" || message.state === "completed"))
    && Array.isArray(value.plans)
    && value.plans.every(plan => isRecord(plan)
      && isNonEmptyString(plan.planId)
      && isNonEmptyString(plan.title)
      && isNonEmptyString(plan.summary)
      && typeof plan.confidence === "number"
      && isStringArray(plan.affectedFiles)
      && Array.isArray(plan.steps)
      && plan.steps.every(isPlanStep)
      && isPlanStatus(plan.status))
    && isStringArray(value.affectedFiles)
    && Array.isArray(value.pendingPermissions)
    && value.pendingPermissions.every(permission => isRecord(permission)
      && isNonEmptyString(permission.requestId)
      && isNonEmptyString(permission.toolCallId)
      && isNonEmptyString(permission.toolName)
      && isToolRiskLevel(permission.riskLevel)
      && isStringArray(permission.capabilities)
      && isStringArray(permission.affectedFiles)
      && isNonEmptyString(permission.reason))
    && Array.isArray(value.tools)
    && value.tools.every(tool => isRecord(tool)
      && isNonEmptyString(tool.toolCallId)
      && isNonEmptyString(tool.toolName)
      && isNonEmptyString(tool.description)
      && isToolRiskLevel(tool.riskLevel)
      && isStringArray(tool.capabilities)
      && isStringArray(tool.affectedFiles)
      && isStringArray(tool.networkTargets)
      && isStringArray(tool.commands)
      && isStringArray(tool.progressMessages)
      && (tool.state === "requested" || tool.state === "running"
        || tool.state === "completed" || tool.state === "failed"))
    && Array.isArray(value.diffProposals)
    && value.diffProposals.every(proposal => isRecord(proposal)
      && isNonEmptyString(proposal.proposalId)
      && (proposal.status === "proposed" || proposal.status === "accepted"
        || proposal.status === "rejected" || proposal.status === "conflict")
      && isStringArray(proposal.affectedFiles)
      && (proposal.checkpointId === undefined || isNonEmptyString(proposal.checkpointId)))
    && Array.isArray(value.checkpoints)
    && value.checkpoints.every(checkpoint => isRecord(checkpoint)
      && isNonEmptyString(checkpoint.checkpointId)
      && (checkpoint.proposalId === undefined || isNonEmptyString(checkpoint.proposalId))
      && typeof checkpoint.restored === "boolean")
    && isRecord(value.usage)
    && isNonNegativeInteger(value.usage.inputTokens)
    && isNonNegativeInteger(value.usage.outputTokens)
    && typeof value.completed === "boolean"
    && typeof value.aborted === "boolean"
    && (value.failed === undefined || (isRecord(value.failed)
      && isNonEmptyString(value.failed.code)
      && isNonEmptyString(value.failed.message)));
}

function isAgentEvent(value: unknown): boolean {
  if (!isRecord(value) || !isNonEmptyString(value.type) || !isNonEmptyString(value.sessionId)) {
    return false;
  }

  switch (value.type) {
    case "session.created":
      return value.workspaceId === undefined || typeof value.workspaceId === "string";
    case "session.started":
      return isNonEmptyString(value.runId);
    case "user.message.added":
      return isNonEmptyString(value.messageId) && typeof value.content === "string";
    case "plan.created":
      return isNonEmptyString(value.planId)
        && isNonEmptyString(value.title)
        && isNonEmptyString(value.summary)
        && typeof value.confidence === "number"
        && value.confidence >= 0
        && value.confidence <= 100
        && isStringArray(value.affectedFiles)
        && Array.isArray(value.steps)
        && value.steps.every(isPlanStep)
        && value.status === "reviewing"
        && isNonEmptyString(value.createdAt);
    case "plan.resolved":
      return isNonEmptyString(value.planId)
        && (value.decision === "approved" || value.decision === "rejected")
        && isNonEmptyString(value.updatedAt);
    case "plan.status.changed":
      return isNonEmptyString(value.planId)
        && (value.status === "executing" || value.status === "completed"
          || value.status === "failed" || value.status === "cancelled")
        && isNonEmptyString(value.updatedAt)
        && (value.message === undefined || typeof value.message === "string");
    case "model.started":
      return Number.isInteger(value.turn) && Number(value.turn) > 0;
    case "assistant.started":
      return isNonEmptyString(value.messageId)
        && Number.isInteger(value.turn)
        && Number(value.turn) > 0;
    case "assistant.delta":
      return isNonEmptyString(value.messageId) && typeof value.delta === "string";
    case "assistant.completed":
      return isNonEmptyString(value.messageId);
    case "session.usage.updated":
      return isNonNegativeInteger(value.inputTokens) && isNonNegativeInteger(value.outputTokens);
    case "tool.requested":
      return isNonEmptyString(value.toolCallId)
        && isNonEmptyString(value.toolName)
        && isNonEmptyString(value.description)
        && isToolRiskLevel(value.riskLevel)
        && isStringArray(value.capabilities);
    case "tool.inspected":
      return isNonEmptyString(value.toolCallId)
        && isNonEmptyString(value.toolName)
        && isToolRiskLevel(value.riskLevel)
        && isStringArray(value.affectedFiles)
        && isStringArray(value.networkTargets)
        && isStringArray(value.commands);
    case "tool.started":
      return isNonEmptyString(value.toolName) && isNonEmptyString(value.toolCallId);
    case "tool.progress":
      return isNonEmptyString(value.toolName)
        && isNonEmptyString(value.toolCallId)
        && isNonEmptyString(value.message);
    case "permission.requested":
      return isNonEmptyString(value.requestId)
        && isNonEmptyString(value.toolCallId)
        && isNonEmptyString(value.toolName)
        && isToolRiskLevel(value.riskLevel)
        && isStringArray(value.capabilities)
        && isStringArray(value.affectedFiles)
        && isNonEmptyString(value.reason);
    case "permission.resolved":
      return isNonEmptyString(value.requestId)
        && (value.decision === "allow" || value.decision === "deny");
    case "tool.completed":
      return isNonEmptyString(value.toolName)
        && isNonEmptyString(value.toolCallId)
        && typeof value.success === "boolean";
    case "diff.proposed":
      return isNonEmptyString(value.proposalId) && isStringArray(value.affectedFiles);
    case "diff.resolved":
      return isNonEmptyString(value.proposalId)
        && (value.decision === "accepted" || value.decision === "rejected" || value.decision === "conflict")
        && (value.checkpointId === undefined || isNonEmptyString(value.checkpointId));
    case "checkpoint.created":
      return isNonEmptyString(value.checkpointId) && isNonEmptyString(value.proposalId);
    case "checkpoint.restored":
      return isNonEmptyString(value.checkpointId) && isStringArray(value.affectedFiles);
    case "session.completed":
    case "session.aborted":
      return true;
    case "session.failed":
      return isNonEmptyString(value.code) && isNonEmptyString(value.message);
    default:
      return false;
  }
}

function isEventPayload(method: IpcEventMethod, value: unknown): boolean {
  switch (method) {
    case "agent.event":
      return isAgentEvent(value);
    case "workbench.snapshot.changed":
      return isWorkbenchSnapshot(value);
    case "runtime.health.changed":
      return isRecord(value)
        && typeof value.healthy === "boolean"
        && (value.reason === undefined || typeof value.reason === "string");
  }
}

export function isIpcMessage(value: unknown): value is IpcMessage {
  if (!isRecord(value) || typeof value.kind !== "string") {
    return false;
  }

  if (value.kind === "request") {
    if (typeof value.id !== "string" || typeof value.method !== "string" || !REQUEST_METHODS.has(value.method)) {
      return false;
    }
    return isRequestParams(value.method as IpcRequestMethod, value.params);
  }

  if (value.kind === "response") {
    if (typeof value.id !== "string" || typeof value.ok !== "boolean") {
      return false;
    }
    if (value.ok) {
      return "result" in value;
    }
    return isRecord(value.error)
      && typeof value.error.code === "string"
      && ERROR_CODES.has(value.error.code)
      && typeof value.error.message === "string";
  }

  if (value.kind === "event") {
    if (typeof value.method !== "string" || !EVENT_METHODS.has(value.method)) {
      return false;
    }
    return isEventPayload(value.method as IpcEventMethod, value.payload);
  }

  return false;
}

function isPermissionMode(value: unknown): boolean {
  return value === "default" || value === "autoReview" || value === "fullAccess";
}

function isSessionStatus(value: unknown): boolean {
  return value === "idle" || value === "running" || value === "awaitingPermission"
    || value === "completed" || value === "failed" || value === "aborted";
}

function isPlanStatus(value: unknown): boolean {
  return value === "reviewing" || value === "approved" || value === "rejected"
    || value === "executing" || value === "completed" || value === "failed" || value === "cancelled";
}

function isToolRiskLevel(value: unknown): boolean {
  return value === "pure-compute" || value === "workspace-read" || value === "workspace-write"
    || value === "process" || value === "network" || value === "browser"
    || value === "computer-use" || value === "security-core";
}

function isSha256(value: unknown): boolean {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}
