import type { TypedIpcClient } from "../ipc/channel.js";
import type {
  CompletionCandidate,
  CompletionDocumentInput,
  CompletionMetricsSnapshot,
  CompletionProviderProbeResult,
} from "./types.js";

// IDE Host 使用该控制器实现 Code OSS Completion Bridge；模型凭据不进入 Workbench 进程。
export class CompletionController {
  public constructor(
    private readonly client: TypedIpcClient,
    private readonly timeoutMs = 2_000,
  ) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new Error("Completion Controller 超时无效");
    }
  }

  public probe(signal?: AbortSignal): Promise<CompletionProviderProbeResult> {
    return this.client.request("completion.probe", {}, { timeoutMs: this.timeoutMs, ...(signal === undefined ? {} : { signal }) });
  }

  public async provideCompletion(input: CompletionDocumentInput, signal: AbortSignal): Promise<CompletionCandidate | null> {
    const result = await this.client.request("completion.request", { input }, { timeoutMs: this.timeoutMs, signal });
    return result.candidate;
  }

  public async recordAccepted(requestId: string): Promise<void> {
    await this.client.request("completion.accepted", { requestId }, { timeoutMs: this.timeoutMs });
  }

  public metrics(): Promise<CompletionMetricsSnapshot> {
    return this.client.request("completion.metrics", {}, { timeoutMs: this.timeoutMs });
  }

  public async clearCache(): Promise<void> {
    await this.client.request("completion.clearCache", {}, { timeoutMs: this.timeoutMs });
  }
}
