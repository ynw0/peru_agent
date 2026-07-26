import { validateCompletionCapability, type CompletionCapability } from "../completion-engine.js";
import type {
  CompletionProvider,
  CompletionProviderEvent,
  CompletionProviderProbeResult,
  CompletionRequest,
} from "./types.js";

export interface CompletionCredentialResolver {
  resolve(reference: string): Promise<string | undefined>;
}

export type FimRequestFormat =
  | { readonly kind: "openai-suffix" }
  | {
    readonly kind: "token-template";
    readonly prefixToken: string;
    readonly suffixToken: string;
    readonly middleToken: string;
  };

export interface OpenAiFimProviderConfig {
  readonly baseUrl: string;
  readonly completionsPath: string;
  readonly apiKeyReference: string;
  readonly model: string;
  readonly capability: CompletionCapability;
  readonly requestFormat: FimRequestFormat;
  readonly temperature: number;
  readonly stop: readonly string[];
}

export interface FetchLike {
  (input: string, init: RequestInit): Promise<Response>;
}

export class OpenAiFimProvider implements CompletionProvider {
  public readonly id: string;
  public readonly capability: CompletionCapability;
  private readonly endpoint: string;

  public constructor(
    private readonly config: OpenAiFimProviderConfig,
    private readonly credentials: CompletionCredentialResolver,
    private readonly fetcher: FetchLike = fetch,
  ) {
    validateCompletionCapability(config.capability);
    validateConfig(config);
    this.id = `openai-fim:${config.model}`;
    this.capability = config.capability;
    this.endpoint = resolveEndpoint(config.baseUrl, config.completionsPath);
  }

  public async *stream(request: CompletionRequest, signal: AbortSignal): AsyncIterable<CompletionProviderEvent> {
    const apiKey = await this.credentials.resolve(this.config.apiKeyReference);
    if (this.config.apiKeyReference.trim() !== "" && apiKey === undefined) {
      throw new Error(`未找到补全模型凭据引用：${this.config.apiKeyReference}`);
    }
    const response = await this.fetcher(this.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(apiKey === undefined ? {} : { authorization: `Bearer ${apiKey}` }),
      },
      body: JSON.stringify(this.createBody(request)),
      signal,
    });
    if (!response.ok) {
      throw new Error(`补全模型请求失败：HTTP ${response.status}`);
    }
    if (response.body === null) {
      throw new Error("补全模型未返回流式响应体");
    }

    let finishSeen = false;
    for await (const payload of readSseData(response.body, signal)) {
      if (payload === "[DONE]") {
        break;
      }
      const parsed = parseChunk(payload);
      if (parsed.text !== "") {
        yield { type: "text.delta", delta: parsed.text };
      }
      if (parsed.finishReason !== null) {
        finishSeen = true;
        yield {
          type: "response.completed",
          finishReason: parsed.finishReason,
          ...(parsed.outputTokens === undefined ? {} : { outputTokens: parsed.outputTokens }),
        };
      }
    }
    if (!finishSeen) {
      throw new Error("补全模型流缺少 finish_reason");
    }
  }

  public async probe(signal: AbortSignal): Promise<CompletionProviderProbeResult> {
    const request: CompletionRequest = {
      requestId: "completion-probe",
      documentUri: "probe://completion.ts",
      languageId: "typescript",
      documentVersion: 1,
      offset: 16,
      prefix: "const answer = ",
      suffix: ";\n",
      metadata: { imports: [], recentEdits: [], lspTypes: [], diagnostics: [], projectRules: [] },
      maxOutputTokens: 16,
    };
    const started = performance.now();
    let firstTokenAt: number | undefined;
    for await (const event of this.stream(request, signal)) {
      if (event.type === "text.delta" && event.delta !== "" && firstTokenAt === undefined) {
        firstTokenAt = performance.now();
      }
    }
    const completed = performance.now();
    if (firstTokenAt === undefined) {
      throw new Error("补全能力探测未收到文本增量");
    }

    // Fetch AbortSignal 是此 Provider 的唯一取消机制；通过独立已取消请求确认请求不会发送。
    const cancellationStarted = performance.now();
    const cancellationController = new AbortController();
    const cancellationRun = (async (): Promise<boolean> => {
      try {
        for await (const _event of this.stream(request, cancellationController.signal)) {
          // 探测只关心取消是否真正终止流。
        }
        return false;
      } catch (error: unknown) {
        if (error instanceof Error && error.name === "AbortError") {
          return true;
        }
        throw error;
      }
    })();
    queueMicrotask(() => cancellationController.abort());
    if (!await cancellationRun) {
      throw new Error("补全 Provider 未遵守取消信号");
    }

    return {
      capability: this.capability,
      modelId: this.config.model,
      firstTokenLatencyMs: firstTokenAt - started,
      totalLatencyMs: completed - started,
      cancellationLatencyMs: performance.now() - cancellationStarted,
    };
  }

  private createBody(request: CompletionRequest): Record<string, unknown> {
    const metadata = formatMetadata(request);
    if (this.config.requestFormat.kind === "openai-suffix") {
      return {
        model: this.config.model,
        prompt: metadata + request.prefix,
        suffix: request.suffix,
        max_tokens: request.maxOutputTokens,
        temperature: this.config.temperature,
        stream: true,
        stop: this.config.stop,
      };
    }
    const template = this.config.requestFormat;
    return {
      model: this.config.model,
      prompt: `${metadata}${template.prefixToken}${request.prefix}${template.suffixToken}${request.suffix}${template.middleToken}`,
      max_tokens: request.maxOutputTokens,
      temperature: this.config.temperature,
      stream: true,
      stop: this.config.stop,
    };
  }
}

function validateConfig(config: OpenAiFimProviderConfig): void {
  if (config.model.trim() === "" || config.apiKeyReference.trim() === "") {
    throw new Error("补全模型名称和凭据引用不能为空");
  }
  if (!config.completionsPath.startsWith("/") || config.completionsPath.includes("..")) {
    throw new Error("Completions 路径必须是无上级跳转的绝对路径");
  }
  if (!Number.isFinite(config.temperature) || config.temperature < 0 || config.temperature > 2) {
    throw new Error("补全温度必须位于 0 到 2");
  }
  const url = new URL(config.baseUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("补全模型地址必须使用 HTTP 或 HTTPS");
  }
  if (config.requestFormat.kind === "token-template"
    && [config.requestFormat.prefixToken, config.requestFormat.suffixToken, config.requestFormat.middleToken]
      .some(token => token === "")) {
    throw new Error("FIM Token 模板不能为空");
  }
}

function resolveEndpoint(baseUrl: string, path: string): string {
  const base = new URL(baseUrl);
  const normalizedBase = base.pathname.endsWith("/") ? base.pathname.slice(0, -1) : base.pathname;
  base.pathname = `${normalizedBase}${path}`.replace(/\/+/g, "/");
  return base.toString();
}

function formatMetadata(request: CompletionRequest): string {
  const parts = [
    request.metadata.currentFunction === undefined ? "" : `Current function:\n${request.metadata.currentFunction}`,
    request.metadata.imports.length === 0 ? "" : `Imports:\n${request.metadata.imports.join("\n")}`,
    request.metadata.lspTypes.length === 0 ? "" : `Types:\n${request.metadata.lspTypes.join("\n")}`,
    request.metadata.diagnostics.length === 0 ? "" : `Diagnostics:\n${request.metadata.diagnostics.join("\n")}`,
    request.metadata.projectRules.length === 0 ? "" : `Rules:\n${request.metadata.projectRules.join("\n")}`,
  ].filter(part => part !== "");
  return parts.length === 0 ? "" : `/* FIM context\n${parts.join("\n\n")}\n*/\n`;
}

async function* readSseData(stream: ReadableStream<Uint8Array>, signal: AbortSignal): AsyncIterable<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      if (signal.aborted) {
        throw abortError();
      }
      const item = await reader.read();
      if (item.done) {
        break;
      }
      buffer += decoder.decode(item.value, { stream: true });
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        for (const line of block.split("\n")) {
          if (line.startsWith("data:")) {
            yield line.slice(5).trim();
          }
        }
        boundary = buffer.indexOf("\n\n");
      }
    }
    buffer += decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

function parseChunk(payload: string): { readonly text: string; readonly finishReason: "stop" | "length" | null; readonly outputTokens?: number } {
  const value: unknown = JSON.parse(payload);
  if (!isRecord(value) || !Array.isArray(value.choices) || value.choices.length === 0) {
    throw new Error("补全 SSE 数据缺少 choices");
  }
  const choice = value.choices[0];
  if (!isRecord(choice)) {
    throw new Error("补全 SSE choice 结构无效");
  }
  const finish = choice.finish_reason;
  if (finish !== null && finish !== "stop" && finish !== "length") {
    throw new Error(`补全模型返回不支持的 finish_reason：${String(finish)}`);
  }
  const usage = isRecord(value.usage) && Number.isInteger(value.usage.completion_tokens)
    ? Number(value.usage.completion_tokens)
    : undefined;
  return {
    text: typeof choice.text === "string" ? choice.text : "",
    finishReason: finish,
    ...(usage === undefined ? {} : { outputTokens: usage }),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function abortError(): Error {
  const error = new Error("补全请求已取消");
  error.name = "AbortError";
  return error;
}
