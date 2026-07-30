import type { Capability, PermissionMode } from "../agent-protocol.js";

// ToolCall 是模型提出的结构化工具调用；arguments 必须是已经解析完成的 JSON 对象。
export interface ToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: unknown;
}

export interface AgentUserAttachment {
  readonly kind: "workspace-file" | "external-file";
  readonly path: string;
  readonly content?: string;
  readonly sha256: string;
  readonly byteLength: number;
  readonly mediaType?: string;
  readonly binary?: boolean;
}

export interface AgentUserInput {
  readonly content: string;
  readonly displayContent?: string;
  readonly attachments?: readonly AgentUserAttachment[];
}

export interface SessionCompactionResult {
  readonly summary: string;
  readonly sourceMessageCount: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export type AgentQueuePriority = "guide" | "next" | "immediate";

export interface AgentQueuedInput {
  readonly id: string;
  readonly priority: AgentQueuePriority;
  readonly input: AgentUserInput;
  readonly createdAt: string;
}

// 用户消息只包含用户可见文本。
export interface UserAgentMessage {
  readonly id: string;
  readonly role: "user";
  readonly content: string;
  readonly displayContent?: string;
  readonly attachments?: readonly AgentUserAttachment[];
}

export interface SummaryAgentMessage {
  readonly id: string;
  readonly role: "summary";
  readonly content: string;
  readonly compactedAt: string;
  readonly sourceMessageCount: number;
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

export type AgentMessage = UserAgentMessage | AssistantAgentMessage | ToolAgentMessage | SummaryAgentMessage;

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
  readonly title?: string;
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
    readonly lastInputTokens?: number;
    readonly lastOutputTokens?: number;
    readonly runCount?: number;
    readonly toolCallCount?: number;
    readonly contextTokens?: number;
  };
  readonly compaction?: { readonly compactedAt: string; readonly count: number };
  readonly pendingInputs?: readonly AgentQueuedInput[];
}

// 每次运行都有硬限制，达到限制后必须明确失败，不能静默继续或自动换模型。
export interface AgentRunLimits {
  readonly maxTurns: number;
  readonly maxToolCalls: number;
  readonly maxTotalTokens: number;
}


export interface AgentRunPolicy {
  readonly allowedCapabilities?: readonly Capability[];
  readonly allowedToolNames?: readonly string[];
  readonly workspaceWriteMode?: "interactiveDiff" | "isolatedAutoApply";
}

export interface AgentRunOptions {
  readonly limits?: AgentRunLimits;
  readonly allowedCapabilities?: readonly Capability[];
  readonly allowedToolNames?: readonly string[];
  readonly workspaceWriteMode?: "interactiveDiff" | "isolatedAutoApply";
}
