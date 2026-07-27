import type { CapabilityGapDetector } from "../evolution/gap-detector.js";
import type { EvolutionRuntime } from "../evolution/runtime.js";
import type { TypedIpcServer } from "../ipc/channel.js";

// Evolution IPC 只管理候选状态；不会向 Workbench 暴露候选源码执行对象或签名私钥。
export class EvolutionIpcBridge {
  private readonly disposables: { dispose(): void }[] = [];

  public constructor(
    private readonly runtime: EvolutionRuntime,
    private readonly gaps: CapabilityGapDetector,
    private readonly server: TypedIpcServer,
  ) {}

  public start(): void {
    this.disposables.push(
      this.server.registerHandler("evolution.gaps.list", () => ({ gaps: this.gaps.listProposals() })),
      this.server.registerHandler("evolution.candidates.list", async () => ({ candidates: await this.runtime.list() })),
      this.server.registerHandler("evolution.candidate.get", async request => {
        const candidate = await this.runtime.get(request.candidateId);
        if (candidate === undefined) throw new Error(`候选不存在：${request.candidateId}`);
        return candidate;
      }),
      this.server.registerHandler("evolution.candidate.validate", (request, signal) =>
        this.runtime.validate(request.candidateId, signal)),
      this.server.registerHandler("evolution.candidate.approve", request =>
        this.runtime.decideManualApproval(request.candidateId, {
          approverId: request.approverId,
          decision: request.decision,
          reason: request.reason,
        })),
      this.server.registerHandler("evolution.candidate.promote", request =>
        this.runtime.promote(request.candidateId)),
      this.server.registerHandler("evolution.candidate.disable", request =>
        this.runtime.disable(request.candidateId, request.reason)),
      this.server.registerHandler("evolution.candidate.rollback", request =>
        this.runtime.rollback(request.candidateId, request.reason)),
      this.server.registerHandler("evolution.whitelist.list", async () => ({ entries: await this.runtime.listWhitelist() })),
      this.server.registerHandler("evolution.audit.list", async () => ({ entries: await this.runtime.listAudit() })),
    );
  }

  public dispose(): void {
    for (const disposable of this.disposables.splice(0)) disposable.dispose();
  }
}
