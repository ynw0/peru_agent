import type { DiffManager, DiffProposal } from "./diff-manager.js";

interface PendingReview {
  readonly resolve: (proposal: DiffProposal) => void;
  readonly reject: (error: Error) => void;
  readonly sessionId: string;
}

interface InFlightResolution {
  readonly decision: "accepted" | "rejected";
  readonly promise: Promise<DiffProposal>;
}

// DiffReviewCoordinator 把 DiffManager 的持久化状态和 UI 的人工审核连接起来。
// 只有显式 resolve 才会让提出 Diff 的 ToolCall 继续执行。
export class DiffReviewCoordinator {
  private readonly pending = new Map<string, PendingReview>();
  private readonly inFlight = new Map<string, InFlightResolution>();

  public constructor(private readonly diffs: DiffManager) {}

  public async awaitResolution(
    proposalId: string,
    sessionId: string,
    signal: AbortSignal,
  ): Promise<DiffProposal> {
    const current = this.diffs.get(proposalId);
    if (current === undefined) {
      throw new Error(`Diff Proposal 不存在：${proposalId}`);
    }
    if (current.status !== "proposed") {
      return structuredClone(current);
    }
    if (this.pending.has(proposalId)) {
      throw new Error(`Diff Proposal 已在等待审核：${proposalId}`);
    }
    if (signal.aborted) {
      await this.rejectAfterAbort(proposalId);
      throw new Error("Diff 审核等待期间运行已取消");
    }

    return new Promise<DiffProposal>((resolve, reject) => {
      const abortListener = (): void => {
        this.pending.delete(proposalId);
        if (!this.inFlight.has(proposalId)) void this.rejectAfterAbort(proposalId);
        reject(new Error("Diff 审核等待期间运行已取消"));
      };
      signal.addEventListener("abort", abortListener, { once: true });
      this.pending.set(proposalId, {
        sessionId,
        resolve: proposal => {
          signal.removeEventListener("abort", abortListener);
          resolve(proposal);
        },
        reject: error => {
          signal.removeEventListener("abort", abortListener);
          reject(error);
        },
      });
    });
  }

  public resolve(proposalId: string, decision: "accepted" | "rejected"): Promise<DiffProposal> {
    const current = this.inFlight.get(proposalId);
    if (current !== undefined) {
      if (current.decision !== decision) {
        return Promise.reject(new Error(`Diff Proposal 正在按 ${current.decision} 处理，不能同时执行 ${decision}`));
      }
      return current.promise;
    }

    const promise = this.performResolve(proposalId, decision);
    this.inFlight.set(proposalId, { decision, promise });
    void promise.then(
      () => this.clearInFlight(proposalId, promise),
      () => this.clearInFlight(proposalId, promise),
    );
    return promise;
  }

  public listPending(): readonly string[] {
    return [...this.pending.keys()];
  }

  public rejectSession(sessionId: string): void {
    for (const [proposalId, pending] of this.pending) {
      if (pending.sessionId !== sessionId) continue;
      this.pending.delete(proposalId);
      if (!this.inFlight.has(proposalId)) void this.rejectAfterAbort(proposalId);
      pending.reject(new Error("Diff 审核所属运行已终止"));
    }
  }

  private async performResolve(proposalId: string, decision: "accepted" | "rejected"): Promise<DiffProposal> {
    try {
      const proposal = decision === "accepted"
        ? await this.diffs.accept(proposalId)
        : await this.diffs.reject(proposalId);
      const pending = this.pending.get(proposalId);
      this.pending.delete(proposalId);
      pending?.resolve(proposal);
      return proposal;
    } catch (error: unknown) {
      const reason = error instanceof Error ? error : new Error("Diff 审核失败");
      const pending = this.pending.get(proposalId);
      this.pending.delete(proposalId);
      pending?.reject(reason);
      throw reason;
    }
  }

  private clearInFlight(proposalId: string, promise: Promise<DiffProposal>): void {
    if (this.inFlight.get(proposalId)?.promise === promise) this.inFlight.delete(proposalId);
  }

  private async rejectAfterAbort(proposalId: string): Promise<void> {
    const proposal = this.diffs.get(proposalId);
    if (proposal?.status !== "proposed") return;
    await this.diffs.reject(proposalId).catch(() => undefined);
  }
}
