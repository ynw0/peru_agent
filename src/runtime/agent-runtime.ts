import type { AgentEvent, PermissionMode } from "../agent-protocol.js";
import { AgentError } from "../agent/errors.js";
import type { EventJournal } from "../agent/event-journal.js";
import type { IdGenerator } from "../agent/id-generator.js";
import { AgentLoop, type AgentLoopOptions } from "../agent/agent-loop.js";
import { PermissionCoordinator } from "../agent/permission-coordinator.js";
import { AgentSession } from "../agent/session.js";
import type { AgentSessionSnapshot } from "../agent/types.js";
import type { ModelProvider } from "../model/types.js";
import type { SessionStore } from "../storage/session-store.js";
import type { ToolRegistry } from "../tool-runtime.js";

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

  public async startSession(sessionId: string, input: string): Promise<{ runId: string }> {
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

    const promise = this.loop.run(session, input, controller.signal).finally(() => {
      this.runControllers.delete(runId);
    });
    this.runControllers.set(runId, controller);
    this.runPromises.set(runId, promise);
    return { runId };
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

  public resolvePermission(requestId: string, decision: "allow" | "deny"): boolean {
    return this.dependencies.permissions.resolve(requestId, decision);
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

  private async emit(event: AgentEvent): Promise<void> {
    for (const listener of this.listeners) {
      await listener(event);
    }
  }
}
