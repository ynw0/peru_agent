import type { CompletionMetricsSnapshot } from "./types.js";

export class CompletionMetrics {
  private requests = 0;
  private cacheHits = 0;
  private cancellations = 0;
  private failures = 0;
  private accepted = 0;
  private readonly firstTokenLatencies: number[] = [];
  private readonly totalLatencies: number[] = [];

  public recordRequest(): void { this.requests += 1; }
  public recordCacheHit(): void { this.cacheHits += 1; }
  public recordCancellation(): void { this.cancellations += 1; }
  public recordFailure(): void { this.failures += 1; }
  public recordAccepted(): void { this.accepted += 1; }
  public recordLatency(firstTokenMs: number, totalMs: number): void {
    this.firstTokenLatencies.push(firstTokenMs);
    this.totalLatencies.push(totalMs);
  }

  public snapshot(): CompletionMetricsSnapshot {
    const delivered = this.requests - this.failures - this.cancellations;
    return {
      requests: this.requests,
      cacheHits: this.cacheHits,
      cancellations: this.cancellations,
      failures: this.failures,
      accepted: this.accepted,
      p50FirstTokenMs: percentile(this.firstTokenLatencies, 0.5),
      p95FirstTokenMs: percentile(this.firstTokenLatencies, 0.95),
      p50TotalMs: percentile(this.totalLatencies, 0.5),
      p95TotalMs: percentile(this.totalLatencies, 0.95),
      acceptanceRate: delivered <= 0 ? 0 : this.accepted / delivered,
    };
  }
}

function percentile(values: readonly number[], ratio: number): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1);
  return sorted[index] ?? null;
}
