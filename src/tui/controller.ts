import type { AgentSessionSnapshot, AgentQueuedInput, AgentQueuePriority, AgentUserInput, SessionCompactionResult } from "../agent/types.js";
import type { CheckpointRecord } from "../checkpoint/checkpoint-manager.js";
import type { DiffProposal } from "../diff/diff-manager.js";
import type { ToolManifest } from "../tool-runtime.js";
import type { WorkbenchSnapshot } from "../workbench/workbench-state.js";
import {
  configurationToTuiSetupDraft,
  type TuiConfiguration,
  type TuiHealthReport,
  writeTuiConfiguration,
} from "./config.js";
import type { TuiRuntime, TuiToolResultDetail, TuiContextReport, CheckpointRestoreScope } from "./runtime.js";
import type { PlanRecord } from "../plan/plan-manager.js";
import type { CreatePlanInput } from "../plan/plan-manager.js";
import type { SubagentTaskRecord } from "../subagent/types.js";
import type { SubagentTaskRequest } from "../subagent/types.js";
import type { SubagentCommit } from "../subagent/types.js";
import type { TrashedSessionRecord } from "../storage/session-store.js";
import type { TuiTranscriptEntry } from "./transcript.js";

export interface TuiControllerState {
  readonly runtime: TuiRuntime;
  readonly configuration: TuiConfiguration;
  readonly snapshot: WorkbenchSnapshot;
  readonly activeSession: AgentSessionSnapshot;
  readonly status: string;
  readonly switching: boolean;
  readonly runtimeGeneration: number;
  readonly unreadOutputCount: number;
  readonly lastRunError?: { readonly code: string; readonly message: string };
  readonly health?: TuiHealthReport;
}

export type TuiControllerListener = (state: TuiControllerState) => void | Promise<void>;

export class TuiController {
  private readonly listeners = new Set<TuiControllerListener>();
  private runtimeSubscription: { dispose(): void } | undefined;
  private runtime: TuiRuntime;
  private configuration: TuiConfiguration;
  private snapshot: WorkbenchSnapshot;
  private activeSession: AgentSessionSnapshot;
  private status = "就绪";
  private switching = false;
  private health: TuiHealthReport | undefined;
  private runtimeGeneration = 0;
  private outputCursor = 0;
  private outputFollowing = true;
  private unreadOutputCount = 0;
  private disposed = false;
  private transitionPromise: Promise<void> | undefined;

  public constructor(
    initialRuntime: TuiRuntime,
    configuration: TuiConfiguration,
    private readonly createRuntime: (configuration: TuiConfiguration, path: string) => Promise<TuiRuntime>,
  ) {
    this.runtime = initialRuntime;
    this.configuration = configuration;
    this.snapshot = initialRuntime.getSnapshot();
    this.activeSession = {
      id: initialRuntime.getActiveSessionId() ?? "",
      workspaceId: initialRuntime.workspaceId,
      permissionMode: configuration.permissionMode,
      status: this.snapshot.sessionStatus === "none" ? "idle" : this.snapshot.sessionStatus,
      messages: [],
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      usage: { inputTokens: 0, outputTokens: 0 },
    };
    this.outputCursor = outputCount(this.snapshot);
    this.attachRuntime(initialRuntime);
    void this.refreshActiveSession(initialRuntime, this.runtimeGeneration);
  }

  public getState(): TuiControllerState {
    const lastRunError = this.activeSession.lastError ?? this.snapshot.failed;
    return {
      runtime: this.runtime,
      configuration: structuredClone(this.configuration),
      snapshot: structuredClone(this.snapshot),
      activeSession: structuredClone(this.activeSession),
      status: this.status,
      switching: this.switching,
      runtimeGeneration: this.runtimeGeneration,
      unreadOutputCount: this.unreadOutputCount,
      ...(lastRunError === undefined ? {} : { lastRunError: structuredClone(lastRunError) }),
      ...(this.health === undefined ? {} : { health: structuredClone(this.health) }),
    };
  }

  public getConfiguration(): TuiConfiguration {
    return structuredClone(this.configuration);
  }

  public onState(listener: TuiControllerListener): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  public getRuntime(): TuiRuntime {
    return this.runtime;
  }

  public markOutputFollowing(following: boolean): void {
    this.outputFollowing = following;
    if (following) this.unreadOutputCount = 0;
    this.emit();
  }

  public markOutputRead(): void {
    this.outputCursor = outputCount(this.snapshot);
    this.unreadOutputCount = 0;
    this.outputFollowing = true;
    this.emit();
  }

  public setStatus(status: string): void {
    this.status = status;
    this.emit();
  }

  public async prepareUserInput(input: string): Promise<AgentUserInput> { return this.runtime.prepareUserInput(input); }
  public getExternalPathCandidates(input: string): readonly string[] { return this.runtime.getExternalPathCandidates(input); }
  public authorizeExternalDirectory(path: string): Promise<import("./external-access.js").ExternalDirectoryGrant> { return this.runtime.authorizeExternalDirectory(path); }
  public prepareAuthorizedExternalInput(input: string, paths: readonly string[]): Promise<AgentUserInput> { return this.runtime.prepareAuthorizedExternalInput(input, paths); }
  public async authorizeAndSendExternalInput(input: string, paths: readonly string[]): Promise<{ readonly runId: string }> {
    const started = await this.runtime.authorizeAndSendExternalInput(input, paths);
    this.setStatus(`运行中：${started.runId}`);
    return started;
  }
  public async sendInput(input: string | AgentUserInput): Promise<{ readonly runId: string }> {
    const started = await this.runtime.sendInput(input);
    this.setStatus(`运行中：${started.runId}`);
    return started;
  }

  public queueInput(input: AgentUserInput, priority: AgentQueuePriority): Promise<AgentQueuedInput> { return this.runtime.queueInput(input, priority); }
  public listQueuedInputs(): Promise<readonly AgentQueuedInput[]> { return this.runtime.listQueuedInputs(); }
  public removeQueuedInput(id: string): Promise<boolean> { return this.runtime.removeQueuedInput(id); }
  public runQueuedInput(id: string): Promise<{ readonly runId: string }> { return this.runtime.runQueuedInput(id); }
  public renameActiveSession(title: string): Promise<AgentSessionSnapshot> { return this.runtime.renameActiveSession(title); }
  public compactActiveSession(instructions?: string): Promise<SessionCompactionResult> { return this.runtime.compactActiveSession(instructions); }
  public exportActiveSession(path?: string): Promise<string> { return this.runtime.exportActiveSession(path); }
  public loadInputHistory(): Promise<readonly string[]> { return this.runtime.loadInputHistory(); }
  public recordInputHistory(input: string): Promise<void> { return this.runtime.recordInputHistory(input); }

  public abortActiveRun(): boolean {
    return this.runtime.abortActiveRun();
  }

  public async createSession(permissionMode = this.configuration.permissionMode): Promise<AgentSessionSnapshot> {
    const created = await this.runtime.createSession(permissionMode);
    this.activeSession = created;
    this.snapshot = this.runtime.getSnapshot();
    this.resetOutputCursor();
    this.setStatus(`已创建会话：${created.id}（${modeLabel(permissionMode)}）`);
    return created;
  }

  public async activateSession(sessionId: string): Promise<AgentSessionSnapshot> {
    const session = await this.runtime.activateSession(sessionId);
    this.activeSession = session;
    this.snapshot = this.runtime.getSnapshot();
    this.resetOutputCursor();
    this.setStatus(`已恢复会话：${session.id}（${modeLabel(session.permissionMode)}）`);
    return session;
  }
  public trashSession(sessionId: string): Promise<TrashedSessionRecord> { return this.runtime.trashSession(sessionId); }
  public listTrash(): Promise<readonly TrashedSessionRecord[]> { return this.runtime.listTrash(); }
  public restoreTrash(sessionId: string): Promise<AgentSessionSnapshot> { return this.runtime.restoreTrash(sessionId); }
  public deleteTrash(sessionId: string): Promise<boolean> { return this.runtime.deleteTrash(sessionId); }

  public switchWorkspace(path: string): Promise<void> {
    this.assertIdle("运行期间不能切换工作区，请先按 Ctrl+C");
    return this.runTransition(async () => {
      this.switching = true;
      this.setStatus(`正在切换工作区：${path}`);
      let next: TuiRuntime | undefined;
      try {
        const candidate = await this.createRuntime(this.configuration, path);
        next = candidate;
        await this.replaceRuntime(candidate, this.configuration, `工作区已切换：${candidate.workspaceRoot}`);
        next = undefined;
      } finally {
        if (next !== undefined) await next.dispose().catch(() => undefined);
        this.switching = false;
        this.emit();
      }
    });
  }

  public reconfigure(configuration: TuiConfiguration): Promise<void> {
    this.assertIdle("运行期间不能修改配置，请先按 Ctrl+C");
    return this.runTransition(async () => {
      this.switching = true;
      this.setStatus("正在验证并切换 TUI 配置…");
      let next: TuiRuntime | undefined;
      try {
        const candidate = await this.createRuntime(configuration, this.runtime.workspaceRoot);
        next = candidate;
        await this.replaceRuntime(candidate, configuration, "TUI 配置已生效");
        next = undefined;
      } finally {
        if (next !== undefined) await next.dispose().catch(() => undefined);
        this.switching = false;
        this.emit();
      }
    });
  }

  public resolvePermission(requestId: string, decision: "allow" | "deny"): boolean {
    return this.runtime.resolvePermission(requestId, decision);
  }
  public grantPermission(requestId: string, scope: "session" | "project"): boolean { return this.runtime.grantPermission?.(requestId, scope) ?? false; }

  public resolveDiff(proposalId: string, decision: "accepted" | "rejected"): Promise<DiffProposal> {
    return this.runtime.resolveDiff(proposalId, decision);
  }

  public listDiffs(): readonly DiffProposal[] { return this.runtime.listDiffs(); }
  public getDiff(proposalId: string): DiffProposal | undefined { return this.runtime.getDiff(proposalId); }
  public listSessions(): Promise<readonly AgentSessionSnapshot[]> { return this.runtime.listSessions(); }
  public listCheckpoints(): Promise<readonly CheckpointRecord[]> { return this.runtime.listCheckpoints(); }
  public restoreCheckpoint(checkpointId: string, scope?: CheckpointRestoreScope): Promise<CheckpointRecord> { return this.runtime.restoreCheckpoint(checkpointId, scope); }
  public listTools(): readonly ToolManifest[] { return this.runtime.listTools(); }
  public getToolResult(toolCallId: string): Promise<TuiToolResultDetail | undefined> { return this.runtime.getToolResult(toolCallId); }
  public getContextReport(): Promise<TuiContextReport> { return this.runtime.getContextReport(); }
  public listTranscriptEntries(): Promise<readonly TuiTranscriptEntry[]> { return this.runtime.listTranscriptEntries(); }
  public listPlans(): readonly PlanRecord[] { return this.runtime.listPlans?.() ?? []; }
  public resolvePlan(planId: string, decision: "approved" | "rejected"): Promise<PlanRecord> {
    if (this.runtime.resolvePlan === undefined) return Promise.reject(new Error("当前 Runtime 未启用 Plan"));
    return this.runtime.resolvePlan(planId, decision);
  }
  public completePlan(planId: string): Promise<PlanRecord> { if (this.runtime.completePlan === undefined) return Promise.reject(new Error("当前 Runtime 未启用 Plan")); return this.runtime.completePlan(planId); }
  public cancelPlan(planId: string): Promise<PlanRecord> { if (this.runtime.cancelPlan === undefined) return Promise.reject(new Error("当前 Runtime 未启用 Plan")); return this.runtime.cancelPlan(planId); }
  public listTasks(): readonly SubagentTaskRecord[] { return this.runtime.listTasks?.() ?? []; }
  public startTask(taskId: string): Promise<SubagentTaskRecord> { if (this.runtime.startTask === undefined) return Promise.reject(new Error("当前 Runtime 未启用子 Agent")); return this.runtime.startTask(taskId); }
  public abortTask(taskId: string): Promise<boolean> { if (this.runtime.abortTask === undefined) return Promise.reject(new Error("当前 Runtime 未启用子 Agent")); return this.runtime.abortTask(taskId); }
  public createPlan(instruction: string): Promise<PlanRecord> { if (this.runtime.createPlan === undefined) return Promise.reject(new Error("当前 Runtime 未启用 Plan")); return this.runtime.createPlan(instruction); }
  public dispatchTask(instruction: string): Promise<SubagentTaskRecord> { if (this.runtime.dispatchTask === undefined) return Promise.reject(new Error("当前 Runtime 未启用子 Agent")); return this.runtime.dispatchTask(instruction); }
  public createStructuredPlan(input: Omit<CreatePlanInput, "sessionId">): Promise<PlanRecord> { if (this.runtime.createStructuredPlan === undefined) return Promise.reject(new Error("当前 Runtime 未启用 Plan")); return this.runtime.createStructuredPlan(input); }
  public dispatchStructuredTask(input: Omit<SubagentTaskRequest, "parentSessionId" | "baseWorkspaceId">): Promise<SubagentTaskRecord> { if (this.runtime.dispatchStructuredTask === undefined) return Promise.reject(new Error("当前 Runtime 未启用子 Agent")); return this.runtime.dispatchStructuredTask(input); }
  public listArtifacts(): Promise<readonly SubagentCommit[]> { if (this.runtime.listArtifacts === undefined) return Promise.resolve([]); return this.runtime.listArtifacts(); }
  public deleteArtifact(commitId: string): Promise<boolean> { if (this.runtime.deleteArtifact === undefined) return Promise.reject(new Error("当前 Runtime 未启用 Commit")); return this.runtime.deleteArtifact(commitId); }
  public retryGateAttempt(taskId: string): Promise<SubagentTaskRecord> { if (this.runtime.retryGateAttempt === undefined) return Promise.reject(new Error("当前 Runtime 未启用门禁重试")); return this.runtime.retryGateAttempt(taskId); }

  public async retryActiveSession(): Promise<{ readonly sessionId: string; readonly runId: string }> {
    const retried = await this.runtime.retryActiveSession();
    this.activeSession = await this.runtime.getActiveSession();
    this.snapshot = this.runtime.getSnapshot();
    this.resetOutputCursor();
    this.setStatus(`已创建重试会话：${retried.sessionId}`);
    return retried;
  }

  public async doctor(): Promise<TuiHealthReport> {
    const report = await this.runtime.getHealthReport();
    this.health = report;
    this.setStatus(report.ok ? "健康检查通过" : "健康检查未通过");
    return report;
  }

  public async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.detachRuntime();
    await this.transitionPromise?.catch(() => undefined);
    await this.runtime.dispose();
  }

  private async replaceRuntime(next: TuiRuntime, configuration: TuiConfiguration, status: string): Promise<void> {
    if (this.disposed) throw new Error("TUI Controller 已关闭");
    const nextSession = await next.getActiveSession();
    if (this.disposed) throw new Error("TUI Controller 已关闭");
    if (configuration.configPath !== this.configuration.configPath || configuration !== this.configuration) {
      await writeTuiConfiguration(configurationToTuiSetupDraft(configuration));
    }
    const previous = this.runtime;
    this.runtimeGeneration += 1;
    this.detachRuntime();
    this.runtime = next;
    this.configuration = configuration;
    this.snapshot = next.getSnapshot();
    this.activeSession = nextSession;
    this.resetOutputCursor();
    this.attachRuntime(next);
    // The new runtime is already active at this point. A failed best-effort
    // cleanup of the old runtime must not make a successful transaction look
    // like a failed workspace/configuration switch.
    await previous.dispose().catch(error => {
      this.status = `旧 Runtime 释放失败：${errorMessage(error)}`;
    });
    this.setStatus(status);
  }

  private runTransition(action: () => Promise<void>): Promise<void> {
    if (this.transitionPromise !== undefined) throw new Error("已有工作区或配置切换正在进行");
    const promise = action();
    this.transitionPromise = promise;
    void promise.finally(() => {
      if (this.transitionPromise === promise) this.transitionPromise = undefined;
    }).catch(() => undefined);
    return promise;
  }

  private attachRuntime(runtime: TuiRuntime): void {
    const generation = this.runtimeGeneration;
    this.runtimeSubscription = runtime.onSnapshot(snapshot => {
      if (generation !== this.runtimeGeneration || runtime !== this.runtime || this.disposed) return;
      this.snapshot = snapshot;
      this.updateUnreadOutput(snapshot);
      this.emit();
      void this.refreshActiveSession(runtime, generation);
    });
  }

  private detachRuntime(): void {
    this.runtimeSubscription?.dispose();
    this.runtimeSubscription = undefined;
  }

  private async refreshActiveSession(runtime: TuiRuntime, generation: number): Promise<void> {
    try {
      const session = await runtime.getActiveSession();
      if (generation !== this.runtimeGeneration || runtime !== this.runtime || this.disposed) return;
      this.activeSession = session;
      this.emit();
    } catch (error: unknown) {
      if (generation === this.runtimeGeneration && runtime === this.runtime) this.setStatus(errorMessage(error));
    }
  }

  private updateUnreadOutput(snapshot: WorkbenchSnapshot): void {
    const total = outputCount(snapshot);
    const added = Math.max(0, total - this.outputCursor);
    if (!this.outputFollowing && added > 0) this.unreadOutputCount += added;
    if (this.outputFollowing) this.unreadOutputCount = 0;
    this.outputCursor = total;
  }

  private resetOutputCursor(): void {
    this.outputCursor = outputCount(this.snapshot);
    this.outputFollowing = true;
    this.unreadOutputCount = 0;
  }

  private assertIdle(message: string): void {
    if (this.snapshot.sessionStatus === "running" || this.snapshot.sessionStatus === "awaitingPermission") {
      throw new Error(message);
    }
  }

  private emit(): void {
    const state = this.getState();
    for (const listener of this.listeners) {
      void Promise.resolve(listener(state)).catch(error => this.setStatus(errorMessage(error)));
    }
  }
}

function outputCount(snapshot: WorkbenchSnapshot): number {
  return snapshot.chatMessages.length + snapshot.tools.length;
}

function modeLabel(mode: AgentSessionSnapshot["permissionMode"]): string {
  return mode === "autoReview" ? "autoReview" : "default";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "TUI Runtime 错误";
}
