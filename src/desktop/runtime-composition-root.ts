import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { IdGenerator } from "../agent/id-generator.js";
import { JsonlEventJournal } from "../agent/event-journal.js";
import { PermissionCoordinator } from "../agent/permission-coordinator.js";
import { CheckpointManager, JsonCheckpointStore } from "../checkpoint/checkpoint-manager.js";
import { BrowserEgressProxyServer } from "../browser/egress-proxy-server.js";
import { BrowserRuntime } from "../browser/browser-runtime.js";
import { createBrowserTools } from "../browser/browser-tools.js";
import { PlaywrightBrowserDriver } from "../browser/playwright-driver.js";
import { HttpBrowserProxyVerifier } from "../browser/proxy-verifier.js";
import { JsonlComputerUseAuditStore } from "../computer-use/jsonl-audit-store.js";
import { ChildProcessComputerUseBrokerTransport } from "../computer-use/broker-transport.js";
import { WindowsUiAutomationBrokerClient } from "../computer-use/broker-client.js";
import { ComputerUseRuntime } from "../computer-use/runtime.js";
import { createComputerUseTools } from "../computer-use/computer-tools.js";
import { loadCertifiedApplicationManifests } from "../computer-use/manifest-loader.js";
import { DiffManager } from "../diff/diff-manager.js";
import type { DiffReviewCoordinator } from "../diff/diff-review-coordinator.js";
import { JsonDiffProposalStore } from "../diff/diff-store.js";
import { EgressBroker } from "../egress/broker.js";
import { JsonlEgressAuditStore } from "../egress/jsonl-audit-store.js";
import { NodePinnedHttpTransport } from "../egress/node-http-transport.js";
import { NodeDnsResolver } from "../egress/resolver.js";
import { OpenAICompatibleProvider } from "../model/openai-compatible-provider.js";
import type { ModelProvider, ModelRequest, ModelStreamEvent } from "../model/types.js";
import { PlanManager } from "../plan/plan-manager.js";
import { createPowerShellTerminalTools } from "../powershell/powershell-terminal-tools.js";
import { createPowerShellTool } from "../powershell/powershell-tool.js";
import { AgentRuntime } from "../runtime/agent-runtime.js";
import { createAgentCoreComposition } from "../runtime/agent-core-composition.js";
import { WorkbenchEventConnector } from "../runtime/workbench-event-connector.js";
import { WorkbenchRuntime } from "../runtime/workbench-runtime.js";
import { WorkspaceRuntime } from "../runtime/workspace-runtime.js";
import { JsonSessionStore } from "../storage/session-store.js";
import { ToolRegistry } from "../tool-runtime.js";
import { createWebTools } from "../web/web-tools.js";
import { FileSystemDownloadArtifactStore } from "../web/download-store.js";
import { SearxngJsonSearchProvider } from "../web/searxng-provider.js";
import { WebDownloadService } from "../web/web-download-service.js";
import { WebFetchService, WebSearchService } from "../web/web-services.js";
import { buildSystemPrompt } from "../prompt/system-prompt-builder.js";
import { ChildProcessSandboxBrokerTransport } from "../sandbox/broker-transport.js";
import { WindowsSandboxBrokerClient } from "../sandbox/broker-client.js";
import { WorkspaceRegistry } from "../workspace/workspace-service.js";
import type { RuntimeConfiguration } from "./runtime-configuration.js";

export class RuntimeCompositionRoot {
  public readonly ids: IdGenerator;
  public readonly journal: JsonlEventJournal;
  public readonly workspaces: WorkspaceRegistry;
  public readonly sessions: JsonSessionStore;
  public readonly checkpoints: CheckpointManager;
  public readonly diffs: DiffManager;
  public readonly diffReviews: DiffReviewCoordinator;
  public readonly tools: ToolRegistry;
  public readonly permissions: PermissionCoordinator;
  public readonly sandboxBroker: WindowsSandboxBrokerClient;
  public readonly workspace: WorkspaceRuntime;
  public readonly plans: PlanManager;
  public readonly workbench: WorkbenchRuntime;
  public readonly egress: EgressBroker;
  public readonly download: WebDownloadService;
  public readonly fetch: WebFetchService;
  public search: WebSearchService | undefined;
  public browserProxy: BrowserEgressProxyServer | undefined;
  public browser: BrowserRuntime | undefined;
  public computerBroker: WindowsUiAutomationBrokerClient | undefined;
  public computer: ComputerUseRuntime | undefined;
  public agent?: AgentRuntime;
  public connector?: WorkbenchEventConnector;

  private initialized = false;
  private browserDriver?: PlaywrightBrowserDriver;
  private computerTransport?: ChildProcessComputerUseBrokerTransport;

  public constructor(public readonly configuration: RuntimeConfiguration) {
    const core = createAgentCoreComposition(configuration.dataDirectory);
    this.ids = core.ids;
    this.journal = core.journal;
    this.workspaces = core.workspaces;
    this.sessions = core.sessions;
    this.checkpoints = core.checkpoints;
    this.diffs = core.diffs;
    this.diffReviews = core.diffReviews;
    this.tools = core.tools;
    this.permissions = core.permissions;
    this.workspace = core.workspace;
    this.plans = core.plans;
    this.workbench = core.workbench;
    this.sandboxBroker = new WindowsSandboxBrokerClient(
      new ChildProcessSandboxBrokerTransport(configuration.sandboxBrokerExecutablePath),
    );
    this.egress = new EgressBroker(
      new NodeDnsResolver(),
      new NodePinnedHttpTransport(),
      new JsonlEgressAuditStore(join(configuration.dataDirectory, "audit", "egress.jsonl")),
      this.ids,
    );
    this.fetch = new WebFetchService(this.egress);
    this.download = new WebDownloadService(
      this.egress,
      new FileSystemDownloadArtifactStore(join(configuration.dataDirectory, "artifacts", "downloads"), this.ids),
    );
  }

  public async initialize(): Promise<void> {
    if (this.initialized) return;
    await this.sandboxBroker.initialize();
    this.registerCoreTools();
    this.registerWebTools();
    await this.initializeBrowser();
    await this.initializeComputerUse();
    this.agent = new AgentRuntime({
      provider: this.createProvider(),
      tools: this.tools,
      permissions: this.permissions,
      journal: this.journal,
      sessions: this.sessions,
      idGenerator: this.ids,
    }, {
      systemPrompt: buildSystemPrompt({
        networkMode: this.configuration.network.mode,
        toolManifests: this.tools.listManifests(),
        browserEnabled: this.browser !== undefined,
        computerUseEnabled: this.computer !== undefined,
      }),
      maxOutputTokensPerTurn: 8_192,
      limits: { maxTurns: 24, maxToolCalls: 48, maxTotalTokens: 120_000 },
    });
    const agent = this.agent;
    if (agent === undefined) throw new Error("Agent Runtime 组合根初始化失败");
    this.connector = new WorkbenchEventConnector(agent, this.workspace, this.plans, this.workbench);
    this.connector.start();
    this.initialized = true;
  }

  public async dispose(): Promise<void> {
    this.connector?.dispose();
    if (this.browser !== undefined) {
      for (const session of this.browser.list()) await this.browser.close(session.id).catch(() => undefined);
    }
    await this.browserProxy?.stop();
    this.computerBroker?.dispose();
    this.computerTransport?.dispose();
    this.sandboxBroker.dispose();
    this.initialized = false;
  }

  private registerCoreTools(): void {
    for (const tool of createPowerShellTerminalTools({
      broker: this.sandboxBroker,
      workspaces: this.workspaces,
      getNetworkMode: () => this.configuration.network.mode,
    })) this.tools.register(tool);
    this.tools.register(createPowerShellTool({
      broker: this.sandboxBroker,
      workspaces: this.workspaces,
      getNetworkMode: () => this.configuration.network.mode,
    }));
  }

  private registerWebTools(): void {
    if (!this.configuration.network.webFetchEnabled && !this.configuration.network.webSearchEnabled) return;
    if (this.configuration.network.webSearchEnabled) {
      if (this.configuration.network.searxngEndpoint === undefined) throw new Error("WebSearch 已启用但缺少 SearXNG endpoint");
      this.search = new WebSearchService(this.egress, new SearxngJsonSearchProvider({
        endpoint: this.configuration.network.searxngEndpoint,
        language: "zh-CN",
        categories: ["general"],
      }));
    }
    const dependencies = this.search === undefined
      ? { fetch: this.fetch, getNetworkMode: () => this.configuration.network.mode }
      : { fetch: this.fetch, search: this.search, getNetworkMode: () => this.configuration.network.mode };
    for (const tool of createWebTools(dependencies)) {
      if (tool.manifest.name === "WebFetch" && !this.configuration.network.webFetchEnabled) continue;
      this.tools.register(tool);
    }
  }

  private async initializeBrowser(): Promise<void> {
    if (!this.configuration.browser.enabled) return;
    const executablePath = this.configuration.browser.chromiumExecutablePath!;
    const proxy = new BrowserEgressProxyServer(this.egress, this.ids, { getNetworkMode: () => this.configuration.network.mode });
    const proxyUrl = await proxy.start();
    this.browserProxy = proxy;
    this.browserDriver = new PlaywrightBrowserDriver({ executablePath, expectedSha256: await sha256File(executablePath) });
    this.browser = new BrowserRuntime(this.browserDriver, this.egress, this.ids, {
      proxyServerUrl: proxyUrl,
      maxSessions: this.configuration.browser.maxSessions,
      viewport: { width: 1440, height: 900 },
      proxyVerifier: new HttpBrowserProxyVerifier(),
    }, this.download);
    for (const tool of createBrowserTools({ runtime: this.browser, broker: this.egress, download: this.download, getNetworkMode: () => this.configuration.network.mode })) this.tools.register(tool);
  }

  private async initializeComputerUse(): Promise<void> {
    if (!this.configuration.computerUse.enabled) return;
    const manifestPath = this.configuration.computerUse.certificationManifestPath!;
    const manifests = await loadCertifiedApplicationManifests(manifestPath);
    this.computerTransport = new ChildProcessComputerUseBrokerTransport(this.configuration.computerUse.brokerExecutablePath!);
    this.computerBroker = new WindowsUiAutomationBrokerClient(this.computerTransport);
    this.computer = new ComputerUseRuntime(
      this.computerBroker,
      manifests,
      new JsonlComputerUseAuditStore(join(this.configuration.dataDirectory, "audit", "computer-use.jsonl")),
      this.ids,
    );
    await this.computer.initialize();
    for (const tool of createComputerUseTools(this.computer)) this.tools.register(tool);
  }

  private createProvider(): ModelProvider {
    return {
      id: "desktop-openai-compatible",
      stream: (request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelStreamEvent> => {
        const model = this.configuration.model;
        const baseUrl = requireModel(model.baseUrl, "baseUrl");
        const chatCompletionsPath = requireModel(model.chatCompletionsPath, "chatCompletionsPath");
        const name = requireModel(model.model, "name");
        const variable = requireModel(model.apiKeyEnvironmentVariable, "apiKeyEnvironmentVariable");
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(variable)) throw new Error("模型 API Key 环境变量名无效");
        const provider = new OpenAICompatibleProvider({ baseUrl, chatCompletionsPath, model: name, apiKeyReference: `env:${variable}` }, {
          credentialResolver: { resolve: async reference => reference === `env:${variable}` ? requireEnvironment(variable) : Promise.reject(new Error("不支持的模型凭据引用")) },
        });
        return provider.stream(request, signal);
      },
    };
  }
}

function requireModel(value: string | undefined, name: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`模型设置 independentAiIde.model.${name} 未配置`);
  return value;
}

function requireEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") throw new Error(`未设置模型 API Key 环境变量：${name}`);
  return value;
}

async function sha256File(path: string): Promise<string> {
  const { createHash } = await import("node:crypto");
  const { readFile } = await import("node:fs/promises");
  return createHash("sha256").update(await readFile(path)).digest("hex");
}
