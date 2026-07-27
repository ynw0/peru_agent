import type { JournalEntry } from "../agent/event-journal.js";
import type { AgentSessionSnapshot } from "../agent/types.js";
import type { TypedIpcClient } from "../ipc/channel.js";
import type { WorkbenchSnapshot } from "./workbench-state.js";
import type { BrowserDomSnapshot, BrowserSessionRecord } from "../browser/types.js";
import type { NetworkMode } from "../agent-protocol.js";
import type { EgressAuditEntry } from "../egress/types.js";
import type { WebDownloadArtifact, WebFetchResult, WebSearchResult } from "../web/types.js";
import { EMPTY_WORKBENCH_SNAPSHOT } from "./workbench-state.js";
import type {
  ComputerActionResult,
  ComputerScreenshot,
  ComputerUiSnapshot,
  ComputerUseAuditEntry,
  ComputerWindowRecord,
  PreparedComputerAction,
} from "../computer-use/types.js";

export interface WorkbenchControllerState {
  readonly connected: boolean;
  readonly healthy: boolean;
  readonly healthReason?: string;
  readonly snapshot: WorkbenchSnapshot;
  readonly sessions: readonly AgentSessionSnapshot[];
  readonly timeline: readonly JournalEntry[];
  readonly browserSessions: readonly BrowserSessionRecord[];
  readonly browserSnapshot?: BrowserDomSnapshot;
  readonly computerWindows: readonly ComputerWindowRecord[];
  readonly computerSnapshot?: ComputerUiSnapshot;
  readonly computerPreparedActions: readonly PreparedComputerAction[];
  readonly computerLastAction?: ComputerActionResult;
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
    browserSessions: [],
    computerWindows: [],
    computerPreparedActions: [],
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
      this.client.onEvent("browser.session.changed", session => {
        const browserSessions = [
          ...this.state.browserSessions.filter(item => item.id !== session.id),
          session,
        ].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
        this.update({ browserSessions });
      }),
      this.client.onEvent("browser.snapshot.changed", browserSnapshot => {
        this.update({ browserSnapshot });
      }),
      this.client.onEvent("computer.window.changed", window => {
        const computerWindows = [
          ...this.state.computerWindows.filter(item => item.identity.windowHandle !== window.identity.windowHandle),
          window,
        ].sort((left, right) => left.identity.windowTitle.localeCompare(right.identity.windowTitle));
        this.update({ computerWindows });
      }),
      this.client.onEvent("computer.snapshot.changed", computerSnapshot => {
        this.update({ computerSnapshot });
      }),
      this.client.onEvent("computer.action.prepared", action => {
        const computerPreparedActions = [
          ...this.state.computerPreparedActions.filter(item => item.id !== action.id),
          action,
        ];
        this.update({ computerPreparedActions });
      }),
      this.client.onEvent("computer.action.completed", result => {
        this.update({
          computerLastAction: result,
          computerSnapshot: result.afterSnapshot,
          computerPreparedActions: this.state.computerPreparedActions.filter(item => item.id !== result.actionId),
        });
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

  public async fetchWeb(url: string, mode: NetworkMode, maxChars = 50_000): Promise<WebFetchResult> {
    return this.client.request("web.fetch", { url, mode, maxChars }, { timeoutMs: this.timeoutMs });
  }

  public async searchWeb(query: string, mode: NetworkMode, maxResults = 5): Promise<WebSearchResult> {
    return this.client.request("web.search", { query, mode, maxResults }, { timeoutMs: this.timeoutMs });
  }

  public async downloadWeb(
    workspaceId: string,
    url: string,
    mode: NetworkMode,
    maxBytes = 16 * 1024 * 1024,
  ): Promise<WebDownloadArtifact> {
    return this.client.request("web.download", { workspaceId, url, mode, maxBytes }, { timeoutMs: this.timeoutMs });
  }

  public async listEgressAudit(): Promise<readonly EgressAuditEntry[]> {
    const result = await this.client.request("egress.audit.list", {}, { timeoutMs: this.timeoutMs });
    return result.entries;
  }

  public async createBrowser(workspaceId: string, networkMode: NetworkMode, locale: "zh-CN" | "en-US"): Promise<BrowserSessionRecord> {
    return this.client.request("browser.create", { workspaceId, networkMode, locale }, { timeoutMs: this.timeoutMs });
  }

  public async navigateBrowser(browserSessionId: string, url: string): Promise<BrowserDomSnapshot> {
    return this.client.request("browser.navigate", { browserSessionId, url }, { timeoutMs: this.timeoutMs });
  }

  public async refreshBrowserSnapshot(browserSessionId: string): Promise<BrowserDomSnapshot> {
    return this.client.request("browser.snapshot", { browserSessionId }, { timeoutMs: this.timeoutMs });
  }

  public async downloadBrowser(
    browserSessionId: string,
    url: string,
    maxBytes = 16 * 1024 * 1024,
  ): Promise<WebDownloadArtifact> {
    return this.client.request("browser.download", { browserSessionId, url, maxBytes }, { timeoutMs: this.timeoutMs });
  }

  public async clickBrowser(browserSessionId: string, snapshotId: string, elementId: string): Promise<void> {
    await this.client.request("browser.click", { browserSessionId, snapshotId, elementId }, { timeoutMs: this.timeoutMs });
  }

  public async typeBrowser(browserSessionId: string, snapshotId: string, elementId: string, text: string): Promise<void> {
    await this.client.request("browser.type", { browserSessionId, snapshotId, elementId, text }, { timeoutMs: this.timeoutMs });
  }

  public async closeBrowser(browserSessionId: string): Promise<void> {
    await this.client.request("browser.close", { browserSessionId }, { timeoutMs: this.timeoutMs });
  }

  public async listBrowserSessions(workspaceId?: string): Promise<readonly BrowserSessionRecord[]> {
    const result = await this.client.request("browser.list", workspaceId === undefined ? {} : { workspaceId }, { timeoutMs: this.timeoutMs });
    this.update({ browserSessions: result.sessions });
    return result.sessions;
  }


  public async listComputerWindows(): Promise<readonly ComputerWindowRecord[]> {
    const result = await this.client.request("computer.windows", {}, { timeoutMs: this.timeoutMs });
    this.update({ computerWindows: result.windows });
    return result.windows;
  }

  public async inspectComputerWindow(windowHandle: string): Promise<ComputerUiSnapshot> {
    const snapshot = await this.client.request("computer.inspect", { windowHandle }, { timeoutMs: this.timeoutMs });
    this.update({ computerSnapshot: snapshot });
    return snapshot;
  }

  public screenshotComputer(snapshotId: string): Promise<ComputerScreenshot> {
    return this.client.request("computer.screenshot", { snapshotId }, { timeoutMs: this.timeoutMs });
  }

  public async listComputerAudit(): Promise<readonly ComputerUseAuditEntry[]> {
    const result = await this.client.request("computer.audit.list", {}, { timeoutMs: this.timeoutMs });
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
