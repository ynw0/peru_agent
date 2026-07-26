import type { CompletionCapability } from "../completion-engine.js";

export interface CompletionContextEnrichment {
  readonly currentFunction?: string;
  readonly imports?: readonly string[];
  readonly recentEdits?: readonly string[];
  readonly lspTypes?: readonly string[];
  readonly diagnostics?: readonly string[];
  readonly projectRules?: readonly string[];
}

export interface CompletionDocumentInput {
  readonly documentUri: string;
  readonly languageId: string;
  readonly version: number;
  readonly offset: number;
  readonly text: string;
  readonly enrichment?: CompletionContextEnrichment;
}

export interface CompletionRequest {
  readonly requestId: string;
  readonly documentUri: string;
  readonly languageId: string;
  readonly documentVersion: number;
  readonly offset: number;
  readonly prefix: string;
  readonly suffix: string;
  readonly metadata: {
    readonly currentFunction?: string;
    readonly imports: readonly string[];
    readonly recentEdits: readonly string[];
    readonly lspTypes: readonly string[];
    readonly diagnostics: readonly string[];
    readonly projectRules: readonly string[];
  };
  readonly maxOutputTokens: number;
}

export type CompletionProviderEvent =
  | { readonly type: "text.delta"; readonly delta: string }
  | { readonly type: "response.completed"; readonly finishReason: "stop" | "length"; readonly outputTokens?: number };

export interface CompletionProviderProbeResult {
  readonly capability: CompletionCapability;
  readonly modelId: string;
  readonly firstTokenLatencyMs: number;
  readonly totalLatencyMs: number;
  readonly cancellationLatencyMs: number;
}

export interface CompletionProvider {
  readonly id: string;
  readonly capability: CompletionCapability;
  stream(request: CompletionRequest, signal: AbortSignal): AsyncIterable<CompletionProviderEvent>;
  probe(signal: AbortSignal): Promise<CompletionProviderProbeResult>;
}

export interface CompletionCandidate {
  readonly requestId: string;
  readonly documentUri: string;
  readonly documentVersion: number;
  readonly offset: number;
  readonly text: string;
  readonly providerId: string;
  readonly cacheHit: boolean;
  readonly firstTokenLatencyMs: number;
  readonly totalLatencyMs: number;
}

export interface CompletionMetricsSnapshot {
  readonly requests: number;
  readonly cacheHits: number;
  readonly cancellations: number;
  readonly failures: number;
  readonly accepted: number;
  readonly p50FirstTokenMs: number | null;
  readonly p95FirstTokenMs: number | null;
  readonly p50TotalMs: number | null;
  readonly p95TotalMs: number | null;
  readonly acceptanceRate: number;
}
