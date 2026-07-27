import type { TypedIpcServer } from "../ipc/channel.js";
import type { ReleaseRuntime } from "../release/runtime.js";

// Workbench 只能读取发布状态、切换语言和验证签名 Manifest；不能传入安装路径或直接执行更新。
export class ReleaseIpcBridge {
  private readonly disposables: { dispose(): void }[] = [];
  public constructor(private readonly runtime: ReleaseRuntime, private readonly server: TypedIpcServer) {}

  public start(): void {
    this.disposables.push(
      this.server.registerHandler("release.status", () => this.runtime.getSnapshot()),
      this.server.registerHandler("release.locale.set", async request => {
        const snapshot = await this.runtime.setLocale(request.locale);
        this.server.emit("release.status.changed", snapshot);
        return snapshot;
      }),
      this.server.registerHandler("release.manifest.verify", request => this.runtime.verifyManifest(request.manifest)),
      this.server.registerHandler("release.audit.list", () => ({ entries: this.runtime.listAudit() })),
    );
  }

  public dispose(): void { for (const disposable of this.disposables.splice(0)) disposable.dispose(); }
}
