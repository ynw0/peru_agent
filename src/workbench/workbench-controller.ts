import type { JournalEntry } from "../agent/event-journal.js";
import type { AgentSessionSnapshot } from "../agent/types.js";
import type { TypedIpcClient } from "../ipc/channel.js";
import type { WorkbenchSnapshot } from "./workbench-state.js";
import { EMPTY_WORKBENCH_SNAPSHOT } from "./workbench-state.js";

export interface WorkbenchControllerState {
  readonly connected: boolean;
  readonly healthy: boolean;
  readonly healthReason?: string;
  readonly snapshot: WorkbenchSnapshot;
  readonly sessions: readonly AgentSessionSnapshot[];
  readonly timeline: readonly JournalEntry[];
}

export interface WorkbenchControllerListener {
  (state: WorkbenchControllerState): void;
}

// WorkbenchController 是 UI 按钮的唯一入口；它只能调用 Typed IPC。
export class WorkbenchController {
  private state: WorkbenchControllerState = {
    connected: false,
    healthy: false,
    snapshot: EMPTY_WORKBENCH_SNAPSHOT,
    sessions: [],
    timeline: [],
  };
  private readonly listeners = new Set<WorkbenchControllerListener>();
  private readonly disposables: { dispose(): void }[] = [];

  public constructor(
    private readonly client: TypedIpcClient,
    private readonly timeoutMs = 30_000,
  ) {}

  public onState(listener: WorkbenchControllerListener): { dispose(): void } {
    this.listeners.add(listener);
    listener(this.getState());
    return { dispose: () => this.listeners.delete(listener) };
  }

  public start(): void {
    this.disposables.push(
      this.client.onEvent("workbench.snapshot.changed", snapshot => {
        this.update({ snapshot, connected: true });
      }),
      this.client.onEvent("runtime.health.changed", health => {
        if (health.reason === undefined) {
          const { healthReason: _healthReason, ...rest } = this.state;
          this.state = { ...rest, healthy: health.healthy };
          this.emit();
        } else {
          this.update({ healthy: health.healthy, healthReason: health.reason });
        }
      }),
    );
  }

  public dispose(): void {
    for (const disposable of this.disposables.splice(0)) {
      disposable.dispose();
    }
    this.listeners.clear();
  }

  public getState(): WorkbenchControllerState {
    return structuredClone(this.state);
  }

  public async refresh(sessionId?: string): Promise<WorkbenchSnapshot> {
    const snapshot = await this.client.request(
      "workbench.getSnapshot",
      sessionId === undefined ? {} : { sessionId },
      { timeoutMs: this.timeoutMs },
    );
    this.update({ snapshot, connected: true });
    if (snapshot.activeSessionId !== undefined) {
      await this.loadTimeline(snapshot.activeSessionId);
    }
    return snapshot;
  }

  public async createAndSend(workspaceId: string, input: string): Promise<{ sessionId: string; runId: string }> {
    const created = await this.client.request("session.create", { workspaceId }, { timeoutMs: this.timeoutMs });
    const started = await this.client.request(
      "session.start",
      { sessionId: created.sessionId, input },
      { timeoutMs: this.timeoutMs },
    );
    await this.refresh(created.sessionId);
    return { sessionId: created.sessionId, runId: started.runId };
  }

  public async continueSession(sessionId: string, input: string): Promise<string> {
    const result = await this.client.request("session.start", { sessionId, input }, { timeoutMs: this.timeoutMs });
    return result.runId;
  }

  public async stop(sessionId: string): Promise<boolean> {
    const result = await this.client.request("session.abort", { sessionId }, { timeoutMs: this.timeoutMs });
    return result.aborted;
  }

  public async retry(sessionId: string): Promise<{ sessionId: string; runId: string }> {
    const result = await this.client.request("session.retry", { sessionId }, { timeoutMs: this.timeoutMs });
    await this.refresh(result.sessionId);
    return result;
  }

  public async resolvePermission(requestId: string, decision: "allow" | "deny"): Promise<boolean> {
    const result = await this.client.request(
      "permission.resolve",
      { requestId, decision },
      { timeoutMs: this.timeoutMs },
    );
    return result.accepted;
  }

  public async resolvePlan(planId: string, decision: "approved" | "rejected"): Promise<void> {
    await this.client.request("plan.resolve", { planId, decision }, { timeoutMs: this.timeoutMs });
  }

  public async acceptDiff(proposalId: string): Promise<void> {
    await this.client.request("diff.accept", { proposalId }, { timeoutMs: this.timeoutMs });
  }

  public async rejectDiff(proposalId: string): Promise<void> {
    await this.client.request("diff.reject", { proposalId }, { timeoutMs: this.timeoutMs });
  }

  public async restoreCheckpoint(checkpointId: string): Promise<void> {
    await this.client.request("checkpoint.restore", { checkpointId }, { timeoutMs: this.timeoutMs });
  }

  public async listSessions(workspaceId?: string): Promise<readonly AgentSessionSnapshot[]> {
    const result = await this.client.request(
      "session.list",
      workspaceId === undefined ? {} : { workspaceId },
      { timeoutMs: this.timeoutMs },
    );
    this.update({ sessions: result.sessions });
    return result.sessions;
  }

  public async loadTimeline(sessionId: string): Promise<readonly JournalEntry[]> {
    const result = await this.client.request("session.events", { sessionId }, { timeoutMs: this.timeoutMs });
    this.update({ timeline: result.entries });
    return result.entries;
  }

  private update(changes: Partial<WorkbenchControllerState>): void {
    this.state = { ...this.state, ...changes };
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) {
      listener(this.getState());
    }
  }
}
