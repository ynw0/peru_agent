import type { BrowserDomSnapshot, BrowserSessionRecord } from "../browser/types.js";
import type {
  ComputerScreenshot,
  ComputerUiSnapshot,
  ComputerWindowRecord,
  PreparedComputerAction,
} from "../computer-use/types.js";
import type { WorkbenchSnapshot } from "../workbench/workbench-state.js";
import type { RuntimeConfiguration } from "./runtime-configuration.js";
import { createRuntimeConfiguration } from "./runtime-configuration.js";
import { RuntimeCompositionRoot } from "./runtime-composition-root.js";

export interface DesktopModelConfiguration {
  readonly baseUrl?: string;
  readonly chatCompletionsPath?: string;
  readonly model?: string;
  readonly apiKeyEnvironmentVariable?: string;
}

export interface DesktopAgentRuntimeHostOptions {
  readonly dataDirectory: string;
  readonly model?: DesktopModelConfiguration;
  readonly sandboxBrokerExecutablePath: string;
  readonly configuration?: RuntimeConfiguration;
}

export interface DesktopComputerWindowView {
  readonly processId: number;
  readonly windowHandle: string;
  readonly windowTitle: string;
  readonly executableName: string;
  readonly version: string;
  readonly windowClass: string;
  readonly integrityLevel: ComputerWindowRecord["identity"]["integrityLevel"];
  readonly secureDesktop: boolean;
  readonly certification: {
    readonly status: ComputerWindowRecord["certification"]["status"];
    readonly applicationId?: string;
    readonly displayName?: string;
    readonly reasons: readonly string[];
  };
}

export interface DesktopComputerSnapshotView {
  readonly id: string;
  readonly windowHandle: string;
  readonly windowTitle: string;
  readonly certification: DesktopComputerWindowView["certification"];
  readonly elements: readonly {
    readonly id: string;
    readonly role: string;
    readonly name: string;
    readonly automationId: string;
    readonly enabled: boolean;
    readonly offscreen: boolean;
    readonly isPassword: boolean;
    readonly patterns: readonly string[];
  }[];
}

export interface DesktopWorkbenchSnapshot extends WorkbenchSnapshot {
  readonly browserSessions: readonly BrowserSessionRecord[];
  readonly browserSnapshot?: BrowserDomSnapshot;
  readonly computerWindows: readonly DesktopComputerWindowView[];
  readonly computerSnapshot?: DesktopComputerSnapshotView;
  readonly computerPreparedActions: readonly PreparedComputerAction[];
}

export interface DesktopAgentRuntimeHostListener {
  (snapshot: DesktopWorkbenchSnapshot): void | Promise<void>;
}

// DesktopAgentRuntimeHost 是桌面进程唯一的 Agent 组装点。所有能力都从同一个
// RuntimeCompositionRoot 注册，主进程只通过 NDJSON 调用这里的明确命令。
export class DesktopAgentRuntimeHost {
  private readonly root: RuntimeCompositionRoot;
  private readonly listeners = new Set<DesktopAgentRuntimeHostListener>();
  private readonly workspaceRoots = new Map<string, string>();
  private readonly activeSessions = new Map<string, string>();
  private browserSnapshot: BrowserDomSnapshot | undefined;
  private computerSnapshot: DesktopComputerSnapshotView | undefined;
  private computerWindows: readonly DesktopComputerWindowView[] = [];
  private initialized = false;

  public constructor(private readonly options: DesktopAgentRuntimeHostOptions) {
    const configuration = options.configuration ?? createRuntimeConfiguration({
      dataDirectory: options.dataDirectory,
      sandboxBrokerExecutablePath: options.sandboxBrokerExecutablePath,
      ...(options.model === undefined ? {} : { model: options.model }),
    });
    this.root = new RuntimeCompositionRoot(configuration);
    this.root.workbench.onSnapshot(snapshot => this.emitSnapshot(snapshot));
  }

  public async initialize(): Promise<DesktopWorkbenchSnapshot> {
    if (this.initialized) return this.getSnapshot();
    await this.root.initialize();
    const agent = this.requireAgent();
    const restored = await agent.restoreAll();
    await this.root.diffs.restoreAll();
    this.root.plans.restoreFromEvents((await this.root.journal.list()).map(entry => entry.event));
    for (const session of restored) {
      this.activeSessions.set(session.workspaceId, session.id);
    }
    this.initialized = true;
    const snapshot = await this.root.workbench.restore();
    await this.emitSnapshot(snapshot);
    return this.getSnapshot();
  }

  public onSnapshot(listener: DesktopAgentRuntimeHostListener): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  public getSnapshot(): DesktopWorkbenchSnapshot {
    return this.composeSnapshot(this.root.workbench.getSnapshot());
  }

  public async sendInput(workspaceId: string, rootPath: string, input: string): Promise<void> {
    await this.ensureInitialized();
    await this.ensureWorkspace(workspaceId, rootPath);
    const agent = this.requireAgent();
    let sessionId = this.activeSessions.get(workspaceId);
    if (sessionId === undefined) {
      const created = await agent.createSession(workspaceId, "default");
      sessionId = created.id;
      this.activeSessions.set(workspaceId, sessionId);
    }
    await agent.startSession(sessionId, input);
  }

  public async stop(): Promise<void> {
    await this.ensureInitialized();
    const sessionId = this.root.workbench.getSnapshot().activeSessionId;
    if (sessionId !== undefined) this.requireAgent().abortSession(sessionId);
  }

  public async retry(): Promise<void> {
    await this.ensureInitialized();
    const sessionId = this.requireActiveSession();
    const retried = await this.requireAgent().retrySession(sessionId);
    const snapshot = await this.requireAgent().getSession(retried.sessionId);
    this.activeSessions.set(snapshot.workspaceId, retried.sessionId);
  }

  public resolvePermission(requestId: string, decision: "allow" | "deny"): boolean {
    return this.requireAgent().resolvePermission(requestId, decision);
  }

  public resolvePlan(planId: string, decision: "approved" | "rejected"): Promise<void> {
    return this.root.plans.resolve(planId, decision).then(() => undefined);
  }

  public acceptDiff(proposalId: string): Promise<void> {
    return this.root.workspace.acceptDiff(proposalId).then(() => undefined);
  }

  public rejectDiff(proposalId: string): Promise<void> {
    return this.root.workspace.rejectDiff(proposalId).then(() => undefined);
  }

  public restoreCheckpoint(checkpointId: string): Promise<void> {
    return this.root.workspace.restoreCheckpoint(checkpointId).then(() => undefined);
  }

  public async createBrowser(workspaceId: string, networkMode: "offline" | "lan" | "internet", locale: "zh-CN" | "en-US"): Promise<BrowserSessionRecord> {
    await this.ensureInitialized();
    if (this.root.browser === undefined) throw new Error("Browser Runtime 未启用");
    const session = await this.root.browser.create({ workspaceId, networkMode, locale }, new AbortController().signal);
    await this.emitSnapshot(this.root.workbench.getSnapshot());
    return session;
  }

  public async navigateBrowser(sessionId: string, url: string): Promise<BrowserDomSnapshot> {
    await this.ensureInitialized();
    const browser = this.requireBrowser();
    const snapshot = await browser.navigate(sessionId, url, new AbortController().signal);
    this.browserSnapshot = snapshot;
    await this.emitSnapshot(this.root.workbench.getSnapshot());
    return snapshot;
  }

  public async refreshBrowserSnapshot(sessionId: string): Promise<BrowserDomSnapshot> {
    await this.ensureInitialized();
    const snapshot = await this.requireBrowser().snapshot(sessionId, new AbortController().signal);
    this.browserSnapshot = snapshot;
    await this.emitSnapshot(this.root.workbench.getSnapshot());
    return snapshot;
  }

  public async downloadBrowser(sessionId: string, url: string, maxBytes = 20 * 1024 * 1024): Promise<unknown> {
    await this.ensureInitialized();
    const artifact = await this.requireBrowser().download(sessionId, url, maxBytes, new AbortController().signal);
    await this.emitSnapshot(this.root.workbench.getSnapshot());
    return artifact;
  }

  public async clickBrowser(sessionId: string, snapshotId: string, elementId: string): Promise<unknown> {
    await this.ensureInitialized();
    const result = await this.requireBrowser().click(sessionId, { snapshotId, elementId }, new AbortController().signal);
    this.browserSnapshot = result.afterSnapshot;
    await this.emitSnapshot(this.root.workbench.getSnapshot());
    return result;
  }

  public async typeBrowser(sessionId: string, snapshotId: string, elementId: string, text: string): Promise<unknown> {
    await this.ensureInitialized();
    const result = await this.requireBrowser().type(sessionId, { snapshotId, elementId }, text, new AbortController().signal);
    this.browserSnapshot = result.afterSnapshot;
    await this.emitSnapshot(this.root.workbench.getSnapshot());
    return result;
  }

  public async closeBrowser(sessionId: string): Promise<BrowserSessionRecord> {
    await this.ensureInitialized();
    const session = await this.requireBrowser().close(sessionId);
    if (this.browserSnapshot?.sessionId === sessionId) this.browserSnapshot = undefined;
    await this.emitSnapshot(this.root.workbench.getSnapshot());
    return session;
  }

  public async refreshComputerWindows(): Promise<readonly DesktopComputerWindowView[]> {
    await this.ensureInitialized();
    const computer = this.requireComputer();
    this.computerWindows = (await computer.listWindows()).map(toComputerWindowView);
    await this.emitSnapshot(this.root.workbench.getSnapshot());
    return this.computerWindows;
  }

  public async inspectComputerWindow(windowHandle: string): Promise<DesktopComputerSnapshotView> {
    await this.ensureInitialized();
    const snapshot = await this.requireComputer().inspect(windowHandle);
    this.computerSnapshot = toComputerSnapshotView(snapshot);
    await this.emitSnapshot(this.root.workbench.getSnapshot());
    return this.computerSnapshot;
  }

  public async screenshotComputerWindow(snapshotId: string): Promise<ComputerScreenshot> {
    await this.ensureInitialized();
    return this.requireComputer().screenshot(snapshotId);
  }

  public async dispose(): Promise<void> {
    await this.root.dispose();
    this.initialized = false;
  }

  private requireAgent() {
    if (this.root.agent === undefined) throw new Error("Agent Runtime 尚未初始化");
    return this.root.agent;
  }

  private requireBrowser() {
    if (this.root.browser === undefined) throw new Error("Browser Runtime 未启用");
    return this.root.browser;
  }

  private requireComputer() {
    if (this.root.computer === undefined) throw new Error("Computer Use Runtime 未启用");
    return this.root.computer;
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) await this.initialize();
  }

  private async ensureWorkspace(workspaceId: string, rootPath: string): Promise<void> {
    const knownRoot = this.workspaceRoots.get(workspaceId);
    if (knownRoot !== undefined) {
      if (knownRoot !== rootPath) throw new Error("同一工作区 ID 的根目录不能在运行时变更");
      return;
    }
    await this.root.workspace.registerWorkspace(workspaceId, rootPath);
    this.workspaceRoots.set(workspaceId, rootPath);
  }

  private requireActiveSession(): string {
    const sessionId = this.root.workbench.getSnapshot().activeSessionId;
    if (sessionId === undefined) throw new Error("当前没有可重试的 Agent 会话");
    return sessionId;
  }

  private composeSnapshot(snapshot: WorkbenchSnapshot): DesktopWorkbenchSnapshot {
    const result: DesktopWorkbenchSnapshot = {
      ...snapshot,
      browserSessions: this.root.browser?.list() ?? [],
      computerWindows: this.computerWindows,
      computerPreparedActions: this.root.computer?.listPreparedActions() ?? [],
      ...(this.browserSnapshot === undefined ? {} : { browserSnapshot: this.browserSnapshot }),
      ...(this.computerSnapshot === undefined ? {} : { computerSnapshot: this.computerSnapshot }),
    };
    return structuredClone(result);
  }

  private async emitSnapshot(snapshot: WorkbenchSnapshot): Promise<void> {
    const composed = this.composeSnapshot(snapshot);
    for (const listener of this.listeners) await listener(composed);
  }
}

function toComputerWindowView(window: ComputerWindowRecord): DesktopComputerWindowView {
  const identity = window.identity;
  const certification = window.certification;
  return {
    processId: identity.processId,
    windowHandle: identity.windowHandle,
    windowTitle: identity.windowTitle,
    executableName: identity.executableName,
    version: identity.version,
    windowClass: identity.windowClass,
    integrityLevel: identity.integrityLevel,
    secureDesktop: identity.secureDesktop,
    certification: {
      status: certification.status,
      ...(certification.applicationId === undefined ? {} : { applicationId: certification.applicationId }),
      ...(certification.displayName === undefined ? {} : { displayName: certification.displayName }),
      reasons: certification.reasons,
    },
  };
}

function toComputerSnapshotView(snapshot: ComputerUiSnapshot): DesktopComputerSnapshotView {
  return {
    id: snapshot.id,
    windowHandle: snapshot.identity.windowHandle,
    windowTitle: snapshot.identity.windowTitle,
    certification: toComputerWindowView({ identity: snapshot.identity, certification: snapshot.certification }).certification,
    elements: snapshot.elements.map(element => ({
      id: element.id,
      role: element.role,
      name: element.name,
      automationId: element.automationId,
      enabled: element.enabled,
      offscreen: element.offscreen,
      isPassword: element.isPassword,
      patterns: element.patterns,
    })),
  };
}
