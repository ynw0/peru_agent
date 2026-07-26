import type { TypedIpcServer } from "../ipc/channel.js";
import type { PermissionMode } from "../agent-protocol.js";
import type { AgentRuntime } from "./agent-runtime.js";

// AgentRuntimeIpcBridge 只做协议映射，不在 IPC Handler 中复制 Agent 业务逻辑。
export class AgentRuntimeIpcBridge {
  private readonly disposables: { dispose(): void }[] = [];

  public constructor(
    private readonly runtime: AgentRuntime,
    private readonly server: TypedIpcServer,
    private readonly permissionMode: PermissionMode,
  ) {}

  public start(): void {
    this.disposables.push(
      this.server.registerHandler("session.create", async request => {
        const snapshot = await this.runtime.createSession(request.workspaceId, this.permissionMode);
        return { sessionId: snapshot.id };
      }),
      this.server.registerHandler("session.start", request =>
        this.runtime.startSession(request.sessionId, request.input)),
      this.server.registerHandler("session.abort", request => ({
        aborted: this.runtime.abortSession(request.sessionId),
      })),
      this.server.registerHandler("session.get", request =>
        this.runtime.getSession(request.sessionId)),
      this.server.registerHandler("session.list", async request => ({
        sessions: await this.runtime.listSessions(request.workspaceId),
      })),
      this.server.registerHandler("session.events", async request => ({
        entries: await this.runtime.listEvents(request.sessionId),
      })),
      this.server.registerHandler("session.retry", request =>
        this.runtime.retrySession(request.sessionId)),
      this.server.registerHandler("permission.resolve", request => ({
        accepted: this.runtime.resolvePermission(request.requestId, request.decision),
      })),
      this.runtime.onEvent(event => this.server.emit("agent.event", event)),
    );
  }

  public dispose(): void {
    for (const disposable of this.disposables.splice(0)) {
      disposable.dispose();
    }
  }
}
