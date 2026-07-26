import type { Capability, PermissionMode } from "../agent-protocol.js";

// ToolCall 是模型提出的结构化工具调用；arguments 必须是已经解析完成的 JSON 对象。
export interface ToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: unknown;
}

// 用户消息只包含用户可见文本。
export interface UserAgentMessage {
  readonly id: string;
  readonly role: "user";
  readonly content: string;
}

// Assistant 消息可以包含普通文本，也可以同时提出一个或多个 ToolCall。
export interface AssistantAgentMessage {
  readonly id: string;
  readonly role: "assistant";
  readonly content: string;
  readonly toolCalls: readonly ToolCall[];
}

// Tool 消息把执行结果送回模型，并通过 toolCallId 与原调用严格配对。
export interface ToolAgentMessage {
  readonly id: string;
  readonly role: "tool";
  readonly toolCallId: string;
  readonly toolName: string;
  readonly content: string;
  readonly isError: boolean;
}

export type AgentMessage = UserAgentMessage | AssistantAgentMessage | ToolAgentMessage;

export type AgentSessionStatus =
  | "idle"
  | "running"
  | "awaitingPermission"
  | "completed"
  | "failed"
  | "aborted";

// AgentSessionSnapshot 是可以持久化和通过 IPC 返回的会话状态。
export interface AgentSessionSnapshot {
  readonly id: string;
  readonly workspaceId: string;
  readonly permissionMode: PermissionMode;
  readonly status: AgentSessionStatus;
  readonly messages: readonly AgentMessage[];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly activeRunId?: string;
  readonly lastError?: {
    readonly code: string;
    readonly message: string;
  };
  readonly usage: {
    readonly inputTokens: number;
    readonly outputTokens: number;
  };
}

// 每次运行都有硬限制，达到限制后必须明确失败，不能静默继续或自动换模型。
export interface AgentRunLimits {
  readonly maxTurns: number;
  readonly maxToolCalls: number;
  readonly maxTotalTokens: number;
}


export interface AgentRunPolicy {
  readonly allowedCapabilities?: readonly Capability[];
}

export interface AgentRunOptions {
  readonly limits?: AgentRunLimits;
  readonly allowedCapabilities?: readonly Capability[];
}
