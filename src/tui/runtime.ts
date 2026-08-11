import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { PermissionReply } from "../permission-rules.js";
import type { AgentSessionSnapshot } from "../agent/types.js";
import type { TrashedSessionRecord } from "../storage/session-store.js";
import { AgentRuntime } from "../runtime/agent-runtime.js";
import { createAgentCoreComposition, type AgentCoreComposition } from "../runtime/agent-core-composition.js";
import { WorkbenchEventConnector } from "../runtime/workbench-event-connector.js";
import type { WorkbenchSnapshot } from "../workbench/workbench-state.js";
import { buildSystemPrompt } from "../prompt/system-prompt-builder.js";
import { OpenAICompatibleProvider } from "../model/openai-compatible-provider.js";
import { ChildProcessSandboxBrokerTransport } from "../sandbox/broker-transport.js";
import { WindowsSandboxBrokerClient } from "../sandbox/broker-client.js";
import { createPowerShellTool } from "../powershell/powershell-tool.js";
import type { DiffProposal } from "../diff/diff-manager.js";
import type { CheckpointRecord } from "../checkpoint/checkpoint-manager.js";
import type { ToolManifest } from "../tool-runtime.js";
import type { AgentUserInput, AgentQueuedInput, AgentQueuePriority, SessionCompactionResult } from "../agent/types.js";
import { buildAgentUserInput } from "./user-input.js";
import { buildAuthorizedExternalUserInput } from "./user-input.js";
import { ExternalAccessCoordinator, findExternalPathCandidates, type ExternalDirectoryGrant } from "./external-access.js";
import { checkTuiHealth, type TuiConfiguration, type TuiHealthReport, type TuiSetupDraft, resolveWorkspaceRoot } from "./config.js";
import { createOrchestrationTools } from "../tools/orchestration-tools.js";
import type { PlanRecord } from "../plan/plan-manager.js";
import type { CreatePlanInput } from "../plan/plan-manager.js";
import type { SubagentTaskRecord } from "../subagent/types.js";
import type { SubagentTaskRequest } from "../subagent/types.js";
import type { SubagentCommit } from "../subagent/types.js";
import { buildTuiTranscriptEntries, type TuiTranscriptEntry } from "./transcript.js";

export interface TuiRuntimeListener {
  (snapshot: WorkbenchSnapshot): void | Promise<void>;
}

export interface TuiToolResultDetail {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly content: string;
  readonly isError: boolean;
  readonly powerShell?: {
    readonly stdout: string;
    readonly stderr: string;
    readonly exitCode: number;
    readonly timedOut: boolean;
    readonly interrupted: boolean;
    readonly auditLogPath: string;
    readonly durationMs: number;
  };
}

export interface TuiContextReport {
  readonly contextWindowTokens: number;
  readonly recentInputTokens: number;
  readonly usedPercent: number;
  readonly remainingTokens: number;
}

export type CheckpointRestoreScope = "filesAndConversation" | "filesOnly" | "conversationOnly";

export interface TuiRuntime {
  readonly workspaceId: string;
  readonly workspaceRoot: string;
  readonly agent: AgentRuntime;
  readonly configuration: TuiConfiguration;
  getSnapshot(): WorkbenchSnapshot;
  onSnapshot(listener: TuiRuntimeListener): { dispose(): void };
  getActiveSessionId(): string | undefined;
  getActiveSession(): Promise<AgentSessionSnapshot>;
  sendInput(input: string | AgentUserInput): Promise<{ readonly runId: string }>;
  prepareUserInput(input: string): Promise<AgentUserInput>;
  getExternalPathCandidates(input: string): readonly string[];
  authorizeExternalDirectory(path: string): Promise<ExternalDirectoryGrant>;
  prepareAuthorizedExternalInput(input: string, paths: readonly string[]): Promise<AgentUserInput>;
  authorizeAndPrepareExternalInput(input: string, paths: readonly string[]): Promise<AgentUserInput>;
  authorizeAndSendExternalInput(input: string, paths: readonly string[]): Promise<{ readonly runId: string }>;
  queueInput(input: AgentUserInput, priority: AgentQueuePriority): Promise<AgentQueuedInput>;
  listQueuedInputs(): Promise<readonly AgentQueuedInput[]>;
  removeQueuedInput(queueId: string): Promise<boolean>;
  runQueuedInput(queueId: string): Promise<{ readonly runId: string }>;
  renameActiveSession(title: string): Promise<AgentSessionSnapshot>;
  compactActiveSession(instructions?: string): Promise<SessionCompactionResult>;
  exportActiveSession(targetPath?: string): Promise<string>;
  suggestFiles(query: string, maxResults?: number): Promise<readonly string[]>;
  loadInputHistory(): Promise<readonly string[]>;
  recordInputHistory(input: string): Promise<void>;
  abortActiveRun(): boolean;
  createSession(permissionMode?: TuiConfiguration["permissionMode"]): Promise<AgentSessionSnapshot>;
  activateSession(sessionId: string): Promise<AgentSessionSnapshot>;
  listSessions(): Promise<readonly AgentSessionSnapshot[]>;
  trashSession(sessionId: string): Promise<TrashedSessionRecord>;
  listTrash(): Promise<readonly TrashedSessionRecord[]>;
  restoreTrash(sessionId: string): Promise<AgentSessionSnapshot>;
  deleteTrash(sessionId: string): Promise<boolean>;
  listDiffs(): readonly DiffProposal[];
  getDiff(proposalId: string): DiffProposal | undefined;
  resolvePermission(requestId: string, reply: PermissionReply): boolean;
  resolveDiff(proposalId: string, decision: "accepted" | "rejected"): Promise<DiffProposal>;
  listCheckpoints(): Promise<readonly CheckpointRecord[]>;
  restoreCheckpoint(checkpointId: string, scope?: CheckpointRestoreScope): Promise<CheckpointRecord>;
  retryActiveSession(): Promise<{ readonly sessionId: string; readonly runId: string }>;
  getToolResult(toolCallId: string): Promise<TuiToolResultDetail | undefined>;
  getHealthReport(): Promise<TuiHealthReport>;
  getContextReport(): Promise<TuiContextReport>;
  listTools(): readonly ToolManifest[];
  getSession(sessionId: string): Promise<AgentSessionSnapshot>;
  listTranscriptEntries(): Promise<readonly TuiTranscriptEntry[]>;
  listPlans?(): readonly PlanRecord[];
  resolvePlan?(planId: string, decision: "approved" | "rejected"): Promise<PlanRecord>;
  completePlan?(planId: string): Promise<PlanRecord>;
  cancelPlan?(planId: string): Promise<PlanRecord>;
  listTasks?(): readonly SubagentTaskRecord[];
  startTask?(taskId: string): Promise<SubagentTaskRecord>;
  waitTask?(taskId: string): Promise<SubagentTaskRecord>;
  abortTask?(taskId: string): Promise<boolean>;
  createPlan?(instruction: string): Promise<PlanRecord>;
  dispatchTask?(instruction: string, role?: "planner" | "explorer"): Promise<SubagentTaskRecord>;
  createStructuredPlan?(input: Omit<CreatePlanInput, "sessionId">): Promise<PlanRecord>;
  dispatchStructuredTask?(input: Omit<SubagentTaskRequest, "parentSessionId" | "baseWorkspaceId">): Promise<SubagentTaskRecord>;
  listArtifacts?(): Promise<readonly SubagentCommit[]>;
  deleteArtifact?(commitId: string): Promise<boolean>;
  retryGateAttempt?(taskId: string): Promise<SubagentTaskRecord>;
  dispose(): Promise<void>;
}

export async function createTuiRuntime(
  configuration: TuiConfiguration,
  requestedWorkspaceRoot: string,
): Promise<TuiRuntime> {
  const workspaceRoot = await resolveWorkspaceRoot(requestedWorkspaceRoot);
  const canonicalRoot = await realpath(workspaceRoot);
  const workspaceId = createWorkspaceId(canonicalRoot);
  const core = createAgentCoreComposition(configuration.dataDirectory);
  await core.workspace.registerWorkspace(workspaceId, canonicalRoot);
  const externalAccess = new ExternalAccessCoordinator(core.workspaces);
  core.targetResolver.setExternalResolver(externalAccess);

  const sandboxBroker = new WindowsSandboxBrokerClient(
    new ChildProcessSandboxBrokerTransport(configuration.sandboxBrokerExecutablePath),
  );
  try {
    await sandboxBroker.initialize();
    core.tools.register(createPowerShellTool({
      broker: sandboxBroker,
      workspaces: core.workspaces,
      getNetworkMode: () => configuration.networkMode,
    }));

    let activeSessionId = "";
    for (const tool of createOrchestrationTools({ plans: core.plans, planReviews: core.orchestration.planReviews, scheduler: core.orchestration.scheduler, gateReports: core.orchestration.gateReports, sessionId: () => activeSessionId, workspaceId })) core.tools.register(tool);
    const projectRules = await loadProjectRules(canonicalRoot);
    const provider = new OpenAICompatibleProvider({
      baseUrl: configuration.model.baseUrl,
      chatCompletionsPath: configuration.model.chatCompletionsPath,
      model: configuration.model.model,
      apiKeyReference: "config:apiKey",
    }, {
      credentialResolver: {
        resolve: async reference => {
          const prefix = "config:apiKey";
          if (reference !== prefix) throw new Error("TUI Provider 收到未授权的凭据引用");
          if (configuration.model.apiKey.trim() === "") throw new Error("TUI 配置缺少 model.apiKey");
          return configuration.model.apiKey;
        },
      },
    });
    const agent = new AgentRuntime({
      provider,
      tools: core.tools,
      permissions: core.permissions,
      journal: core.journal,
      sessions: core.sessions,
      idGenerator: core.ids,
    }, {
      systemPrompt: buildSystemPrompt({
        workspaceRoot: canonicalRoot,
        networkMode: configuration.networkMode,
        toolManifests: core.tools.listManifests(manifest => manifest.visibility !== "subagent"),
        ...(projectRules === undefined ? {} : { projectRules }),
        browserEnabled: false,
        computerUseEnabled: false,
      }),
      systemContextProvider: {
        getContext: session => externalAccess.getModelContext(session.id),
      },
      maxOutputTokensPerTurn: 8_192,
      contextWindowTokens: configuration.model.contextWindowTokens,
      // A run budget must allow at least one full-context request plus its
      // response. Otherwise the hard budget can pre-empt the 80% compaction
      // boundary before the compactor is allowed to run.
      limits: {
        maxTurns: 24,
        maxToolCalls: 48,
        maxTotalTokens: Math.max(120_000, configuration.model.contextWindowTokens + 8_192),
      },
    });
    core.orchestration.bindAgentRuntime(agent);
    const connector = new WorkbenchEventConnector(agent, core.workspace, core.plans, core.workbench, core.orchestration.scheduler);
    connector.start();

    await agent.restoreAll();
    await agent.purgeTrashedSessions();
    await core.diffs.restoreAll();
    core.plans.restoreFromEvents((await core.journal.list()).map(entry => entry.event));
    await core.workbench.restore();
    activeSessionId = await selectInitialSession(agent, workspaceId, configuration.permissionMode);
    await core.orchestration.restore();
    const runtime = new TuiRuntimeImpl(
      configuration,
      canonicalRoot,
      workspaceId,
      agent,
      core,
      externalAccess,
      sandboxBroker,
      connector,
      activeSessionId,
    );
    return runtime;
  } catch (error: unknown) {
    sandboxBroker.dispose();
    throw error;
  }
}

class TuiRuntimeImpl implements TuiRuntime {
  private readonly listeners = new Set<TuiRuntimeListener>();
  private readonly workbenchSubscription: { dispose(): void };
  private activeRunPromise: Promise<AgentSessionSnapshot> | undefined;
  private disposed = false;

  public constructor(
    public readonly configuration: TuiConfiguration,
    public readonly workspaceRoot: string,
    public readonly workspaceId: string,
    public readonly agent: AgentRuntime,
    private readonly core: AgentCoreComposition,
    private readonly externalAccess: ExternalAccessCoordinator,
    private readonly sandboxBroker: WindowsSandboxBrokerClient,
    private readonly connector: WorkbenchEventConnector,
    private activeSessionId: string,
  ) {
    this.workbenchSubscription = this.core.workbench.onSnapshot(snapshot => this.emitSnapshot(snapshot));
  }

  public getSnapshot(): WorkbenchSnapshot {
    return this.core.workbench.getSnapshot(this.activeSessionId);
  }

  public onSnapshot(listener: TuiRuntimeListener): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  public getActiveSessionId(): string | undefined {
    return this.activeSessionId;
  }

  public getActiveSession(): Promise<AgentSessionSnapshot> {
    return this.agent.getSession(this.activeSessionId);
  }

  public async sendInput(input: string | AgentUserInput): Promise<{ readonly runId: string }> {
    if (this.disposed) throw new Error("TUI Runtime 已关闭");
    const started = await this.agent.startSession(this.activeSessionId, input);
    this.trackRun(started.runId);
    return started;
  }

  public async authorizeAndPrepareExternalInput(input: string, paths: readonly string[]): Promise<AgentUserInput> {
    if (this.disposed) throw new Error("TUI Runtime 已关闭");
    const sessionId = this.activeSessionId;
    const prepared = await this.prepareExternalInputForSession(input, paths, sessionId);
    if (this.activeSessionId !== sessionId) throw new Error("授权期间活动 Session 已切换，未生成输入");
    return prepared;
  }

  public async authorizeAndSendExternalInput(input: string, paths: readonly string[]): Promise<{ readonly runId: string }> {
    if (this.disposed) throw new Error("TUI Runtime 已关闭");
    const sessionId = this.activeSessionId;
    const prepared = await this.prepareExternalInputForSession(input, paths, sessionId);
    if (this.activeSessionId !== sessionId) throw new Error("授权期间活动 Session 已切换，未发送输入");
    const started = await this.agent.startSession(sessionId, prepared);
    this.trackRun(started.runId);
    return started;
  }

  private async prepareExternalInputForSession(
    input: string,
    paths: readonly string[],
    sessionId: string,
  ): Promise<AgentUserInput> {
    const directories: string[] = [];
    for (const path of paths) {
      const status = await lstat(path).catch(() => undefined);
      if (status === undefined) throw new Error(`外部路径不存在：${path}`);
      directories.push(status.isDirectory() ? path : dirname(path));
    }
    for (const directory of new Set(directories)) await this.externalAccess.authorizeDirectory(sessionId, directory);
    return buildAuthorizedExternalUserInput(input, paths, this.externalAccess, sessionId);
  }

  private trackRun(runId: string): void {
    const runPromise = this.agent.waitForRun(runId);
    let trackedRun: Promise<AgentSessionSnapshot>;
    trackedRun = runPromise.finally(() => {
      if (this.activeRunPromise === trackedRun) this.activeRunPromise = undefined;
    });
    this.activeRunPromise = trackedRun;
    void this.activeRunPromise.catch(() => undefined);
  }
  public prepareUserInput(input: string): Promise<AgentUserInput> { return buildAgentUserInput(input, this.core.workspaces.get(this.workspaceId)); }
  public getExternalPathCandidates(input: string): readonly string[] { return findExternalPathCandidates(input, this.workspaceRoot); }
  public authorizeExternalDirectory(path: string): Promise<ExternalDirectoryGrant> { return this.externalAccess.authorizeDirectory(this.activeSessionId, path); }
  public prepareAuthorizedExternalInput(input: string, paths: readonly string[]): Promise<AgentUserInput> {
    return buildAuthorizedExternalUserInput(input, paths, this.externalAccess, this.activeSessionId);
  }

  public async queueInput(input: AgentUserInput, priority: AgentQueuePriority): Promise<AgentQueuedInput> { const result = await this.agent.queueInput(this.activeSessionId, input, priority); await this.emitSnapshot(this.getSnapshot()); return result; }
  public listQueuedInputs(): Promise<readonly AgentQueuedInput[]> { return this.agent.listQueuedInputs(this.activeSessionId); }
  public async removeQueuedInput(queueId: string): Promise<boolean> { const result = await this.agent.removeQueuedInput(this.activeSessionId, queueId); await this.emitSnapshot(this.getSnapshot()); return result; }
  public runQueuedInput(queueId: string): Promise<{ readonly runId: string }> { return this.agent.runQueuedInput(this.activeSessionId, queueId); }
  public async renameActiveSession(title: string): Promise<AgentSessionSnapshot> { const result = await this.agent.renameSession(this.activeSessionId, title); await this.emitSnapshot(this.getSnapshot()); return result; }
  public async compactActiveSession(instructions = ""): Promise<SessionCompactionResult> { const result = await this.agent.compactSession(this.activeSessionId, instructions); await this.emitSnapshot(this.getSnapshot()); return result; }
  public async exportActiveSession(targetPath?: string): Promise<string> {
    const session = await this.getActiveSession();
    const destination = targetPath ?? join(this.configuration.dataDirectory, "exports", `${session.id}.md`);
    return this.agent.exportSessionMarkdown(session.id, destination);
  }
  public async suggestFiles(query: string, maxResults = 20): Promise<readonly string[]> {
    const files = await this.core.workspaces.get(this.workspaceId).glob("**/*", 2000);
    const needle = query.replace(/^@/, "").toLocaleLowerCase();
    return files.filter(path => path.toLocaleLowerCase().includes(needle)).slice(0, maxResults);
  }
  public async loadInputHistory(): Promise<readonly string[]> {
    const path = join(this.configuration.dataDirectory, "input-history", `${this.workspaceId}.json`);
    try { const parsed = JSON.parse(await readFile(path, "utf8")) as unknown; return Array.isArray(parsed) ? parsed.filter(item => typeof item === "string").slice(0, 500) : []; } catch (error: unknown) { if (isMissingFileError(error)) return []; throw error; }
  }
  public async recordInputHistory(input: string): Promise<void> {
    const history = [input, ...(await this.loadInputHistory()).filter(item => item !== input)].slice(0, 500);
    const directory = join(this.configuration.dataDirectory, "input-history"); await mkdir(directory, { recursive: true });
    const path = join(directory, `${this.workspaceId}.json`); const temporary = `${path}.tmp-${Date.now()}`;
    await writeFile(temporary, `${JSON.stringify(history, null, 2)}\n`, "utf8"); await rename(temporary, path);
  }

  public abortActiveRun(): boolean {
    return this.agent.abortSession(this.activeSessionId);
  }

  public async createSession(permissionMode = this.configuration.permissionMode): Promise<AgentSessionSnapshot> {
    this.externalAccess.revokeSession(this.activeSessionId);
    const created = await this.agent.createSession(this.workspaceId, permissionMode);
    this.activeSessionId = created.id;
    this.core.workbench.activate(created.id);
    await this.emitSnapshot(this.getSnapshot());
    return created;
  }

  public async activateSession(sessionId: string): Promise<AgentSessionSnapshot> {
    const session = await this.agent.getSession(sessionId);
    if (session.workspaceId !== this.workspaceId) {
      throw new Error("不能恢复其他工作区的会话；请先使用 /workspace 切换目录");
    }
    this.externalAccess.revokeSession(this.activeSessionId);
    this.activeSessionId = sessionId;
    this.core.workbench.activate(sessionId);
    await this.emitSnapshot(this.getSnapshot());
    return session;
  }

  public async listSessions(): Promise<readonly AgentSessionSnapshot[]> {
    return this.agent.listSessions(this.workspaceId);
  }
  public async trashSession(sessionId: string): Promise<TrashedSessionRecord> {
    if (sessionId === this.activeSessionId) {
      const active = await this.getActiveSession();
      if (active.status === "running" || active.status === "awaitingPermission") throw new Error("运行期间不能删除会话");
      this.externalAccess.revokeSession(sessionId);
    }
    return this.agent.trashSession(sessionId);
  }
  public listTrash(): Promise<readonly TrashedSessionRecord[]> { return this.agent.listTrashedSessions(); }
  public async restoreTrash(sessionId: string): Promise<AgentSessionSnapshot> {
    const candidate = (await this.agent.listTrashedSessions()).find(item => item.snapshot.id === sessionId);
    if (candidate !== undefined && candidate.snapshot.workspaceId !== this.workspaceId) throw new Error("不能恢复其他工作区的会话");
    const restored = await this.agent.restoreTrashedSession(sessionId);
    return restored;
  }
  public deleteTrash(sessionId: string): Promise<boolean> { return this.agent.deleteTrashedSession(sessionId); }

  public listDiffs(): readonly DiffProposal[] {
    return this.core.diffs.list().filter(proposal => proposal.sessionId === this.activeSessionId || proposal.workspaceId === this.workspaceId);
  }

  public getDiff(proposalId: string): DiffProposal | undefined {
    const proposal = this.core.diffs.get(proposalId);
    return proposal !== undefined && (proposal.workspaceId === this.workspaceId || proposal.sessionId === this.activeSessionId) ? proposal : undefined;
  }

  public resolvePermission(requestId: string, reply: PermissionReply): boolean {
    return this.agent.resolvePermission(requestId, reply);
  }

  public resolveDiff(proposalId: string, decision: "accepted" | "rejected"): Promise<DiffProposal> {
    const proposal = this.getDiff(proposalId);
    if (proposal === undefined) throw new Error(`当前工作区不存在 Diff Proposal：${proposalId}`);
    return decision === "accepted"
      ? this.core.workspace.acceptDiff(proposalId)
      : this.core.workspace.rejectDiff(proposalId);
  }

  public listCheckpoints(): Promise<readonly CheckpointRecord[]> {
    return this.core.checkpoints.list().then(items => items.filter(item => item.sessionId === this.activeSessionId || item.workspaceId === this.workspaceId));
  }

  public async restoreCheckpoint(checkpointId: string, scope: CheckpointRestoreScope = "filesAndConversation"): Promise<CheckpointRecord> {
    const active = await this.getActiveSession();
    if (active.status === "running" || active.status === "awaitingPermission") {
      throw new Error("运行期间不能恢复 Checkpoint");
    }
    const checkpoint = await this.core.checkpoints.get(checkpointId);
    if (checkpoint === undefined) throw new Error(`Checkpoint 不存在：${checkpointId}`);
    if (checkpoint.workspaceId !== this.workspaceId) {
      throw new Error("不能恢复其他工作区的 Checkpoint");
    }
    if (scope === "filesOnly") return this.core.workspace.restoreCheckpoint(checkpointId);
    if (checkpoint.sessionSnapshot === undefined) throw new Error("Checkpoint 缺少会话快照，不能恢复对话");
    const branch = await this.agent.createBranchFromSession(checkpoint.sessionSnapshot, checkpoint.id);
    try {
      const restored = scope === "conversationOnly" ? checkpoint : await this.core.workspace.restoreCheckpoint(checkpointId);
      await this.core.checkpoints.recordConversationBranch(checkpoint.id, branch.id);
      this.activeSessionId = branch.id;
      this.core.workbench.activate(branch.id);
      await this.emitSnapshot(this.getSnapshot());
      return restored;
    } catch (error: unknown) {
      await this.agent.trashSession(branch.id).catch(() => undefined);
      throw error;
    }
  }

  public async retryActiveSession(): Promise<{ readonly sessionId: string; readonly runId: string }> {
    const active = await this.getActiveSession();
    if (active.status === "running" || active.status === "awaitingPermission") {
      throw new Error("运行期间不能重试会话");
    }
    const retried = await this.agent.retrySession(active.id);
    this.activeSessionId = retried.sessionId;
    this.core.workbench.activate(retried.sessionId);
    await this.emitSnapshot(this.getSnapshot());
    const runPromise = this.agent.waitForRun(retried.runId);
    let trackedRun: Promise<AgentSessionSnapshot>;
    trackedRun = runPromise.finally(() => {
      if (this.activeRunPromise === trackedRun) this.activeRunPromise = undefined;
    });
    this.activeRunPromise = trackedRun;
    void this.activeRunPromise.catch(() => undefined);
    return retried;
  }

  public async getToolResult(toolCallId: string): Promise<TuiToolResultDetail | undefined> {
    const session = await this.getActiveSession();
    const message = session.messages.find(item => item.role === "tool" && item.toolCallId === toolCallId);
    if (message === undefined || message.role !== "tool") return undefined;
    const detail: TuiToolResultDetail = {
      toolCallId,
      toolName: message.toolName,
      content: message.content,
      isError: message.isError,
    };
    if (message.toolName !== "bash") return detail;
    try {
      const value = JSON.parse(message.content) as unknown;
      if (!isRecord(value)
        || typeof value.stdout !== "string"
        || typeof value.stderr !== "string"
        || !Number.isInteger(value.exitCode)
        || typeof value.timedOut !== "boolean"
        || typeof value.interrupted !== "boolean"
        || typeof value.auditLogPath !== "string"
        || !Number.isInteger(value.durationMs)) {
        return detail;
      }
      return {
        ...detail,
        powerShell: {
          stdout: value.stdout,
          stderr: value.stderr,
          exitCode: Number(value.exitCode),
          timedOut: value.timedOut,
          interrupted: value.interrupted,
          auditLogPath: value.auditLogPath,
          durationMs: Number(value.durationMs),
        },
      };
    } catch {
      return detail;
    }
  }

  public async getHealthReport(): Promise<TuiHealthReport> {
    const draft: TuiSetupDraft = {
      configPath: this.configuration.configPath,
      baseUrl: this.configuration.model.baseUrl,
      chatCompletionsPath: this.configuration.model.chatCompletionsPath,
      model: this.configuration.model.model,
      apiKey: this.configuration.model.apiKey,
      contextWindowTokens: String(this.configuration.model.contextWindowTokens),
      sandboxBrokerExecutablePath: this.configuration.sandboxBrokerExecutablePath,
      permissionMode: this.configuration.permissionMode,
      networkMode: this.configuration.networkMode,
    };
    const report = await checkTuiHealth(draft);
    const dataStatus = await lstat(this.configuration.dataDirectory).catch(() => undefined);
    return {
      ...report,
      configuration: {
        configPath: this.configuration.configPath,
        dataDirectory: this.configuration.dataDirectory,
        apiKeyConfigured: this.configuration.model.apiKey.trim() !== "",
        brokerPath: this.configuration.sandboxBrokerExecutablePath,
        model: this.configuration.model.model,
        contextWindowTokens: this.configuration.model.contextWindowTokens,
      },
      workspace: {
        id: this.workspaceId,
        root: this.workspaceRoot,
        ok: true,
      },
      messages: [
        ...report.messages,
        `工作区：${this.workspaceRoot}`,
        `数据目录：${this.configuration.dataDirectory}（${dataStatus?.isDirectory() === true ? "存在" : "首次使用时创建"}）`,
      ],
    };
  }

  public async getContextReport(): Promise<TuiContextReport> {
    const session = await this.getActiveSession(); const recent = session.usage.contextTokens ?? session.usage.lastInputTokens ?? 0; const window = this.configuration.model.contextWindowTokens;
    return { contextWindowTokens: window, recentInputTokens: recent, usedPercent: Math.min(100, Math.round((recent / window) * 100)), remainingTokens: Math.max(0, window - recent) };
  }

  public listTools(): readonly ToolManifest[] {
    return this.core.tools.listManifests(manifest => manifest.visibility !== "subagent");
  }

  public getSession(sessionId: string): Promise<AgentSessionSnapshot> {
    return this.agent.getSession(sessionId);
  }

  public async listTranscriptEntries(): Promise<readonly TuiTranscriptEntry[]> {
    const session = await this.getActiveSession();
    const journal = await this.agent.listEvents(this.activeSessionId);
    return buildTuiTranscriptEntries(session, journal);
  }

  public listPlans(): readonly PlanRecord[] { return this.core.plans.list(this.activeSessionId); }
  public resolvePlan(planId: string, decision: "approved" | "rejected"): Promise<PlanRecord> { return this.core.orchestration.planReviews.resolve(planId, decision); }
  public async completePlan(planId: string): Promise<PlanRecord> {
    const plan = this.core.plans.get(planId); if (plan === undefined) throw new Error(`Plan 不存在：${planId}`);
    if (this.core.orchestration.scheduler.list(plan.sessionId).some(task => task.planId === planId && (task.status === "queued" || task.status === "running" || task.status === "gating" || task.status === "patchProposed"))) throw new Error("仍有活动子 Agent 或待审 Patch");
    return this.core.plans.markCompleted(planId);
  }
  public async cancelPlan(planId: string): Promise<PlanRecord> {
    const plan = this.core.plans.get(planId); if (plan === undefined) throw new Error(`Plan 不存在：${planId}`);
    for (const task of this.core.orchestration.scheduler.list(plan.sessionId)) if (task.planId === planId && (task.status === "queued" || task.status === "running" || task.status === "gating")) await this.core.orchestration.scheduler.abort(task.id).catch(() => undefined);
    return this.core.plans.cancel(planId);
  }
  public listTasks(): readonly SubagentTaskRecord[] { return this.core.orchestration.scheduler.list(this.activeSessionId); }
  public startTask(taskId: string): Promise<SubagentTaskRecord> { void this.core.orchestration.scheduler.start(taskId); return this.core.orchestration.scheduler.waitStable(taskId); }
  public waitTask(taskId: string): Promise<SubagentTaskRecord> { return this.core.orchestration.scheduler.waitStable(taskId); }
  public abortTask(taskId: string): Promise<boolean> { return this.core.orchestration.scheduler.abort(taskId); }
  public async createPlan(instruction: string): Promise<PlanRecord> {
    const plan = await this.core.plans.create({ sessionId: this.activeSessionId, title: instruction.slice(0, 80), summary: instruction, confidence: 80, affectedFiles: ["."], steps: [{ title: "执行用户计划", description: instruction, affectedFiles: ["."], capabilities: ["workspace.read"] }] });
    return plan;
  }
  public async dispatchTask(instruction: string, role: "planner" | "explorer" = "explorer"): Promise<SubagentTaskRecord> {
    const task = await this.core.orchestration.scheduler.dispatch({ parentSessionId: this.activeSessionId, role, instruction, depth: 1, baseWorkspaceId: this.workspaceId, allowedPaths: ["."], writablePaths: [], allowedCapabilities: ["workspace.read"], budget: { maxTurns: 12, maxToolCalls: 24, maxTotalTokens: 40_000, maxDurationMs: 10 * 60_000 }, reviewPolicy: "none" });
    void this.core.orchestration.scheduler.start(task.id);
    return task;
  }
  public createStructuredPlan(input: Omit<CreatePlanInput, "sessionId">): Promise<PlanRecord> {
    return this.core.plans.create({ ...input, sessionId: this.activeSessionId });
  }
  public async dispatchStructuredTask(input: Omit<SubagentTaskRequest, "parentSessionId" | "baseWorkspaceId">): Promise<SubagentTaskRecord> {
    const task = await this.core.orchestration.scheduler.dispatch({ ...input, parentSessionId: this.activeSessionId, baseWorkspaceId: this.workspaceId });
    if (task.role !== "implementer") void this.core.orchestration.scheduler.start(task.id);
    return task;
  }
  public listArtifacts(): Promise<readonly SubagentCommit[]> { return this.core.orchestration.commits.list(); }
  public async deleteArtifact(commitId: string): Promise<boolean> {
    const commit = await this.core.orchestration.commits.get(commitId); if (commit === undefined) return false;
    const plan = commit.planId === undefined ? undefined : this.core.plans.get(commit.planId);
    if (plan !== undefined && !["completed", "cancelled", "failed", "rejected"].includes(plan.status)) throw new Error("活动 Plan 的 Commit 不能清理");
    if (this.core.orchestration.scheduler.list().some(task => task.outputCommitId === commitId || task.sourceCommitId === commitId)) throw new Error("仍有任务引用该 Commit");
    return this.core.orchestration.commits.delete(commitId);
  }
  public async retryGateAttempt(taskId: string): Promise<SubagentTaskRecord> { if (!this.core.orchestration.scheduler.retryGateAttempt) throw new Error("当前 Runtime 不支持门禁重试"); return this.core.orchestration.scheduler.retryGateAttempt(taskId); }

  public async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.externalAccess.revokeSession(this.activeSessionId);
    let failure: unknown;
    await this.core.orchestration.dispose(this.activeSessionId).catch(error => { failure ??= error; });
    this.listeners.clear();
    try {
      this.agent.abortSession(this.activeSessionId);
    } catch (error: unknown) {
      failure ??= error;
    }
    try {
      this.core.diffReviews.rejectSession(this.activeSessionId);
    } catch (error: unknown) {
      failure ??= error;
    }
    try {
      await this.activeRunPromise;
    } catch {
      // 取消运行产生的失败属于预期清理结果，不覆盖真正的释放错误。
    }
    for (const release of [
      () => this.connector.dispose(),
      () => this.workbenchSubscription.dispose(),
      () => this.sandboxBroker.dispose(),
    ]) {
      try {
        release();
      } catch (error: unknown) {
        failure ??= error;
      }
    }
    if (failure !== undefined) throw failure;
  }

  private async emitSnapshot(snapshot: WorkbenchSnapshot): Promise<void> {
    if (this.disposed) return;
    for (const listener of this.listeners) {
      await listener(structuredClone(snapshot));
    }
  }
}

async function selectInitialSession(
  agent: AgentRuntime,
  workspaceId: string,
  permissionMode: TuiConfiguration["permissionMode"],
): Promise<string> {
  const sessions = await agent.listSessions(workspaceId);
  const current = sessions[0];
  if (current !== undefined) return current.id;
  return (await agent.createSession(workspaceId, permissionMode)).id;
}

async function loadProjectRules(workspaceRoot: string): Promise<string | undefined> {
  const sections: string[] = [];
  for (const name of ["AGENTS.md", "PROJECT_RULES.md"] as const) {
    try {
      const text = await readFile(join(workspaceRoot, name), "utf8");
      if (text.trim() !== "") sections.push(`## ${name}\n${text.trim()}`);
    } catch (error: unknown) {
      if (!isMissingFileError(error)) throw error;
    }
  }
  return sections.length === 0 ? undefined : sections.join("\n\n");
}

function createWorkspaceId(root: string): string {
  const normalized = root.replace(/\\/g, "/").toLocaleLowerCase();
  return `workspace-${createHash("sha256").update(normalized, "utf8").digest("hex").slice(0, 24)}`;
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && (error as { readonly code?: unknown }).code === "ENOENT";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
