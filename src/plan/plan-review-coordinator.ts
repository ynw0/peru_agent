import type { PlanManager, PlanRecord } from "./plan-manager.js";

interface PendingPlanReview {
  readonly sessionId: string;
  readonly resolve: (plan: PlanRecord) => void;
  readonly reject: (error: Error) => void;
}

export class PlanReviewCoordinator {
  private readonly pending = new Map<string, PendingPlanReview>();
  private readonly inFlight = new Map<string, { decision: "approved" | "rejected"; promise: Promise<PlanRecord> }>();

  public constructor(private readonly plans: PlanManager) {}

  public awaitResolution(planId: string, sessionId: string, signal: AbortSignal): Promise<PlanRecord> {
    const plan = this.plans.get(planId);
    if (plan === undefined) throw new Error(`Plan 不存在：${planId}`);
    if (plan.status !== "reviewing") return Promise.resolve(plan);
    if (this.pending.has(planId)) throw new Error(`Plan 已在等待审核：${planId}`);
    if (signal.aborted) return this.resolve(planId, "rejected").then(() => { throw new Error("Plan 审核等待期间运行已取消"); });
    return new Promise((resolve, reject) => {
      const abort = (): void => {
        this.pending.delete(planId);
        if (!this.inFlight.has(planId)) void this.resolve(planId, "rejected").catch(() => undefined);
        reject(new Error("Plan 审核等待期间运行已取消"));
      };
      signal.addEventListener("abort", abort, { once: true });
      this.pending.set(planId, {
        sessionId,
        resolve: value => { signal.removeEventListener("abort", abort); resolve(value); },
        reject: error => { signal.removeEventListener("abort", abort); reject(error); },
      });
    });
  }

  public resolve(planId: string, decision: "approved" | "rejected"): Promise<PlanRecord> {
    const running = this.inFlight.get(planId);
    if (running !== undefined) {
      if (running.decision !== decision) return Promise.reject(new Error(`Plan 正在按 ${running.decision} 处理`));
      return running.promise;
    }
    const promise = this.perform(planId, decision);
    this.inFlight.set(planId, { decision, promise });
    void promise.finally(() => { if (this.inFlight.get(planId)?.promise === promise) this.inFlight.delete(planId); });
    return promise;
  }

  public listPending(): readonly string[] { return [...this.pending.keys()]; }

  public rejectSession(sessionId: string): void {
    for (const [planId, pending] of this.pending) {
      if (pending.sessionId !== sessionId) continue;
      this.pending.delete(planId);
      if (!this.inFlight.has(planId)) void this.resolve(planId, "rejected").catch(() => undefined);
      pending.reject(new Error("Plan 审核所属运行已终止"));
    }
  }

  private async perform(planId: string, decision: "approved" | "rejected"): Promise<PlanRecord> {
    try {
      const result = await this.plans.resolve(planId, decision);
      const pending = this.pending.get(planId);
      this.pending.delete(planId);
      pending?.resolve(result);
      return result;
    } catch (error: unknown) {
      const reason = error instanceof Error ? error : new Error("Plan 审核失败");
      const pending = this.pending.get(planId);
      this.pending.delete(planId);
      pending?.reject(reason);
      throw reason;
    }
  }
}
