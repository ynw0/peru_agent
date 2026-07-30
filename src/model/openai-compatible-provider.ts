import { AgentError } from "../agent/errors.js";
import type { AgentMessage } from "../agent/types.js";
import type {
  ModelProvider,
  ModelRequest,
  ModelStreamEvent,
} from "./types.js";
import {
  validateProviderConfig,
  type OpenAICompatibleProviderConfig,
} from "../model-gateway.js";

// 凭据解析器只根据引用读取密钥；Provider 配置中不保存明文密钥。
export interface CredentialResolver {
  resolve(reference: string): Promise<string>;
}

export interface OpenAICompatibleProviderDependencies {
  readonly credentialResolver: CredentialResolver;
  readonly fetchImplementation?: typeof fetch;
}

interface OpenAIStreamToolCallDelta {
  readonly index?: unknown;
  readonly id?: unknown;
  readonly function?: {
    readonly name?: unknown;
    readonly arguments?: unknown;
  };
}

interface OpenAIStreamChunk {
  readonly choices?: readonly {
    readonly delta?: {
      readonly content?: unknown;
      readonly tool_calls?: readonly OpenAIStreamToolCallDelta[];
    };
    readonly finish_reason?: unknown;
  }[];
  readonly usage?: {
    readonly prompt_tokens?: unknown;
    readonly completion_tokens?: unknown;
  };
}

function mapMessage(message: AgentMessage): Record<string, unknown> {
  if (message.role === "summary") {
    return { role: "system", content: `会话摘要：${message.content}` };
  }
  if (message.role === "user") {
    return {
      role: "user",
      content: message.attachments === undefined || message.attachments.length === 0
        ? message.content
        : `${message.content}\n\n附件：\n${message.attachments.map(item => `--- ${item.path} (${item.sha256}, ${item.byteLength} bytes) ---\n${item.content ?? "二进制附件；请使用对应文件 Tool 读取。"}`).join("\n")}`,
    };
  }

  if (message.role === "tool") {
    return {
      role: "tool",
      tool_call_id: message.toolCallId,
      content: message.content,
    };
  }

  return {
    role: "assistant",
    content: message.content,
    ...(message.toolCalls.length === 0
      ? {}
      : {
        tool_calls: message.toolCalls.map(call => ({
          id: call.id,
          type: "function",
          function: {
            name: call.name,
            arguments: JSON.stringify(call.arguments),
          },
        })),
      }),
  };
}

function parseChunk(text: string): OpenAIStreamChunk {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : "未知 JSON 错误";
    throw new AgentError("MODEL_PROTOCOL_ERROR", `模型 SSE 数据不是有效 JSON：${reason}`);
  }

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AgentError("MODEL_PROTOCOL_ERROR", "模型 SSE 数据必须是 JSON 对象");
  }
  return value as OpenAIStreamChunk;
}

function readUsage(chunk: OpenAIStreamChunk): { inputTokens: number; outputTokens: number } | undefined {
  const inputTokens = chunk.usage?.prompt_tokens;
  const outputTokens = chunk.usage?.completion_tokens;
  if (inputTokens === undefined && outputTokens === undefined) {
    return undefined;
  }
  if (!Number.isInteger(inputTokens) || Number(inputTokens) < 0
    || !Number.isInteger(outputTokens) || Number(outputTokens) < 0) {
    throw new AgentError("MODEL_PROTOCOL_ERROR", "模型返回了无效 Token 用量");
  }
  return {
    inputTokens: Number(inputTokens),
    outputTokens: Number(outputTokens),
  };
}

// 该 Provider 明确实现 OpenAI Chat Completions 流协议，不猜测其他私有格式。
export class OpenAICompatibleProvider implements ModelProvider {
  public readonly id: string;
  private readonly endpoint: URL;
  private readonly fetchImplementation: typeof fetch;

  public constructor(
    private readonly config: OpenAICompatibleProviderConfig,
    private readonly dependencies: OpenAICompatibleProviderDependencies,
  ) {
    const baseUrl = validateProviderConfig(config);
    this.endpoint = new URL(config.chatCompletionsPath.replace(/^\//, ""), `${baseUrl.toString().replace(/\/$/, "")}/`);
    this.fetchImplementation = dependencies.fetchImplementation ?? fetch;
    this.id = `openai-compatible:${config.model}`;
  }

  public async *stream(
    request: ModelRequest,
    signal: AbortSignal,
  ): AsyncIterable<ModelStreamEvent> {
    const apiKey = await this.dependencies.credentialResolver.resolve(this.config.apiKeyReference);
    if (apiKey.trim() === "") {
      throw new AgentError("MODEL_REQUEST_FAILED", "凭据引用解析结果为空");
    }

    let response: Response;
    try {
      response = await this.fetchImplementation(this.endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json; charset=utf-8",
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: this.config.model,
          messages: [
            { role: "system", content: request.systemPrompt },
            ...request.messages.map(mapMessage),
          ],
          tools: request.tools.map(tool => ({
            type: "function",
            function: {
              name: tool.name,
              description: tool.description,
              parameters: tool.inputSchema,
            },
          })),
          tool_choice: "auto",
          stream: true,
          stream_options: { include_usage: true },
          max_tokens: request.maxOutputTokens,
        }),
        signal,
      });
    } catch (error: unknown) {
      if (signal.aborted) {
        throw new AgentError("RUN_ABORTED", "模型请求已取消");
      }
      const reason = error instanceof Error ? error.message : "未知网络错误";
      throw new AgentError("MODEL_REQUEST_FAILED", `模型请求失败：${reason}`);
    }

    if (!response.ok) {
      const body = await response.text();
      throw new AgentError(
        "MODEL_REQUEST_FAILED",
        `模型服务返回 HTTP ${response.status}：${body.slice(0, 500)}`,
      );
    }
    if (response.body === null) {
      throw new AgentError("MODEL_PROTOCOL_ERROR", "模型服务没有返回流式响应体");
    }

    let finishReason: "stop" | "tool_calls" | undefined;
    let usage: { inputTokens: number; outputTokens: number } | undefined;
    let buffer = "";
    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true });

    while (true) {
      const readResult = await reader.read();
      buffer += decoder.decode(readResult.value, { stream: !readResult.done });
      const records = buffer.split(/\r?\n\r?\n/);
      buffer = records.pop() ?? "";
      // 某些服务在关闭流前不会补最后一个空行；结束时仍要处理剩余完整记录。
      if (readResult.done && buffer.trim() !== "") {
        records.push(buffer);
        buffer = "";
      }

      for (const record of records) {
        const dataLines = record
          .split(/\r?\n/)
          .filter(line => line.startsWith("data:"))
          .map(line => line.slice(5).trimStart());
        if (dataLines.length === 0) {
          continue;
        }
        const data = dataLines.join("\n");
        if (data === "[DONE]") {
          continue;
        }

        const chunk = parseChunk(data);
        const chunkUsage = readUsage(chunk);
        if (chunkUsage !== undefined) {
          usage = chunkUsage;
        }

        for (const choice of chunk.choices ?? []) {
          if (typeof choice.delta?.content === "string" && choice.delta.content !== "") {
            yield { type: "text.delta", delta: choice.delta.content };
          }

          for (const toolCall of choice.delta?.tool_calls ?? []) {
            if (!Number.isInteger(toolCall.index) || Number(toolCall.index) < 0) {
              throw new AgentError("MODEL_PROTOCOL_ERROR", "模型 ToolCall 缺少有效 index");
            }
            yield {
              type: "tool-call.delta",
              index: Number(toolCall.index),
              ...(typeof toolCall.id === "string" ? { id: toolCall.id } : {}),
              ...(typeof toolCall.function?.name === "string"
                ? { name: toolCall.function.name }
                : {}),
              ...(typeof toolCall.function?.arguments === "string"
                ? { argumentsDelta: toolCall.function.arguments }
                : {}),
            };
          }

          if (choice.finish_reason !== null && choice.finish_reason !== undefined) {
            if (choice.finish_reason !== "stop" && choice.finish_reason !== "tool_calls") {
              throw new AgentError(
                "MODEL_PROTOCOL_ERROR",
                `不支持的模型 finish_reason：${String(choice.finish_reason)}`,
              );
            }
            finishReason = choice.finish_reason;
          }
        }
      }

      if (readResult.done) {
        break;
      }
    }

    if (finishReason === undefined) {
      throw new AgentError("MODEL_PROTOCOL_ERROR", "模型流结束时缺少 finish_reason");
    }
    if (usage === undefined) {
      throw new AgentError("MODEL_USAGE_MISSING", "模型流缺少 Token 用量，无法执行预算限制");
    }

    yield { type: "response.completed", finishReason, usage };
  }
}
