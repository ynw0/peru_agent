import type {
  AgentEvent,
  Capability,
  NetworkMode,
  PermissionMode,
} from "../agent-protocol.js";
import type { WorkbenchSnapshot } from "../workbench/workbench-state.js";

// IPC 协议版本必须显式匹配；版本不一致时拒绝连接，不做隐式兼容。
export const IPC_PROTOCOL_VERSION = 1 as const;

// IDE 启动后先发送初始化请求，确认运行时协议、语言和安全模式。
export interface RuntimeInitializeRequest {
  readonly protocolVersion: typeof IPC_PROTOCOL_VERSION;
  readonly clientId: string;
  readonly locale: "zh-CN" | "en-US";
  readonly permissionMode: PermissionMode;
  readonly networkMode: NetworkMode;
}

// 运行时返回自身身份和已启用能力，供 IDE 构建初始界面。
export interface RuntimeInitializeResult {
  readonly runtimeId: string;
  readonly protocolVersion: typeof IPC_PROTOCOL_VERSION;
  readonly enabledCapabilities: readonly Capability[];
}

// 创建会话时只传工作区标识；模型和权限设置来自已初始化的运行时配置。
export interface CreateSessionRequest {
  readonly workspaceId: string;
}

export interface CreateSessionResult {
  readonly sessionId: string;
}

// 权限决定必须对应明确的请求 ID，避免错误批准另一个操作。
export interface ResolvePermissionRequest {
  readonly requestId: string;
  readonly decision: "allow" | "deny";
}

export interface ResolvePermissionResult {
  readonly accepted: true;
}

// 请求方法表同时定义参数和返回值，是 Typed IPC 的唯一事实来源。
export interface IpcRequestMap {
  readonly "runtime.initialize": {
    readonly params: RuntimeInitializeRequest;
    readonly result: RuntimeInitializeResult;
  };
  readonly "session.create": {
    readonly params: CreateSessionRequest;
    readonly result: CreateSessionResult;
  };
  readonly "permission.resolve": {
    readonly params: ResolvePermissionRequest;
    readonly result: ResolvePermissionResult;
  };
  readonly "workbench.getSnapshot": {
    readonly params: Record<string, never>;
    readonly result: WorkbenchSnapshot;
  };
}

// 事件方法表描述运行时主动推送给 IDE 的消息。
export interface IpcEventMap {
  readonly "agent.event": AgentEvent;
  readonly "workbench.snapshot.changed": WorkbenchSnapshot;
  readonly "runtime.health.changed": {
    readonly healthy: boolean;
    readonly reason?: string;
  };
}

export type IpcRequestMethod = keyof IpcRequestMap;
export type IpcEventMethod = keyof IpcEventMap;

// 映射类型会把请求方法展开为严格区分的消息联合类型。
export type IpcRequestMessage = {
  readonly [Method in IpcRequestMethod]: {
    readonly kind: "request";
    readonly id: string;
    readonly method: Method;
    readonly params: IpcRequestMap[Method]["params"];
  };
}[IpcRequestMethod];

// 成功响应通过请求 ID 与原请求配对。
export interface IpcSuccessResponseMessage {
  readonly kind: "response";
  readonly id: string;
  readonly ok: true;
  readonly result: unknown;
}

// 错误响应只传可公开错误码和消息，不传任意异常对象。
export interface IpcErrorResponseMessage {
  readonly kind: "response";
  readonly id: string;
  readonly ok: false;
  readonly error: {
    readonly code: IpcErrorCode;
    readonly message: string;
  };
}

export type IpcResponseMessage = IpcSuccessResponseMessage | IpcErrorResponseMessage;

export type IpcEventMessage = {
  readonly [Method in IpcEventMethod]: {
    readonly kind: "event";
    readonly method: Method;
    readonly payload: IpcEventMap[Method];
  };
}[IpcEventMethod];

export type IpcMessage = IpcRequestMessage | IpcResponseMessage | IpcEventMessage;

// 错误码固定为有限集合，UI 可以稳定映射中英文提示。
export type IpcErrorCode =
  | "INVALID_MESSAGE"
  | "METHOD_NOT_FOUND"
  | "HANDLER_NOT_REGISTERED"
  | "HANDLER_FAILED"
  | "REQUEST_ABORTED"
  | "REQUEST_TIMEOUT"
  | "PROTOCOL_VERSION_MISMATCH";
