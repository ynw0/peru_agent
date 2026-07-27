import type { TypedIpcServer } from "../ipc/channel.js";
import type { BrowserRuntime } from "../browser/browser-runtime.js";
import type { BrowserDomSnapshot, BrowserSessionRecord } from "../browser/types.js";

export class BrowserIpcBridge {
  private readonly disposables: { dispose(): void }[] = [];

  public constructor(
    private readonly server: TypedIpcServer,
    private readonly runtime: BrowserRuntime,
  ) {}

  public start(): void {
    this.disposables.push(
      this.server.registerHandler("browser.create", async (request, signal) => {
        const session = await this.runtime.create(request, signal);
        this.emitSession(session);
        return session;
      }),
      this.server.registerHandler("browser.navigate", async (request, signal) => {
        const snapshot = await this.runtime.navigate(request.browserSessionId, request.url, signal);
        this.emitSnapshot(snapshot);
        this.emitSession(this.runtime.get(request.browserSessionId));
        return snapshot;
      }),
      this.server.registerHandler("browser.snapshot", async (request, signal) => {
        const snapshot = await this.runtime.snapshot(request.browserSessionId, signal);
        this.emitSnapshot(snapshot);
        this.emitSession(this.runtime.get(request.browserSessionId));
        return snapshot;
      }),
      this.server.registerHandler("browser.screenshot", (request, signal) =>
        this.runtime.screenshot(request.browserSessionId, signal)),
      this.server.registerHandler("browser.download", (request, signal) =>
        this.runtime.download(
          request.browserSessionId,
          request.url,
          request.maxBytes ?? 16 * 1024 * 1024,
          signal,
        )),
      this.server.registerHandler("browser.click", async (request, signal) => {
        const result = await this.runtime.click(request.browserSessionId, request, signal);
        this.emitSnapshot(result.afterSnapshot);
        this.emitSession(this.runtime.get(request.browserSessionId));
        return result;
      }),
      this.server.registerHandler("browser.type", async (request, signal) => {
        const result = await this.runtime.type(request.browserSessionId, request, request.text, signal);
        this.emitSnapshot(result.afterSnapshot);
        this.emitSession(this.runtime.get(request.browserSessionId));
        return result;
      }),
      this.server.registerHandler("browser.close", async request => {
        const session = await this.runtime.close(request.browserSessionId);
        this.emitSession(session);
        return session;
      }),
      this.server.registerHandler("browser.list", request => ({ sessions: this.runtime.list(request.workspaceId) })),
    );
  }

  public dispose(): void {
    for (const disposable of this.disposables.splice(0)) disposable.dispose();
  }

  private emitSession(session: BrowserSessionRecord): void {
    this.server.emit("browser.session.changed", session);
  }

  private emitSnapshot(snapshot: BrowserDomSnapshot): void {
    this.server.emit("browser.snapshot.changed", snapshot);
  }
}
