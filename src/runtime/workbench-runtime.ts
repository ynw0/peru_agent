import type { AgentEvent } from "../agent-protocol.js";
import type { EventJournal } from "../agent/event-journal.js";
import {
  EMPTY_WORKBENCH_SNAPSHOT,
  projectWorkbenchSnapshot,
  type WorkbenchSnapshot,
} from "../workbench/workbench-state.js";

export interface WorkbenchRuntimeListener {
  (snapshot: WorkbenchSnapshot): void | Promise<void>;
}

// WorkbenchRuntime 按会话保存事件投影；后台会话不会覆盖当前会话的 UI 状态。
export class WorkbenchRuntime {
  private readonly snapshots = new Map<string, WorkbenchSnapshot>();
  private readonly listeners = new Set<WorkbenchRuntimeListener>();
  private activeSessionId: string | undefined;

  public constructor(private readonly journal: EventJournal) {}

  public onSnapshot(listener: WorkbenchRuntimeListener): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  public async handleEvent(event: AgentEvent): Promise<WorkbenchSnapshot> {
    const current = this.snapshots.get(event.sessionId) ?? EMPTY_WORKBENCH_SNAPSHOT;
    const next = projectWorkbenchSnapshot(current, event);
    this.snapshots.set(event.sessionId, next);
    if (event.type === "session.created" || this.activeSessionId === undefined) {
      this.activeSessionId = event.sessionId;
    }
    if (this.activeSessionId === event.sessionId) {
      await this.emit(next);
    }
    return structuredClone(next);
  }

  public activate(sessionId: string): WorkbenchSnapshot {
    const snapshot = this.snapshots.get(sessionId);
    if (snapshot === undefined) {
      throw new Error(`Workbench 会话状态不存在：${sessionId}`);
    }
    this.activeSessionId = sessionId;
    return structuredClone(snapshot);
  }

  public getSnapshot(sessionId?: string): WorkbenchSnapshot {
    const target = sessionId ?? this.activeSessionId;
    if (target === undefined) {
      return structuredClone(EMPTY_WORKBENCH_SNAPSHOT);
    }
    return structuredClone(this.snapshots.get(target) ?? EMPTY_WORKBENCH_SNAPSHOT);
  }

  // 重启后从 EventJournal 重建 UI，不能依赖上次进程中的 DOM/React 状态。
  public async restore(sessionId?: string): Promise<WorkbenchSnapshot> {
    const entries = await this.journal.list(sessionId);
    if (sessionId === undefined) {
      this.snapshots.clear();
      this.activeSessionId = undefined;
    } else {
      this.snapshots.delete(sessionId);
    }
    for (const entry of entries) {
      const current = this.snapshots.get(entry.event.sessionId) ?? EMPTY_WORKBENCH_SNAPSHOT;
      const next = projectWorkbenchSnapshot(current, entry.event);
      this.snapshots.set(entry.event.sessionId, next);
      this.activeSessionId = entry.event.sessionId;
    }
    const snapshot = this.getSnapshot(sessionId);
    await this.emit(snapshot);
    return snapshot;
  }

  private async emit(snapshot: WorkbenchSnapshot): Promise<void> {
    for (const listener of this.listeners) {
      await listener(structuredClone(snapshot));
    }
  }
}
