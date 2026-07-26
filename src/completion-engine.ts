import { CompletionCache } from "./completion/cache.js";
import { buildCompletionRequest, type CompletionContextBuilderOptions } from "./completion/context-builder.js";
import { CompletionContextCache } from "./completion/context-cache.js";
import { CompletionMetrics } from "./completion/metrics.js";
import { normalizeCompletionText } from "./completion/quality.js";
import type {
  CompletionCandidate,
  CompletionDocumentInput,
  CompletionMetricsSnapshot,
  CompletionProvider,
  CompletionProviderProbeResult,
} from "./completion/types.js";

// 补全模型必须明确声明 FIM、流式和取消能力。
export interface CompletionCapability {
  readonly fim: boolean;
  readonly streaming: boolean;
  readonly cancellation: boolean;
  readonly maxPrefixTokens: number;
  readonly maxSuffixTokens: number;
}

export function validateCompletionCapability(capability: CompletionCapability): void {
  if (!capability.fim) {
    throw new Error("补全模型不支持 FIM");
  }
  if (!capability.streaming) {
    throw new Error("补全模型不支持流式输出");
  }
  if (!capability.cancellation) {
    throw new Error("补全模型不支持请求取消");
  }
  if (!Number.isInteger(capability.maxPrefixTokens) || !Number.isInteger(capability.maxSuffixTokens)
    || capability.maxPrefixTokens <= 0 || capability.maxSuffixTokens <= 0) {
    throw new Error("补全模型上下文限制无效");
  }
}

export interface CompletionEngineOptions {
  readonly requestTimeoutMs: number;
  readonly context?: CompletionContextBuilderOptions;
  readonly cache?: CompletionCache;
  readonly contextCache?: CompletionContextCache;
  readonly metrics?: CompletionMetrics;
}

interface ActiveRequest {
  readonly controller: AbortController;
  readonly requestId: string;
}

// CompletionEngine 与 AgentLoop 完全分离，并对同一文档执行 latest-wins 取消策略。
export class CompletionEngine {
  private readonly cache: CompletionCache;
  private readonly metrics: CompletionMetrics;
  private readonly contextCache: CompletionContextCache;
  private readonly activeByDocument = new Map<string, ActiveRequest>();
  private nextRequestId = 1;
  private probeResult: CompletionProviderProbeResult | undefined;
  private readonly deliveredRequestIds = new Set<string>();
  private readonly acceptedRequestIds = new Set<string>();

  public constructor(
    private readonly provider: CompletionProvider,
    private readonly options: CompletionEngineOptions,
  ) {
    validateCompletionCapability(provider.capability);
    if (!Number.isFinite(options.requestTimeoutMs) || options.requestTimeoutMs <= 0) {
      throw new Error("补全请求超时必须大于 0");
    }
    this.cache = options.cache ?? new CompletionCache();
    this.contextCache = options.contextCache ?? new CompletionContextCache();
    this.metrics = options.metrics ?? new CompletionMetrics();
  }

  public async probeAndEnable(signal: AbortSignal): Promise<CompletionProviderProbeResult> {
    const result = await this.provider.probe(signal);
    validateCompletionCapability(result.capability);
    if (!sameCapability(result.capability, this.provider.capability)) {
      throw new Error("补全能力探测结果与 Provider 声明不一致");
    }
    if (result.modelId.trim() === "") {
      throw new Error("补全能力探测未返回模型 ID");
    }
    if (![result.firstTokenLatencyMs, result.totalLatencyMs, result.cancellationLatencyMs]
      .every(value => Number.isFinite(value) && value >= 0)) {
      throw new Error("补全能力探测延迟无效");
    }
    this.probeResult = result;
    return result;
  }

  public isEnabled(): boolean {
    return this.probeResult !== undefined;
  }

  public async complete(input: CompletionDocumentInput, signal?: AbortSignal): Promise<CompletionCandidate | null> {
    if (this.probeResult === undefined) {
      throw new Error("补全模型尚未通过能力探测");
    }
    if (signal?.aborted) {
      throw createAbortError("补全请求在发送前已取消");
    }

    const requestId = `completion-${this.nextRequestId++}`;
    const enrichment = input.enrichment ?? this.contextCache.get(input.documentUri, input.version);
    if (input.enrichment !== undefined) {
      this.contextCache.set(input.documentUri, input.version, input.enrichment);
    }
    const request = buildCompletionRequest(
      requestId,
      { ...input, ...(enrichment === undefined ? {} : { enrichment }) },
      this.provider.capability,
      this.options.context,
    );
    const cacheKey = this.cache.key(request, this.provider.id);
    this.metrics.recordRequest();
    const cached = this.cache.get(cacheKey);
    if (cached !== undefined) {
      this.metrics.recordCacheHit();
      const candidate = { ...cached, requestId, documentVersion: input.version, offset: input.offset };
      this.rememberDelivered(requestId);
      return candidate;
    }

    this.activeByDocument.get(input.documentUri)?.controller.abort();
    const controller = new AbortController();
    const active = { controller, requestId };
    this.activeByDocument.set(input.documentUri, active);
    const cleanupExternalSignal = forwardAbort(signal, controller);
    const timeout = setTimeout(() => controller.abort(), this.options.requestTimeoutMs);
    const startedAt = performance.now();
    let firstTokenAt: number | undefined;
    let text = "";

    try {
      for await (const event of this.provider.stream(request, controller.signal)) {
        if (event.type === "text.delta") {
          if (firstTokenAt === undefined && event.delta !== "") {
            firstTokenAt = performance.now();
          }
          text += event.delta;
          if (text.length > 16_384) {
            throw new Error("补全响应超过最大字符限制");
          }
          continue;
        }
        if (event.type === "response.completed" && event.finishReason !== "stop" && event.finishReason !== "length") {
          throw new Error("补全模型返回未知结束原因");
        }
      }

      if (controller.signal.aborted) {
        throw createAbortError("补全请求已取消");
      }
      const normalized = normalizeCompletionText(text, request.prefix, request.suffix);
      if (normalized === null) {
        return null;
      }
      const completedAt = performance.now();
      const candidate: CompletionCandidate = {
        requestId,
        documentUri: input.documentUri,
        documentVersion: input.version,
        offset: input.offset,
        text: normalized,
        providerId: this.provider.id,
        cacheHit: false,
        firstTokenLatencyMs: Math.max(0, (firstTokenAt ?? completedAt) - startedAt),
        totalLatencyMs: Math.max(0, completedAt - startedAt),
      };
      this.metrics.recordLatency(candidate.firstTokenLatencyMs, candidate.totalLatencyMs);
      this.cache.set(cacheKey, candidate);
      this.rememberDelivered(requestId);
      return candidate;
    } catch (error: unknown) {
      if (isAbortError(error) || controller.signal.aborted) {
        this.metrics.recordCancellation();
        throw createAbortError("补全请求已取消");
      }
      this.metrics.recordFailure();
      throw error;
    } finally {
      clearTimeout(timeout);
      cleanupExternalSignal();
      if (this.activeByDocument.get(input.documentUri)?.requestId === requestId) {
        this.activeByDocument.delete(input.documentUri);
      }
    }
  }

  public cancelDocument(documentUri: string): boolean {
    const active = this.activeByDocument.get(documentUri);
    if (active === undefined) {
      return false;
    }
    active.controller.abort();
    return true;
  }

  public recordAccepted(requestId: string): void {
    if (!this.deliveredRequestIds.has(requestId)) {
      throw new Error(`未知补全请求，不能记录接受：${requestId}`);
    }
    if (this.acceptedRequestIds.has(requestId)) {
      return;
    }
    this.acceptedRequestIds.add(requestId);
    this.metrics.recordAccepted();
  }

  public getMetrics(): CompletionMetricsSnapshot {
    return this.metrics.snapshot();
  }

  public clearCache(): void {
    this.cache.clear();
    this.contextCache.clear();
  }

  private rememberDelivered(requestId: string): void {
    this.deliveredRequestIds.add(requestId);
    if (this.deliveredRequestIds.size > 1_024) {
      const oldest = this.deliveredRequestIds.values().next().value as string | undefined;
      if (oldest !== undefined) {
        this.deliveredRequestIds.delete(oldest);
        this.acceptedRequestIds.delete(oldest);
      }
    }
  }
}

function forwardAbort(signal: AbortSignal | undefined, controller: AbortController): () => void {
  if (signal === undefined) {
    return () => undefined;
  }
  const listener = (): void => controller.abort();
  signal.addEventListener("abort", listener, { once: true });
  return () => signal.removeEventListener("abort", listener);
}

function createAbortError(message: string): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function sameCapability(left: CompletionCapability, right: CompletionCapability): boolean {
  return left.fim === right.fim
    && left.streaming === right.streaming
    && left.cancellation === right.cancellation
    && left.maxPrefixTokens === right.maxPrefixTokens
    && left.maxSuffixTokens === right.maxSuffixTokens;
}
