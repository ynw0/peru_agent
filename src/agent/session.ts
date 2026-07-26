import type {
  AgentMessage,
  AgentSessionSnapshot,
  AgentSessionStatus,
} from "./types.js";
import type { PermissionMode } from "../agent-protocol.js";

function nowIso(): string {
  return new Date().toISOString();
}

// AgentSession 是单个会话的可变领域对象；外部只能通过 snapshot() 读取不可变副本。
export class AgentSession {
  private readonly messages: AgentMessage[] = [];
  private status: AgentSessionStatus = "idle";
  private updatedAt: string;
  private activeRunId: string | undefined;
  private lastError: { code: string; message: string } | undefined;
  private inputTokens = 0;
  private outputTokens = 0;

  public readonly createdAt: string;

  public constructor(
    public readonly id: string,
    public readonly workspaceId: string,
    public readonly permissionMode: PermissionMode,
    createdAt: string = nowIso(),
  ) {
    this.createdAt = createdAt;
    this.updatedAt = this.createdAt;
  }

  public static restore(snapshot: AgentSessionSnapshot): AgentSession {
    const session = new AgentSession(
      snapshot.id,
      snapshot.workspaceId,
      snapshot.permissionMode,
      snapshot.createdAt,
    );
    session.messages.push(...snapshot.messages.map(message => ({ ...message })));
    session.status = snapshot.status;
    session.updatedAt = snapshot.updatedAt;
    session.activeRunId = snapshot.activeRunId;
    session.lastError = snapshot.lastError === undefined ? undefined : { ...snapshot.lastError };
    session.inputTokens = snapshot.usage.inputTokens;
    session.outputTokens = snapshot.usage.outputTokens;
    return session;
  }

  public start(runId: string): void {
    if (this.status === "running" || this.status === "awaitingPermission") {
      throw new Error(`会话正在运行，不能重复启动：${this.id}`);
    }
    this.status = "running";
    this.activeRunId = runId;
    this.lastError = undefined;
    this.touch();
  }

  public setAwaitingPermission(): void {
    this.assertActive();
    this.status = "awaitingPermission";
    this.touch();
  }

  public resumeFromPermission(): void {
    if (this.status !== "awaitingPermission") {
      throw new Error(`会话当前没有等待权限：${this.id}`);
    }
    this.status = "running";
    this.touch();
  }

  public appendMessage(message: AgentMessage): void {
    this.messages.push(message);
    this.touch();
  }

  public addUsage(inputTokens: number, outputTokens: number): void {
    if (!Number.isInteger(inputTokens) || inputTokens < 0
      || !Number.isInteger(outputTokens) || outputTokens < 0) {
      throw new Error("Token 用量必须是非负整数");
    }
    this.inputTokens += inputTokens;
    this.outputTokens += outputTokens;
    this.touch();
  }

  public complete(): void {
    this.assertActive();
    this.status = "completed";
    this.activeRunId = undefined;
    this.touch();
  }

  public fail(code: string, message: string): void {
    this.status = "failed";
    this.activeRunId = undefined;
    this.lastError = { code, message };
    this.touch();
  }

  public abort(): void {
    this.status = "aborted";
    this.activeRunId = undefined;
    this.touch();
  }

  public getStatus(): AgentSessionStatus {
    return this.status;
  }

  public getMessages(): readonly AgentMessage[] {
    return this.messages.map(message => ({ ...message }));
  }

  public getTotalTokens(): number {
    return this.inputTokens + this.outputTokens;
  }

  public snapshot(): AgentSessionSnapshot {
    return {
      id: this.id,
      workspaceId: this.workspaceId,
      permissionMode: this.permissionMode,
      status: this.status,
      messages: this.getMessages(),
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      ...(this.activeRunId === undefined ? {} : { activeRunId: this.activeRunId }),
      ...(this.lastError === undefined ? {} : { lastError: { ...this.lastError } }),
      usage: {
        inputTokens: this.inputTokens,
        outputTokens: this.outputTokens,
      },
    };
  }

  private assertActive(): void {
    if (this.status !== "running" && this.status !== "awaitingPermission") {
      throw new Error(`会话不是运行状态：${this.id}`);
    }
  }

  private touch(): void {
    this.updatedAt = nowIso();
  }
}
