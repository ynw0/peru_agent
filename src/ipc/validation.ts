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

// 每个请求方法都执行独立参数校验，TypeScript 类型不能代替进程边界检查。
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
    case "permission.resolve":
      return hasOnlyKeys(value, ["requestId", "decision"])
        && isNonEmptyString(value.requestId)
        && (value.decision === "allow" || value.decision === "deny");
    case "workbench.getSnapshot":
      return Object.keys(value).length === 0;
  }
}

function isWorkbenchSnapshot(value: unknown): boolean {
  if (!isRecord(value)
    || !isStringArray(value.affectedFiles)
    || !Array.isArray(value.pendingPermissions)
    || !Array.isArray(value.tools)
    || typeof value.completed !== "boolean") {
    return false;
  }

  if (value.activeSessionId !== undefined && !isNonEmptyString(value.activeSessionId)) {
    return false;
  }
  if (value.lastPlanConfidence !== undefined
    && (typeof value.lastPlanConfidence !== "number"
      || value.lastPlanConfidence < 0
      || value.lastPlanConfidence > 100)) {
    return false;
  }

  return value.pendingPermissions.every(permission =>
    isRecord(permission)
      && isNonEmptyString(permission.requestId)
      && isStringArray(permission.capabilities),
  ) && value.tools.every(tool =>
    isRecord(tool)
      && isNonEmptyString(tool.toolName)
      && (tool.state === "requested" || tool.state === "completed" || tool.state === "failed"),
  );
}

// Client 和 Server 都使用同一结果校验，防止一侧返回错误结构。
export function isResponseResult(method: IpcRequestMethod, value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }

  switch (method) {
    case "runtime.initialize":
      return isNonEmptyString(value.runtimeId)
        && value.protocolVersion === IPC_PROTOCOL_VERSION
        && isStringArray(value.enabledCapabilities);
    case "session.create":
      return isNonEmptyString(value.sessionId);
    case "permission.resolve":
      return value.accepted === true;
    case "workbench.getSnapshot":
      return isWorkbenchSnapshot(value);
  }
}

function isAgentEvent(value: unknown): boolean {
  if (!isRecord(value) || !isNonEmptyString(value.type) || !isNonEmptyString(value.sessionId)) {
    return false;
  }

  switch (value.type) {
    case "session.created":
    case "session.completed":
      return true;
    case "plan.created":
      return typeof value.confidence === "number"
        && value.confidence >= 0
        && value.confidence <= 100
        && isStringArray(value.affectedFiles);
    case "tool.requested":
      return isNonEmptyString(value.toolName) && isStringArray(value.capabilities);
    case "permission.requested":
      return isNonEmptyString(value.requestId) && isStringArray(value.capabilities);
    case "permission.resolved":
      return isNonEmptyString(value.requestId)
        && (value.decision === "allow" || value.decision === "deny");
    case "tool.completed":
      return isNonEmptyString(value.toolName) && typeof value.success === "boolean";
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
  "permission.resolve",
  "workbench.getSnapshot",
]);

const EVENT_METHODS: ReadonlySet<string> = new Set<IpcEventMethod>([
  "agent.event",
  "workbench.snapshot.changed",
  "runtime.health.changed",
]);

// IPC 边界收到的是不可信数据，必须校验消息类型和对应方法的数据结构。
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
