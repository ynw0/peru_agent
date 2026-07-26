import type { TypedIpcServer } from "../ipc/channel.js";
import type { PlanManager } from "../plan/plan-manager.js";

export class PlanRuntimeIpcBridge {
  private readonly disposables: { dispose(): void }[] = [];

  public constructor(
    private readonly plans: PlanManager,
    private readonly server: TypedIpcServer,
  ) {}

  public start(): void {
    this.disposables.push(
      this.server.registerHandler("plan.list", request => ({
        plans: this.plans.list(request.sessionId),
      })),
      this.server.registerHandler("plan.get", request => {
        const plan = this.plans.get(request.planId);
        if (plan === undefined) {
          throw new Error(`Plan 不存在：${request.planId}`);
        }
        return plan;
      }),
      this.server.registerHandler("plan.resolve", request =>
        this.plans.resolve(request.planId, request.decision)),
      this.plans.onEvent(event => this.server.emit("agent.event", event)),
    );
  }

  public dispose(): void {
    for (const disposable of this.disposables.splice(0)) {
      disposable.dispose();
    }
  }
}
