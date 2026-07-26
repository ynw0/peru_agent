import type { TypedIpcServer } from "../ipc/channel.js";
import type { WorkspaceRuntime } from "./workspace-runtime.js";

// WorkspaceRuntimeIpcBridge 只把 Typed IPC 映射到 WorkspaceRuntime，不复制业务逻辑。
export class WorkspaceRuntimeIpcBridge {
  private readonly disposables: { dispose(): void }[] = [];

  public constructor(
    private readonly runtime: WorkspaceRuntime,
    private readonly server: TypedIpcServer,
  ) {}

  public start(): void {
    this.disposables.push(
      this.server.registerHandler("workspace.register", async request => {
        await this.runtime.registerWorkspace(request.workspaceId, request.rootPath);
        return { registered: true };
      }),
      this.server.registerHandler("workspace.read", request =>
        this.runtime.read(request.workspaceId, request.path)),
      this.server.registerHandler("diff.list", request => ({
        proposals: this.runtime.listDiffs(request.workspaceId),
      })),
      this.server.registerHandler("diff.get", request =>
        this.runtime.requireDiff(request.proposalId)),
      this.server.registerHandler("diff.accept", request =>
        this.runtime.acceptDiff(request.proposalId)),
      this.server.registerHandler("diff.reject", request =>
        this.runtime.rejectDiff(request.proposalId)),
      this.server.registerHandler("checkpoint.list", async request => ({
        checkpoints: await this.runtime.listCheckpoints(request.workspaceId),
      })),
      this.server.registerHandler("checkpoint.restore", request =>
        this.runtime.restoreCheckpoint(request.checkpointId)),
      this.runtime.onEvent(event => this.server.emit("agent.event", event)),
    );
  }

  public dispose(): void {
    for (const disposable of this.disposables.splice(0)) {
      disposable.dispose();
    }
  }
}
