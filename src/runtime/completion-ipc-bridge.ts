import type { CompletionEngine } from "../completion-engine.js";
import type { TypedIpcServer } from "../ipc/channel.js";
import type { Disposable } from "../ipc/transport.js";

export class CompletionRuntimeIpcBridge {
  private readonly registrations: Disposable[] = [];

  public constructor(
    private readonly engine: CompletionEngine,
    private readonly server: TypedIpcServer,
  ) {}

  public start(): void {
    if (this.registrations.length > 0) {
      throw new Error("Completion IPC Bridge 已启动");
    }
    this.registrations.push(
      this.server.registerHandler("completion.probe", (_request, signal) => this.engine.probeAndEnable(signal)),
      this.server.registerHandler("completion.request", (request, signal) =>
        this.engine.complete(request.input, signal).then(candidate => ({ candidate }))),
      this.server.registerHandler("completion.accepted", request => {
        this.engine.recordAccepted(request.requestId);
        return { recorded: true as const };
      }),
      this.server.registerHandler("completion.metrics", () => this.engine.getMetrics()),
      this.server.registerHandler("completion.clearCache", () => {
        this.engine.clearCache();
        return { cleared: true as const };
      }),
    );
  }

  public dispose(): void {
    for (const registration of this.registrations.splice(0)) {
      registration.dispose();
    }
  }
}
