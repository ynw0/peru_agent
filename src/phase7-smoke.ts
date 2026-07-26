import { CompletionEngine } from "./completion-engine.js";
import type {
  CompletionProvider,
  CompletionProviderEvent,
  CompletionProviderProbeResult,
  CompletionRequest,
} from "./completion/types.js";

class SmokeFimProvider implements CompletionProvider {
  public readonly id = "phase7-smoke-fim";
  public readonly capability = {
    fim: true,
    streaming: true,
    cancellation: true,
    maxPrefixTokens: 1_024,
    maxSuffixTokens: 512,
  } as const;

  public async *stream(_request: CompletionRequest, _signal: AbortSignal): AsyncIterable<CompletionProviderEvent> {
    yield { type: "text.delta", delta: "42" };
    yield { type: "response.completed", finishReason: "stop" };
  }

  public async probe(_signal: AbortSignal): Promise<CompletionProviderProbeResult> {
    return {
      capability: this.capability,
      modelId: this.id,
      firstTokenLatencyMs: 1,
      totalLatencyMs: 2,
      cancellationLatencyMs: 1,
    };
  }
}

const engine = new CompletionEngine(new SmokeFimProvider(), { requestTimeoutMs: 1_000 });
await engine.probeAndEnable(new AbortController().signal);
const candidate = await engine.complete({
  documentUri: "file:///smoke.ts",
  languageId: "typescript",
  version: 1,
  offset: 15,
  text: "const answer = ;",
});
if (candidate?.text !== "42") {
  throw new Error("Phase 7 FIM Smoke Test 失败");
}
console.log("AI IDE Phase 7 Smoke Test 通过");
