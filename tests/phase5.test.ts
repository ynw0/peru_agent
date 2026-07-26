import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import { IncrementingIdGenerator } from "../src/agent/id-generator.js";
import { PermissionCoordinator } from "../src/agent/permission-coordinator.js";
import { AgentSession } from "../src/agent/session.js";
import { createPowerShellTool } from "../src/powershell/powershell-tool.js";
import { WindowsSandboxBrokerClient, sha256Text } from "../src/sandbox/broker-client.js";
import type { SandboxBrokerTransport } from "../src/sandbox/broker-transport.js";
import { SandboxRuntime } from "../src/sandbox/sandbox-runtime.js";
import type {
  BrokerMethod,
  BrokerRequestMap,
  ExecutePowerShellRequest,
  WindowsSandboxFeatures,
} from "../src/sandbox/broker-protocol.js";
import { WorkspaceRegistry, WorkspaceService } from "../src/workspace/workspace-service.js";

const FULL_FEATURES: WindowsSandboxFeatures = {
  powerShellAst: true,
  restrictedToken: true,
  appContainer: true,
  jobObject: true,
  filesystemAcl: true,
  networkIsolation: true,
  processTreeTermination: true,
  utf8Protocol: true,
};

class ScriptedBrokerTransport implements SandboxBrokerTransport {
  public readonly calls: { method: BrokerMethod; params: unknown }[] = [];

  public constructor(
    private readonly handler: (method: BrokerMethod, params: unknown) => unknown | Promise<unknown>,
  ) {}

  public async request<Method extends BrokerMethod>(
    method: Method,
    params: BrokerRequestMap[Method]["params"],
    _signal?: AbortSignal,
  ): Promise<unknown> {
    this.calls.push({ method, params });
    return this.handler(method, params);
  }

  public dispose(): void {}
}

function hello(features: Partial<Record<keyof WindowsSandboxFeatures, boolean>> = {}): object {
  return {
    protocolVersion: 1,
    brokerVersion: "test",
    platform: "windows",
    architecture: "x64",
    powerShellVersion: "7.4.18",
    powerShellExecutable: "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
    features: { ...FULL_FEATURES, ...features },
  };
}

function analysis(script: string, overrides: Record<string, unknown> = {}): object {
  return {
    analysisId: "analysis-1",
    scriptSha256: sha256Text(script),
    parseErrors: [],
    commands: [{ name: "Get-Content", text: "Get-Content note.txt", startOffset: 0, endOffset: 20 }],
    affectedFiles: ["note.txt"],
    networkTargets: [],
    requestedCapabilities: ["process.execute", "workspace.read"],
    deniedReasons: [],
    readOnly: true,
    ...overrides,
  };
}

function execution(request: ExecutePowerShellRequest, overrides: Record<string, unknown> = {}): object {
  return {
    executionId: request.executionId,
    analysisId: request.analysisId,
    scriptSha256: request.scriptSha256,
    stdout: "content",
    stderr: "",
    exitCode: 0,
    timedOut: false,
    interrupted: false,
    auditLogPath: "C:\\audit\\run.jsonl",
    durationMs: 12,
    ...overrides,
  };
}

test("Broker 缺少任一强制沙箱能力时拒绝初始化", async () => {
  const transport = new ScriptedBrokerTransport(() => hello({ appContainer: false }));
  const client = new WindowsSandboxBrokerClient(transport);
  await assert.rejects(client.initialize(), error => {
    return error instanceof Error && /appContainer/.test(error.message);
  });
});

test("SandboxRuntime 将 Broker 初始化失败记录为不健康，不伪装可执行", async () => {
  const transport = new ScriptedBrokerTransport(() => hello({ jobObject: false }));
  const runtime = new SandboxRuntime(new WindowsSandboxBrokerClient(transport));
  const status = await runtime.initialize();
  assert.equal(status.initialized, true);
  assert.equal(status.healthy, false);
  assert.match(status.reason ?? "", /jobObject/);
});

test("Broker 分析结果必须绑定本地脚本 SHA-256", async () => {
  const script = "Get-Content note.txt";
  const transport = new ScriptedBrokerTransport(method => {
    if (method === "hello") return hello();
    return analysis(script, { scriptSha256: "incorrect" });
  });
  const client = new WindowsSandboxBrokerClient(transport);
  await client.initialize();
  await assert.rejects(client.analyzePowerShell({
    script,
    cwd: "C:\\workspace",
    allowedPaths: ["C:\\workspace"],
    networkMode: "offline",
    timeoutMs: 30_000,
  }), error => error instanceof Error && /SHA-256/.test(error.message));
});

test("Broker 返回未知动态 Capability 时拒绝分析结果", async () => {
  const script = "Get-Content note.txt";
  const transport = new ScriptedBrokerTransport(method => {
    if (method === "hello") return hello();
    return analysis(script, { requestedCapabilities: ["security.disable"] });
  });
  const client = new WindowsSandboxBrokerClient(transport);
  await client.initialize();
  await assert.rejects(client.analyzePowerShell({
    script,
    cwd: "C:\\workspace",
    allowedPaths: ["C:\\workspace"],
    networkMode: "offline",
    timeoutMs: 30_000,
  }));
});

test("PowerShell Tool 先分析再执行，并复用 executionId、analysisId 和脚本哈希", async () => {
  const directory = `/tmp/independent-ai-ide-phase5-tool-${Date.now()}`;
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });
  const workspaces = new WorkspaceRegistry();
  workspaces.register(await WorkspaceService.create("workspace", directory));
  const script = "Get-Content note.txt";
  const transport = new ScriptedBrokerTransport((method, params) => {
    if (method === "hello") return hello();
    if (method === "powershell.analyze") return analysis(script);
    if (method === "powershell.discard-analysis") return { discarded: false };
    if (method === "powershell.execute") {
      const request = params as ExecutePowerShellRequest;
      assert.equal(request.executionId, "execution:session:call");
      assert.equal(request.analysisId, "analysis-1");
      assert.equal(request.scriptSha256, sha256Text(script));
      return execution(request);
    }
    return { canceled: true };
  });
  const client = new WindowsSandboxBrokerClient(transport);
  await client.initialize();
  const tool = createPowerShellTool({ broker: client, workspaces, getNetworkMode: () => "offline" });
  const input = tool.validate({ script });
  const context = {
    sessionId: "session",
    workspaceId: "workspace",
    toolCallId: "call",
    signal: new AbortController().signal,
  };
  const inspected = await tool.inspect(input, context);
  assert.deepEqual(inspected.affectedFiles, ["note.txt"]);
  assert.equal(inspected.sandboxRequired, true);
  const result = await tool.execute(input, {
    ...context,
    reportProgress: async () => undefined,
  });
  assert.equal(result.stdout, "content");
  await tool.releaseInspection?.(input, context);
  assert.deepEqual(transport.calls.map(item => item.method), [
    "hello",
    "powershell.analyze",
    "powershell.execute",
    "powershell.discard-analysis",
  ]);
  await rm(directory, { recursive: true, force: true });
});

test("PowerShell Tool 在安全分析拒绝时不会调用 execute", async () => {
  const directory = `/tmp/independent-ai-ide-phase5-deny-${Date.now()}`;
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });
  const workspaces = new WorkspaceRegistry();
  workspaces.register(await WorkspaceService.create("workspace", directory));
  const script = "Invoke-Expression $text";
  const transport = new ScriptedBrokerTransport(method => {
    if (method === "hello") return hello();
    if (method === "powershell.analyze") {
      return analysis(script, { deniedReasons: ["禁止动态执行 Invoke-Expression"] });
    }
    throw new Error("安全分析拒绝后不应执行");
  });
  const client = new WindowsSandboxBrokerClient(transport);
  await client.initialize();
  const tool = createPowerShellTool({ broker: client, workspaces, getNetworkMode: () => "offline" });
  const input = tool.validate({ script });
  await assert.rejects(Promise.resolve(tool.inspect(input, {
    sessionId: "session",
    workspaceId: "workspace",
    toolCallId: "call",
    signal: new AbortController().signal,
  })));
  assert.deepEqual(transport.calls.map(item => item.method), ["hello", "powershell.analyze"]);
  await rm(directory, { recursive: true, force: true });
});

test("权限拒绝后 releaseInspection 会通知 Broker 释放分析结果", async () => {
  const directory = `/tmp/independent-ai-ide-phase5-release-${Date.now()}`;
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });
  const workspaces = new WorkspaceRegistry();
  workspaces.register(await WorkspaceService.create("workspace", directory));
  const script = "Get-Content note.txt";
  const transport = new ScriptedBrokerTransport(method => {
    if (method === "hello") return hello();
    if (method === "powershell.analyze") return analysis(script);
    if (method === "powershell.discard-analysis") return { discarded: true };
    throw new Error("不应执行 PowerShell");
  });
  const client = new WindowsSandboxBrokerClient(transport);
  await client.initialize();
  const tool = createPowerShellTool({ broker: client, workspaces, getNetworkMode: () => "offline" });
  const input = tool.validate({ script });
  const context = {
    sessionId: "session",
    workspaceId: "workspace",
    toolCallId: "call",
    signal: new AbortController().signal,
  };
  await tool.inspect(input, context);
  await tool.releaseInspection?.(input, context);
  assert.deepEqual(transport.calls.map(item => item.method), [
    "hello",
    "powershell.analyze",
    "powershell.discard-analysis",
  ]);
  await rm(directory, { recursive: true, force: true });
});

test("PowerShell Tool 拒绝 Broker 返回的绝对 affectedFiles", async () => {
  const directory = `/tmp/independent-ai-ide-phase5-path-${Date.now()}`;
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });
  const workspaces = new WorkspaceRegistry();
  workspaces.register(await WorkspaceService.create("workspace", directory));
  const script = "Get-Content note.txt";
  const client = new WindowsSandboxBrokerClient(new ScriptedBrokerTransport(method => {
    if (method === "hello") return hello();
    return analysis(script, { affectedFiles: ["C:\\Users\\secret.txt"] });
  }));
  await client.initialize();
  const tool = createPowerShellTool({ broker: client, workspaces, getNetworkMode: () => "offline" });
  await assert.rejects(Promise.resolve(tool.inspect(tool.validate({ script }), {
    sessionId: "session",
    workspaceId: "workspace",
    toolCallId: "call",
    signal: new AbortController().signal,
  })));
  await rm(directory, { recursive: true, force: true });
});

test("权限协调器合并 Tool Manifest 与 AST 动态能力", async () => {
  const coordinator = new PermissionCoordinator(new IncrementingIdGenerator());
  const session = new AgentSession("session", "workspace", "autoReview");
  session.start("run");
  const decision = await coordinator.authorize(
    session,
    "tool-call-permission",
    {
      name: "PowerShell",
      version: "1.0.0",
      riskLevel: "process",
      capabilities: ["process.execute"],
      generated: false,
    },
    {
      affectedFiles: [],
      certifiedComputerApplication: false,
      requestedCapabilities: ["network.internet"],
    },
    async () => undefined,
    new AbortController().signal,
  );
  assert.equal(decision, "deny");
});

test("PowerShell Tool 拒绝未知字段和越界超时", async () => {
  const directory = `/tmp/independent-ai-ide-phase5-validate-${Date.now()}`;
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });
  const workspaces = new WorkspaceRegistry();
  workspaces.register(await WorkspaceService.create("workspace", directory));
  const client = new WindowsSandboxBrokerClient(new ScriptedBrokerTransport(() => hello()));
  const tool = createPowerShellTool({ broker: client, workspaces, getNetworkMode: () => "offline" });
  assert.throws(() => tool.validate({ script: "Get-Date", command: "ignored" }));
  assert.throws(() => tool.validate({ script: "Get-Date", timeoutMs: 120_001 }));
  await rm(directory, { recursive: true, force: true });
});

test("执行请求中的脚本变化会在发送给 Broker 前被拒绝", async () => {
  const transport = new ScriptedBrokerTransport(method => method === "hello" ? hello() : { discarded: false });
  const client = new WindowsSandboxBrokerClient(transport);
  await client.initialize();
  await assert.rejects(client.executePowerShell({
    executionId: "execution",
    analysisId: "analysis",
    script: "Get-Date",
    scriptSha256: sha256Text("Get-ChildItem"),
    cwd: "C:\\workspace",
    allowedPaths: ["C:\\workspace"],
    networkMode: "offline",
    timeoutMs: 30_000,
  }));
  assert.deepEqual(transport.calls.map(item => item.method), ["hello"]);
});

test("Broker 执行结果绑定字段不匹配时拒绝结果", async () => {
  const script = "Get-Date";
  const request: ExecutePowerShellRequest = {
    executionId: "execution",
    analysisId: "analysis",
    script,
    scriptSha256: sha256Text(script),
    cwd: "C:\\workspace",
    allowedPaths: ["C:\\workspace"],
    networkMode: "offline",
    timeoutMs: 30_000,
  };
  const transport = new ScriptedBrokerTransport((method, params) => {
    if (method === "hello") return hello();
    if (method === "powershell.execute") {
      return execution(params as ExecutePowerShellRequest, { analysisId: "other-analysis" });
    }
    return { discarded: false };
  });
  const client = new WindowsSandboxBrokerClient(transport);
  await client.initialize();
  await assert.rejects(client.executePowerShell(request), error =>
    error instanceof Error && /不匹配/.test(error.message));
});
