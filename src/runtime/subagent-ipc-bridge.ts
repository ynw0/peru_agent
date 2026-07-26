import type { TypedIpcServer } from "../ipc/channel.js";
import type { SubagentScheduler } from "../subagent/scheduler.js";

// SubagentRuntimeIpcBridge 只映射调度命令；长任务通过事件返回状态，不占用 IPC 请求。
export class SubagentRuntimeIpcBridge {
  private readonly disposables: { dispose(): void }[] = [];

  public constructor(
    private readonly scheduler: SubagentScheduler,
    private readonly server: TypedIpcServer,
  ) {}

  public start(): void {
    this.disposables.push(
      this.server.registerHandler("subagent.dispatch", request =>
        this.scheduler.dispatch(request)),
      this.server.registerHandler("subagent.start", request => {
        void this.scheduler.start(request.taskId);
        return { started: true as const };
      }),
      this.server.registerHandler("subagent.abort", async request => ({
        aborted: await this.scheduler.abort(request.taskId),
      })),
      this.server.registerHandler("subagent.get", request =>
        this.scheduler.get(request.taskId)),
      this.server.registerHandler("subagent.list", request => ({
        tasks: this.scheduler.list(request.parentSessionId),
      })),
      this.server.registerHandler("subagent.proposeMerge", request =>
        this.scheduler.proposeMerge(request.taskId, request.gateTaskIds)),
      this.server.registerHandler("subagent.finalizeMerge", request =>
        this.scheduler.finalizeMerge(request.taskId)),
      this.scheduler.onEvent(event => this.server.emit("agent.event", event)),
    );
  }

  public dispose(): void {
    for (const disposable of this.disposables.splice(0)) {
      disposable.dispose();
    }
  }
}
