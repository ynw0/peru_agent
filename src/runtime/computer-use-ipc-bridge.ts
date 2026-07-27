import type { TypedIpcServer } from "../ipc/channel.js";
import type { ComputerUseRuntime } from "../computer-use/runtime.js";

// Computer Use IPC 只开放检查、截图和审计；交互动作必须通过 Agent Tool 与权限引擎。
export class ComputerUseIpcBridge {
  private readonly disposables: { dispose(): void }[] = [];

  public constructor(
    private readonly runtime: ComputerUseRuntime,
    private readonly server: TypedIpcServer,
  ) {}

  public start(): void {
    this.disposables.push(
      this.server.registerHandler("computer.windows", async (_request, signal) => ({
        windows: await this.runtime.listWindows(signal),
      })),
      this.server.registerHandler("computer.inspect", (request, signal) =>
        this.runtime.inspect(request.windowHandle, signal)),
      this.server.registerHandler("computer.screenshot", (request, signal) =>
        this.runtime.screenshot(request.snapshotId, signal)),
      this.server.registerHandler("computer.audit.list", async () => ({
        entries: await this.runtime.listAudit(),
      })),
      this.runtime.onEvent(event => {
        switch (event.type) {
          case "window.changed":
            this.server.emit("computer.window.changed", event.window);
            break;
          case "snapshot.changed":
            this.server.emit("computer.snapshot.changed", event.snapshot);
            break;
          case "action.prepared":
            this.server.emit("computer.action.prepared", event.action);
            break;
          case "action.completed":
            this.server.emit("computer.action.completed", event.result);
            break;
        }
      }),
    );
  }

  public dispose(): void {
    for (const disposable of this.disposables.splice(0)) disposable.dispose();
  }
}
