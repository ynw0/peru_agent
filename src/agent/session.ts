import type {
  AgentMessage,
  AgentQueuedInput,
  AgentQueuePriority,
  AgentUserInput,
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
  private lastInputTokens = 0;
  private lastOutputTokens = 0;
  private runCount = 0;
  private toolCallCount = 0;
  private contextTokens = 0;
  private pendingInputs: AgentQueuedInput[] = [];
  private title: string | undefined;
  private compaction: { compactedAt: string; count: number } | undefined;
  private branchSource: { sessionId: string; checkpointId: string } | undefined;

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
    session.lastInputTokens = snapshot.usage.lastInputTokens ?? 0;
    session.lastOutputTokens = snapshot.usage.lastOutputTokens ?? 0;
    session.runCount = snapshot.usage.runCount ?? 0;
    session.toolCallCount = snapshot.usage.toolCallCount ?? 0;
    session.contextTokens = snapshot.usage.contextTokens ?? session.lastInputTokens;
    session.pendingInputs = [...(snapshot.pendingInputs ?? [])].map(item => ({ ...item, input: { ...item.input, ...(item.input.attachments === undefined ? {} : { attachments: item.input.attachments.map(attachment => ({ ...attachment })) }) } }));
    session.title = snapshot.title;
    session.compaction = snapshot.compaction === undefined ? undefined : { ...snapshot.compaction };
    session.branchSource = snapshot.branchSource === undefined ? undefined : { ...snapshot.branchSource };
    return session;
  }

  public start(runId: string): void {
    if (this.status === "running" || this.status === "awaitingPermission") {
      throw new Error(`会话正在运行，不能重复启动：${this.id}`);
    }
    this.status = "running";
    this.activeRunId = runId;
    this.runCount += 1;
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
    this.lastInputTokens = inputTokens;
    this.lastOutputTokens = outputTokens;
    this.contextTokens = inputTokens;
    this.touch();
  }
  public setContextTokens(value: number): void { this.contextTokens = Math.max(0, Math.floor(value)); this.touch(); }

  public incrementToolCallCount(count = 1): void { this.toolCallCount += count; this.touch(); }
  public rename(title: string): void { this.title = title.trim() === "" ? undefined : title.trim(); this.touch(); }
  public setBranchSource(source: { readonly sessionId: string; readonly checkpointId: string }): void { this.branchSource = { ...source }; this.touch(); }
  public enqueueInput(id: string, input: AgentUserInput, priority: AgentQueuePriority): void {
    this.pendingInputs.push({ id, priority, input, createdAt: nowIso() });
    this.touch();
  }
  public removeQueuedInput(id: string): AgentQueuedInput | undefined {
    const index = this.pendingInputs.findIndex(item => item.id === id);
    if (index < 0) return undefined;
    const [removed] = this.pendingInputs.splice(index, 1);
    this.touch();
    return removed;
  }
  public takeQueuedInput(priority: AgentQueuePriority): AgentQueuedInput | undefined {
    const index = this.pendingInputs.findIndex(item => item.priority === priority);
    if (index < 0) return undefined;
    const [removed] = this.pendingInputs.splice(index, 1);
    this.touch();
    return removed;
  }
  public getPendingInputs(): readonly AgentQueuedInput[] { return this.pendingInputs.map(item => ({ ...item, input: { ...item.input, ...(item.input.attachments === undefined ? {} : { attachments: item.input.attachments.map(a => ({ ...a })) }) } })); }
  public compact(summary: string, sourceMessageCount: number): void {
    this.messages.splice(0, this.messages.length, {
      id: `summary-${nowIso()}`,
      role: "summary",
      content: summary,
      compactedAt: nowIso(),
      sourceMessageCount,
    });
    this.compaction = { compactedAt: nowIso(), count: (this.compaction?.count ?? 0) + 1 };
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
      ...(this.title === undefined ? {} : { title: this.title }),
      status: this.status,
      messages: this.getMessages(),
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      ...(this.activeRunId === undefined ? {} : { activeRunId: this.activeRunId }),
      ...(this.lastError === undefined ? {} : { lastError: { ...this.lastError } }),
      usage: {
        inputTokens: this.inputTokens,
        outputTokens: this.outputTokens,
        lastInputTokens: this.lastInputTokens,
        lastOutputTokens: this.lastOutputTokens,
        runCount: this.runCount,
        toolCallCount: this.toolCallCount,
        contextTokens: this.contextTokens,
      },
      ...(this.compaction === undefined ? {} : { compaction: { ...this.compaction } }),
      pendingInputs: this.getPendingInputs(),
      ...(this.branchSource === undefined ? {} : { branchSource: { ...this.branchSource } }),
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
