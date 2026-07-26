import type { AgentMessage, ToolCall } from "../agent/types.js";

// JSON Schema 在模型边界只使用普通 JSON 对象，不绑定特定 Schema 库。
export type JsonSchema = Readonly<Record<string, unknown>>;

// 模型可见工具定义由 Tool Registry 生成。
export interface ModelToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
}

export interface ModelRequest {
  readonly systemPrompt: string;
  readonly messages: readonly AgentMessage[];
  readonly tools: readonly ModelToolDefinition[];
  readonly maxOutputTokens: number;
}

export interface ModelUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

// Provider 输出统一流事件，AgentLoop 不依赖 OpenAI 的原始响应结构。
export type ModelStreamEvent =
  | { type: "text.delta"; delta: string }
  | {
    type: "tool-call.delta";
    index: number;
    id?: string;
    name?: string;
    argumentsDelta?: string;
  }
  | {
    type: "response.completed";
    finishReason: "stop" | "tool_calls";
    usage: ModelUsage;
  };

export interface ModelProvider {
  readonly id: string;
  stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelStreamEvent>;
}

export interface AssembledModelResponse {
  readonly text: string;
  readonly toolCalls: readonly ToolCall[];
  readonly finishReason: "stop" | "tool_calls";
  readonly usage: ModelUsage;
}
