import type { AgentEvent, PermissionMode } from "../agent-protocol.js";
import { AgentError } from "../agent/errors.js";
import type { EventJournal, JournalEntry } from "../agent/event-journal.js";
import type { IdGenerator } from "../agent/id-generator.js";
import { AgentLoop, type AgentLoopOptions } from "../agent/agent-loop.js";
import { PermissionCoordinator } from "../agent/permission-coordinator.js";
import { AgentSession } from "../agent/session.js";
import type { AgentRunOptions, AgentSessionSnapshot } from "../agent/types.js";
import type { ModelProvider } from "../model/types.js";
import type { SessionStore, TrashedSessionRecord } from "../storage/session-store.js";
import type { ToolRegistry } from "../tool-runtime.js";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import type { AgentQueuedInput, AgentQueuePriority, AgentUserInput, SessionCompactionResult } from "../agent/types.js";

export interface AgentRuntimeDependencies {
  readonly provider: ModelProvider;
  readonly tools: ToolRegistry;
  readonly permissions: PermissionCoordinator;
  readonly journal: EventJournal;
  readonly sessions: SessionStore;
  readonly idGenerator: IdGenerator;
}

export interface AgentRuntimeListener {
  (event: AgentEvent): void | Promise<void>;
}

// AgentRuntime 管理多个会话、并发运行、取消和权限响应。
export class AgentRuntime {
  private readonly loadedSessions = new Map<string, AgentSession>();
  private readonly runControllers = new Map<string, AbortController>();
  private readonly runPromises = new Map<string, Promise<AgentSessionSnapshot>>();
  private readonly listeners = new Set<AgentRuntimeListener>();
  private readonly loop: AgentLoop;

  public constructor(
    private readonly dependencies: AgentRuntimeDependencies,
    loopOptions: AgentLoopOptions,
  ) {
    this.loop = new AgentLoop({
      ...dependencies,
      onEvent: event => this.emit(event),
    }, loopOptions);
  }

  public onEvent(listener: AgentRuntimeListener): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  public async createSession(
    workspaceId: string,
    permissionMode: PermissionMode,
  ): Promise<AgentSessionSnapshot> {
    if (workspaceId.trim() === "") {
      throw new Error("工作区 ID 不能为空");
    }
    const session = new AgentSession(
      this.dependencies.idGenerator.next("session"),
      workspaceId,
      permissionMode,
    );
    this.loadedSessions.set(session.id, session);
    await this.dependencies.sessions.save(session.snapshot());
    const event: AgentEvent = {
      type: "session.created",
      sessionId: session.id,
      workspaceId,
    };
    await this.dependencies.journal.append(event);
    await this.emit(event);
    return session.snapshot();
  }

  public async startSession(
    sessionId: string,
    input: string | AgentUserInput,
    runOptions: AgentRunOptions = {},
  ): Promise<{ runId: string }> {
    const session = await this.requireSession(sessionId);
    if (session.getStatus() === "running" || session.getStatus() === "awaitingPermission") {
      throw new AgentError("RUN_ALREADY_ACTIVE", `会话已有运行任务：${sessionId}`);
    }

    const runId = this.dependencies.idGenerator.next("run");
    const controller = new AbortController();
    session.start(runId);
    await this.dependencies.sessions.save(session.snapshot());
    const startedEvent: AgentEvent = { type: "session.started", sessionId, runId };
    await this.dependencies.journal.append(startedEvent);
    await this.emit(startedEvent);

    const promise = this.loop.run(session, input, controller.signal, runOptions).finally(() => {
      this.runControllers.delete(runId);
      void this.drainNext(session.id);
    });
    this.runControllers.set(runId, controller);
    this.runPromises.set(runId, promise);
    return { runId };
  }

  public async queueInput(sessionId: string, input: AgentUserInput, priority: AgentQueuePriority): Promise<AgentQueuedInput> {
    const session = await this.requireSession(sessionId);
    const queued: AgentQueuedInput = {
      id: this.dependencies.idGenerator.next("queue"),
      priority,
      input,
      createdAt: new Date().toISOString(),
    };
    session.enqueueInput(queued.id, input, priority);
    await this.dependencies.sessions.save(session.snapshot());
    const queuedEvent: AgentEvent = { type: "session.input.queued", sessionId, queueId: queued.id, priority }; await this.dependencies.journal.append(queuedEvent); await this.emit(queuedEvent);
    if (priority === "immediate") this.abortSession(sessionId);
    if (priority === "guide" && session.getStatus() !== "running" && session.getStatus() !== "awaitingPermission") void this.drainGuide(sessionId);
    if ((priority === "next" || priority === "immediate") && session.getStatus() !== "running" && session.getStatus() !== "awaitingPermission") {
      void this.drainNext(sessionId);
    }
    return queued;
  }

  public async removeQueuedInput(sessionId: string, queueId: string): Promise<boolean> {
    const session = await this.requireSession(sessionId);
    const removed = session.removeQueuedInput(queueId);
    if (removed === undefined) return false;
    await this.dependencies.sessions.save(session.snapshot());
    const dequeuedEvent: AgentEvent = { type: "session.input.dequeued", sessionId, queueId }; await this.dependencies.journal.append(dequeuedEvent); await this.emit(dequeuedEvent);
    return true;
  }

  public async listQueuedInputs(sessionId: string): Promise<readonly AgentQueuedInput[]> { return (await this.requireSession(sessionId)).getPendingInputs(); }

  public async runQueuedInput(sessionId: string, queueId: string): Promise<{ runId: string }> {
    const session = await this.requireSession(sessionId);
    const item = session.removeQueuedInput(queueId);
    if (item === undefined) throw new AgentError("INTERNAL_ERROR", `队列项不存在：${queueId}`);
    await this.dependencies.sessions.save(session.snapshot());
    return this.startSession(sessionId, item.input);
  }

  public async renameSession(sessionId: string, title: string): Promise<AgentSessionSnapshot> {
    const session = await this.requireSession(sessionId);
    session.rename(title);
    await this.dependencies.sessions.save(session.snapshot());
    const renamedEvent: AgentEvent = { type: "session.renamed", sessionId, title: session.snapshot().title ?? "" }; await this.dependencies.journal.append(renamedEvent); await this.emit(renamedEvent);
    return session.snapshot();
  }

  public async compactSession(sessionId: string, instructions = ""): Promise<SessionCompactionResult> {
    const session = await this.requireSession(sessionId);
    if (session.getStatus() === "running" || session.getStatus() === "awaitingPermission") throw new AgentError("RUN_ALREADY_ACTIVE", "运行期间不能压缩会话");
    const source = session.getMessages();
    const controller = new AbortController();
    let text = "";
    let usage = { inputTokens: 0, outputTokens: 0 };
    let finish: "stop" | "tool_calls" | undefined;
    for await (const event of this.dependencies.provider.stream({ systemPrompt: `请将以下会话压缩为结构化、忠实、可继续工作的摘要。${instructions}`, messages: source, tools: [], maxOutputTokens: 4096 }, controller.signal)) {
      if (event.type === "text.delta") text += event.delta;
      if (event.type === "response.completed") { finish = event.finishReason; usage = event.usage; }
    }
    if (finish !== "stop" || text.trim() === "") throw new AgentError("MODEL_PROTOCOL_ERROR", "压缩模型未返回有效摘要");
    session.compact(text.trim(), source.length);
    session.addUsage(usage.inputTokens, usage.outputTokens);
    session.setContextTokens(usage.outputTokens);
    await this.dependencies.sessions.save(session.snapshot());
    const compactedEvent: AgentEvent = { type: "session.compacted", sessionId, sourceMessageCount: source.length }; await this.dependencies.journal.append(compactedEvent); await this.emit(compactedEvent);
    return { summary: text.trim(), sourceMessageCount: source.length, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens };
  }

  public async exportSessionMarkdown(sessionId: string, targetPath: string): Promise<string> {
    const session = await this.requireSession(sessionId);
    if (!isAbsolute(targetPath)) throw new Error("导出路径必须是绝对路径");
    const lines = [`# ${session.snapshot().title ?? `Session ${session.id}`}`, ``, `- Session: ${session.id}`, `- Workspace: ${session.workspaceId}`, `- Permission mode: ${session.permissionMode}`, `- Updated: ${session.snapshot().updatedAt}`, ``];
    for (const message of session.getMessages()) {
      lines.push(`## ${message.role}`);
      lines.push(message.content);
      if (message.role === "user" && message.attachments !== undefined) for (const attachment of message.attachments) lines.push(`\nAttachment: ${attachment.path} (${attachment.sha256}, ${attachment.byteLength} bytes)\n\n${attachment.content ?? "binary attachment"}`);
      lines.push("");
    }
    await mkdir(dirname(targetPath), { recursive: true });
    const temporaryPath = `${targetPath}.${this.dependencies.idGenerator.next("export")}.tmp`;
    await writeFile(temporaryPath, `${lines.join("\n")}\n`, "utf8");
    await rename(temporaryPath, targetPath);
    return targetPath;
  }

  public async waitForRun(runId: string): Promise<AgentSessionSnapshot> {
    const promise = this.runPromises.get(runId);
    if (promise === undefined) {
      throw new Error(`运行不存在或已经结束：${runId}`);
    }
    try {
      return await promise;
    } finally {
      this.runPromises.delete(runId);
    }
  }

  public abortSession(sessionId: string): boolean {
    const session = this.loadedSessions.get(sessionId);
    const runId = session?.snapshot().activeRunId;
    if (runId === undefined) {
      return false;
    }
    this.dependencies.permissions.rejectSession(sessionId);
    this.runControllers.get(runId)?.abort();
    return true;
  }

  public clearSessionPermissionGrants(sessionId: string): void { this.dependencies.permissions.clearSession(sessionId); }

  public resolvePermission(requestId: string, decision: "allow" | "deny"): boolean {
    return this.dependencies.permissions.resolve(requestId, decision);
  }

  public resolvePermissionScope(requestId: string, scope: import("./../agent/permission-coordinator.js").PermissionGrantScope | "deny"): boolean {
    return this.dependencies.permissions.resolveWithScope(requestId, scope);
  }


  public async listSessions(workspaceId?: string): Promise<readonly AgentSessionSnapshot[]> {
    const snapshots = await this.dependencies.sessions.list();
    return snapshots
      .filter(snapshot => workspaceId === undefined || snapshot.workspaceId === workspaceId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  public async trashSession(sessionId: string): Promise<TrashedSessionRecord> {
    const session = await this.requireSession(sessionId);
    if (session.getStatus() === "running" || session.getStatus() === "awaitingPermission") throw new AgentError("RUN_ALREADY_ACTIVE", "运行期间不能删除会话");
    const record = await this.dependencies.sessions.trash(session.snapshot());
    this.loadedSessions.delete(sessionId);
    this.dependencies.permissions.clearSession(sessionId);
    return record;
  }

  public listTrashedSessions(): Promise<readonly TrashedSessionRecord[]> { return this.dependencies.sessions.listTrash(); }

  public async restoreTrashedSession(sessionId: string): Promise<AgentSessionSnapshot> {
    const snapshot = await this.dependencies.sessions.restoreTrash(sessionId);
    if (snapshot === undefined) throw new AgentError("SESSION_NOT_FOUND", `回收区不存在会话：${sessionId}`);
    const restored = AgentSession.restore(snapshot);
    this.loadedSessions.set(restored.id, restored);
    return restored.snapshot();
  }

  public deleteTrashedSession(sessionId: string): Promise<boolean> { return this.dependencies.sessions.deletePermanently(sessionId); }

  public purgeTrashedSessions(before = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()): Promise<number> {
    return this.dependencies.sessions.purgeExpired(before);
  }

  public listEvents(sessionId: string): Promise<readonly JournalEntry[]> {
    return this.dependencies.journal.list(sessionId);
  }

  // Retry 创建新会话，保留失败会话作为审计记录，避免重复修改旧会话历史。
  public async retrySession(sessionId: string): Promise<{ sessionId: string; runId: string }> {
    const source = await this.requireSession(sessionId);
    const lastUserMessage = [...source.getMessages()].reverse().find(message => message.role === "user");
    if (lastUserMessage === undefined) {
      throw new AgentError("INTERNAL_ERROR", `会话没有可重试的用户消息：${sessionId}`);
    }
    const created = await this.createSession(source.workspaceId, source.permissionMode);
    const started = await this.startSession(created.id, { content: lastUserMessage.content, ...(lastUserMessage.displayContent === undefined ? {} : { displayContent: lastUserMessage.displayContent }), ...(lastUserMessage.attachments === undefined ? {} : { attachments: lastUserMessage.attachments }) });
    return { sessionId: created.id, runId: started.runId };
  }

  public async createBranchFromSession(sourceSnapshot: AgentSessionSnapshot, checkpointId: string): Promise<AgentSessionSnapshot> {
    const created = await this.createSession(sourceSnapshot.workspaceId, sourceSnapshot.permissionMode);
    const branch = await this.requireSession(created.id);
    for (const message of sourceSnapshot.messages) branch.appendMessage(structuredClone(message));
    branch.addUsage(sourceSnapshot.usage.inputTokens, sourceSnapshot.usage.outputTokens);
    branch.setContextTokens(sourceSnapshot.usage.contextTokens ?? sourceSnapshot.usage.lastInputTokens ?? 0);
    branch.rename(`${sourceSnapshot.title ?? "Session"}（Checkpoint 分支）`);
    branch.setBranchSource({ sessionId: sourceSnapshot.id, checkpointId });
    await this.dependencies.sessions.save(branch.snapshot());
    return branch.snapshot();
  }

  public async getSession(sessionId: string): Promise<AgentSessionSnapshot> {
    return (await this.requireSession(sessionId)).snapshot();
  }

  public async restoreAll(): Promise<readonly AgentSessionSnapshot[]> {
    const snapshots = await this.dependencies.sessions.list();
    const restoredSnapshots: AgentSessionSnapshot[] = [];
    for (const snapshot of snapshots) {
      const session = AgentSession.restore(snapshot);
      if (session.getStatus() === "running" || session.getStatus() === "awaitingPermission") {
        session.fail(
          "INTERRUPTED_RUN_RECOVERED",
          "检测到上次进程退出时仍在运行的会话，已标记为失败；不会伪装成仍在执行",
        );
        await this.dependencies.sessions.save(session.snapshot());
        const event: AgentEvent = {
          type: "session.failed",
          sessionId: session.id,
          code: "INTERRUPTED_RUN_RECOVERED",
          message: "上次运行因进程退出而中断",
        };
        await this.dependencies.journal.append(event);
        await this.emit(event);
      }
      this.loadedSessions.set(snapshot.id, session);
      restoredSnapshots.push(session.snapshot());
    }
    return restoredSnapshots;
  }

  private async requireSession(sessionId: string): Promise<AgentSession> {
    const loaded = this.loadedSessions.get(sessionId);
    if (loaded !== undefined) {
      return loaded;
    }

    const snapshot = await this.dependencies.sessions.load(sessionId);
    if (snapshot === undefined) {
      throw new AgentError("SESSION_NOT_FOUND", `会话不存在：${sessionId}`);
    }
    const restored = AgentSession.restore(snapshot);
    this.loadedSessions.set(sessionId, restored);
    return restored;
  }

  private async drainNext(sessionId: string): Promise<void> {
    const session = this.loadedSessions.get(sessionId);
    if (session === undefined || session.getStatus() === "running" || session.getStatus() === "awaitingPermission") return;
    const item = session.takeQueuedInput("next") ?? session.takeQueuedInput("immediate");
    if (item === undefined) return;
    await this.dependencies.sessions.save(session.snapshot());
    const dequeuedEvent: AgentEvent = { type: "session.input.dequeued", sessionId, queueId: item.id }; await this.dependencies.journal.append(dequeuedEvent); await this.emit(dequeuedEvent);
    try { await this.startSession(sessionId, item.input); } catch { session.enqueueInput(item.id, item.input, "next"); await this.dependencies.sessions.save(session.snapshot()); }
  }

  private async drainGuide(sessionId: string): Promise<void> {
    const session = this.loadedSessions.get(sessionId); if (session === undefined) return;
    const item = session.takeQueuedInput("guide"); if (item === undefined) return;
    await this.dependencies.sessions.save(session.snapshot());
    const dequeuedEvent: AgentEvent = { type: "session.input.dequeued", sessionId, queueId: item.id }; await this.dependencies.journal.append(dequeuedEvent); await this.emit(dequeuedEvent);
    try { await this.startSession(sessionId, item.input); } catch { session.enqueueInput(item.id, item.input, "next"); await this.dependencies.sessions.save(session.snapshot()); }
  }

  private async emit(event: AgentEvent): Promise<void> {
    for (const listener of this.listeners) {
      await listener(event);
    }
  }
}
