import type { CompletionDocumentInput } from "./types.js";
import type { CompletionEngine } from "../completion-engine.js";

export interface CompletionBenchmarkResult {
  readonly iterations: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly maxMs: number;
}

export async function benchmarkCompletion(
  engine: CompletionEngine,
  inputs: readonly CompletionDocumentInput[],
): Promise<CompletionBenchmarkResult> {
  if (inputs.length === 0) {
    throw new Error("补全基准至少需要一个输入");
  }
  const latencies: number[] = [];
  for (const input of inputs) {
    const started = performance.now();
    await engine.complete(input);
    latencies.push(performance.now() - started);
  }
  const sorted = [...latencies].sort((a, b) => a - b);
  return {
    iterations: sorted.length,
    p50Ms: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    maxMs: sorted[sorted.length - 1] ?? 0,
  };
}

function percentile(sorted: readonly number[], ratio: number): number {
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1);
  return sorted[index] ?? 0;
}

export interface CompletionPerformanceTargets {
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly cancellationMs: number;
}

export interface CompletionPerformanceEvaluation {
  readonly passed: boolean;
  readonly violations: readonly string[];
}

export const DEFAULT_COMPLETION_TARGETS: CompletionPerformanceTargets = {
  p50Ms: 120,
  p95Ms: 350,
  cancellationMs: 20,
};

export function evaluateCompletionPerformance(
  benchmark: CompletionBenchmarkResult,
  cancellationLatencyMs: number,
  targets: CompletionPerformanceTargets = DEFAULT_COMPLETION_TARGETS,
): CompletionPerformanceEvaluation {
  const violations: string[] = [];
  if (benchmark.p50Ms >= targets.p50Ms) {
    violations.push(`P50 ${benchmark.p50Ms.toFixed(2)}ms 未低于 ${targets.p50Ms}ms`);
  }
  if (benchmark.p95Ms >= targets.p95Ms) {
    violations.push(`P95 ${benchmark.p95Ms.toFixed(2)}ms 未低于 ${targets.p95Ms}ms`);
  }
  if (cancellationLatencyMs >= targets.cancellationMs) {
    violations.push(`取消延迟 ${cancellationLatencyMs.toFixed(2)}ms 未低于 ${targets.cancellationMs}ms`);
  }
  return { passed: violations.length === 0, violations };
}
