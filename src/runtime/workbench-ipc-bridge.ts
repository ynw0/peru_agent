import type { TypedIpcServer } from "../ipc/channel.js";
import type { WorkbenchRuntime } from "./workbench-runtime.js";

// WorkbenchRuntimeIpcBridge 只暴露 Snapshot；UI 不获得 Tool 或文件系统对象。
export class WorkbenchRuntimeIpcBridge {
  private readonly disposables: { dispose(): void }[] = [];

  public constructor(
    private readonly runtime: WorkbenchRuntime,
    private readonly server: TypedIpcServer,
  ) {}

  public start(): void {
    this.disposables.push(
      this.server.registerHandler("workbench.getSnapshot", request => {
        if (request.sessionId !== undefined) {
          return this.runtime.activate(request.sessionId);
        }
        return this.runtime.getSnapshot();
      }),
      this.runtime.onSnapshot(snapshot => this.server.emit("workbench.snapshot.changed", snapshot)),
    );
  }

  public dispose(): void {
    for (const disposable of this.disposables.splice(0)) {
      disposable.dispose();
    }
  }
}
