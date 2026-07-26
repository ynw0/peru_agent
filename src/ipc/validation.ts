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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every(item => typeof item === "string");
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowedKeys = new Set(keys);
  return Object.keys(value).every(key => allowedKeys.has(key));
}

export function isRequestParams(method: IpcRequestMethod, value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }

  switch (method) {
    case "runtime.initialize":
      return hasOnlyKeys(value, [
        "protocolVersion",
        "clientId",
        "locale",
        "permissionMode",
        "networkMode",
      ])
        && value.protocolVersion === IPC_PROTOCOL_VERSION
        && isNonEmptyString(value.clientId)
        && (value.locale === "zh-CN" || value.locale === "en-US")
        && (value.permissionMode === "default"
          || value.permissionMode === "autoReview"
          || value.permissionMode === "fullAccess")
        && (value.networkMode === "offline"
          || value.networkMode === "lan"
          || value.networkMode === "internet");
    case "session.create":
      return hasOnlyKeys(value, ["workspaceId"])
        && isNonEmptyString(value.workspaceId);
    case "session.start":
      return hasOnlyKeys(value, ["sessionId", "input"])
        && isNonEmptyString(value.sessionId)
        && isNonEmptyString(value.input);
    case "session.abort":
    case "session.get":
      return hasOnlyKeys(value, ["sessionId"])
        && isNonEmptyString(value.sessionId);
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
      return hasOnlyKeys(value, ["workspaceId"])
        && (value.workspaceId === undefined || isNonEmptyString(value.workspaceId));
    case "diff.get":
    case "diff.accept":
    case "diff.reject":
      return hasOnlyKeys(value, ["proposalId"])
        && isNonEmptyString(value.proposalId);
    case "checkpoint.restore":
      return hasOnlyKeys(value, ["checkpointId"])
        && isNonEmptyString(value.checkpointId);
    case "workbench.getSnapshot":
      return Object.keys(value).length === 0;
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
    case "permission.resolve":
      return isRecord(value) && typeof value.accepted === "boolean";
    case "workspace.register":
      return isRecord(value) && value.registered === true;
    case "workspace.read":
      return isWorkspaceFileSnapshot(value);
    case "diff.list":
      return isRecord(value) && Array.isArray(value.proposals)
        && value.proposals.every(isDiffProposal);
    case "diff.get":
    case "diff.accept":
    case "diff.reject":
      return isDiffProposal(value);
    case "checkpoint.list":
      return isRecord(value) && Array.isArray(value.checkpoints)
        && value.checkpoints.every(isCheckpointRecord);
    case "checkpoint.restore":
      return isCheckpointRecord(value);
    case "workbench.getSnapshot":
      return isWorkbenchSnapshot(value);
  }
}

function isAgentSessionSnapshot(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  return isNonEmptyString(value.id)
    && isNonEmptyString(value.workspaceId)
    && (value.permissionMode === "default"
      || value.permissionMode === "autoReview"
      || value.permissionMode === "fullAccess")
    && (value.status === "idle"
      || value.status === "running"
      || value.status === "awaitingPermission"
      || value.status === "completed"
      || value.status === "failed"
      || value.status === "aborted")
    && Array.isArray(value.messages)
    && isNonEmptyString(value.createdAt)
    && isNonEmptyString(value.updatedAt)
    && isRecord(value.usage)
    && Number.isInteger(value.usage.inputTokens)
    && Number(value.usage.inputTokens) >= 0
    && Number.isInteger(value.usage.outputTokens)
    && Number(value.usage.outputTokens) >= 0;
}


function isWorkspaceFileSnapshot(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  return isNonEmptyString(value.path)
    && typeof value.exists === "boolean"
    && (value.content === null || typeof value.content === "string")
    && (value.sha256 === null || (typeof value.sha256 === "string" && /^[a-f0-9]{64}$/.test(value.sha256)))
    && Number.isInteger(value.byteLength)
    && Number(value.byteLength) >= 0;
}

function isDiffProposal(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  return isNonEmptyString(value.id)
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
      && typeof change.afterSha256 === "string"
      && /^[a-f0-9]{64}$/.test(change.afterSha256)
      && typeof change.unifiedDiff === "string")
    && (value.checkpointId === undefined || isNonEmptyString(value.checkpointId))
    && (value.conflictMessage === undefined || typeof value.conflictMessage === "string");
}

function isCheckpointRecord(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  return isNonEmptyString(value.id)
    && isNonEmptyString(value.workspaceId)
    && isNonEmptyString(value.sessionId)
    && isNonEmptyString(value.proposalId)
    && isNonEmptyString(value.createdAt)
    && (value.status === "active" || value.status === "restored")
    && Array.isArray(value.files)
    && value.files.every(file => isRecord(file)
      && isNonEmptyString(file.path)
      && isWorkspaceFileSnapshot(file.before)
      && (file.expectedAfterSha256 === null
        || (typeof file.expectedAfterSha256 === "string" && /^[a-f0-9]{64}$/.test(file.expectedAfterSha256)))
      && (file.afterContent === null || typeof file.afterContent === "string"));
}

function isWorkbenchSnapshot(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  return (value.activeSessionId === undefined || typeof value.activeSessionId === "string")
    && (value.lastPlanConfidence === undefined || typeof value.lastPlanConfidence === "number")
    && isStringArray(value.affectedFiles)
    && Array.isArray(value.pendingPermissions)
    && Array.isArray(value.tools)
    && typeof value.completed === "boolean";
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
    case "session.completed":
    case "session.aborted":
      return true;
    case "session.failed":
      return isNonEmptyString(value.code) && isNonEmptyString(value.message);
    case "plan.created":
      return typeof value.confidence === "number"
        && value.confidence >= 0
        && value.confidence <= 100
        && isStringArray(value.affectedFiles);
    case "model.started":
      return Number.isInteger(value.turn) && Number(value.turn) > 0;
    case "assistant.delta":
      return typeof value.delta === "string";
    case "assistant.completed":
      return isNonEmptyString(value.messageId);
    case "tool.requested":
      return isNonEmptyString(value.toolName) && isStringArray(value.capabilities);
    case "tool.inspected":
      return isNonEmptyString(value.toolName) && isStringArray(value.affectedFiles);
    case "tool.started":
      return isNonEmptyString(value.toolName) && isNonEmptyString(value.toolCallId);
    case "tool.progress":
      return isNonEmptyString(value.toolName)
        && isNonEmptyString(value.toolCallId)
        && isNonEmptyString(value.message);
    case "permission.requested":
      return isNonEmptyString(value.requestId) && isStringArray(value.capabilities);
    case "permission.resolved":
      return isNonEmptyString(value.requestId)
        && (value.decision === "allow" || value.decision === "deny");
    case "tool.completed":
      return isNonEmptyString(value.toolName)
        && typeof value.success === "boolean"
        && (value.toolCallId === undefined || typeof value.toolCallId === "string");
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

const REQUEST_METHODS: ReadonlySet<string> = new Set<IpcRequestMethod>([
  "runtime.initialize",
  "session.create",
  "session.start",
  "session.abort",
  "session.get",
  "permission.resolve",
  "workspace.register",
  "workspace.read",
  "diff.list",
  "diff.get",
  "diff.accept",
  "diff.reject",
  "checkpoint.list",
  "checkpoint.restore",
  "workbench.getSnapshot",
]);

const EVENT_METHODS: ReadonlySet<string> = new Set<IpcEventMethod>([
  "agent.event",
  "workbench.snapshot.changed",
  "runtime.health.changed",
]);

export function isIpcMessage(value: unknown): value is IpcMessage {
  if (!isRecord(value) || typeof value.kind !== "string") {
    return false;
  }

  if (value.kind === "request") {
    if (typeof value.id !== "string"
      || typeof value.method !== "string"
      || !REQUEST_METHODS.has(value.method)) {
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
