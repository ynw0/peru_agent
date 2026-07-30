import { createInterface } from "node:readline";
import { DesktopAgentRuntimeHost, type DesktopModelConfiguration } from "./agent-host.js";
import {
  RUNTIME_PRODUCT_VERSION,
  RUNTIME_PROTOCOL_VERSION,
  RuntimeNdjsonCodec,
  RuntimeProtocolError,
  type RuntimeRequest,
} from "./process-protocol.js";
import { createRuntimeConfiguration, type RuntimeConnectionStatus } from "./runtime-configuration.js";

const REQUEST_TIMEOUT_MS = 120_000;
const codec = new RuntimeNdjsonCodec();

function writeLine(line: string): void {
  process.stdout.write(line);
}

function writeResponse(id: string, result: unknown): void {
  writeLine(codec.encodeResponse({ type: "response", id, ok: true, result }));
}

function writeError(id: string, error: unknown): void {
  const code = error instanceof RuntimeProtocolError ? error.code : "RUNTIME_ERROR";
  const message = error instanceof Error ? error.message : "Runtime 未知错误";
  writeLine(codec.encodeResponse({ type: "response", id, ok: false, error: { code, message } }));
}

function emit(event: string, data: unknown): void {
  writeLine(codec.encodeEvent({ type: "event", event, data }));
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RuntimeProtocolError("INVALID_ARGUMENTS", "Runtime 请求参数必须是对象");
  }
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new RuntimeProtocolError("INVALID_ARGUMENTS", `Runtime 参数 ${name} 必须是非空字符串`);
  }
  return value;
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  return stringValue(value, name);
}

function booleanEnvironment(name: string, defaultValue: boolean): boolean {
  const value = process.env[name];
  if (value === undefined) return defaultValue;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`环境变量 ${name} 必须是 true 或 false`);
}

function environmentString(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value.trim() === "" ? undefined : value;
}

const dataDirectory = stringValue(process.env.INDEPENDENT_AI_IDE_DATA_DIRECTORY, "INDEPENDENT_AI_IDE_DATA_DIRECTORY");
const sandboxBrokerExecutablePath = stringValue(process.env.INDEPENDENT_AI_IDE_SANDBOX_BROKER, "INDEPENDENT_AI_IDE_SANDBOX_BROKER");
const runtimeConfigurationDefaults = {
  network: {
    mode: (environmentString("INDEPENDENT_AI_IDE_NETWORK_MODE") ?? "offline") as "offline" | "lan" | "internet",
    webFetchEnabled: booleanEnvironment("INDEPENDENT_AI_IDE_ENABLE_WEB_FETCH", true),
    webSearchEnabled: booleanEnvironment("INDEPENDENT_AI_IDE_ENABLE_WEB_SEARCH", false),
    ...(environmentString("INDEPENDENT_AI_IDE_SEARXNG_ENDPOINT") === undefined ? {} : { searxngEndpoint: environmentString("INDEPENDENT_AI_IDE_SEARXNG_ENDPOINT")! }),
  },
  browser: {
    enabled: booleanEnvironment("INDEPENDENT_AI_IDE_ENABLE_BROWSER", false),
    maxSessions: Number(environmentString("INDEPENDENT_AI_IDE_BROWSER_MAX_SESSIONS") ?? "3"),
    ...(environmentString("INDEPENDENT_AI_IDE_CHROMIUM_EXECUTABLE") === undefined ? {} : { chromiumExecutablePath: environmentString("INDEPENDENT_AI_IDE_CHROMIUM_EXECUTABLE")! }),
  },
  computerUse: {
    enabled: booleanEnvironment("INDEPENDENT_AI_IDE_ENABLE_COMPUTER_USE", false),
    ...(environmentString("INDEPENDENT_AI_IDE_COMPUTER_BROKER") === undefined ? {} : { brokerExecutablePath: environmentString("INDEPENDENT_AI_IDE_COMPUTER_BROKER")! }),
    ...(environmentString("INDEPENDENT_AI_IDE_COMPUTER_MANIFEST") === undefined ? {} : { certificationManifestPath: environmentString("INDEPENDENT_AI_IDE_COMPUTER_MANIFEST")! }),
  },
} as const;

let host: DesktopAgentRuntimeHost | undefined;
let initialized = false;
let shuttingDown = false;
let connectionStatus: RuntimeConnectionStatus = "starting";
let initializePromise: Promise<unknown> | undefined;
const requestControllers = new Map<string, AbortController>();

emitStatus("starting");

async function initialize(args: Record<string, unknown>): Promise<unknown> {
  if (host !== undefined) return { status: connectionStatus, protocolVersion: RUNTIME_PROTOCOL_VERSION, productVersion: RUNTIME_PRODUCT_VERSION, snapshot: host.getSnapshot() };
  const model = (args.model === undefined ? {} : record(args.model)) as DesktopModelConfiguration;
  const configuration = createRuntimeConfiguration({
    dataDirectory,
    sandboxBrokerExecutablePath,
    model,
    productVersion: RUNTIME_PRODUCT_VERSION,
    network: runtimeConfigurationDefaults.network,
    browser: runtimeConfigurationDefaults.browser,
    computerUse: runtimeConfigurationDefaults.computerUse,
  });
  host = new DesktopAgentRuntimeHost({ dataDirectory, sandboxBrokerExecutablePath, model, configuration });
  host.onSnapshot(snapshot => emit("workbench.snapshot", snapshot));
  try {
    const snapshot = await host.initialize();
    initialized = true;
    connectionStatus = isModelConfigured(model) ? "connected" : "model-not-configured";
    emitStatus(connectionStatus);
    return { status: connectionStatus, protocolVersion: RUNTIME_PROTOCOL_VERSION, productVersion: RUNTIME_PRODUCT_VERSION, snapshot };
  } catch (error) {
    connectionStatus = "initialization-failed";
    emitStatus(connectionStatus, error instanceof Error ? error.message : "Runtime 初始化失败");
    throw error;
  }
}

async function handle(request: RuntimeRequest, signal: AbortSignal): Promise<unknown> {
  if (shuttingDown && request.command !== "runtime.shutdown") {
    throw new RuntimeProtocolError("RUNTIME_STOPPING", "Runtime 正在停止");
  }
  if (request.command === "runtime.initialize") {
    const args = record(request.arguments);
    initializePromise ??= initialize(args).finally(() => { initializePromise = undefined; });
    return initializePromise;
  }
  if (request.command === "runtime.getStatus") {
    return { status: connectionStatus, protocolVersion: RUNTIME_PROTOCOL_VERSION, productVersion: RUNTIME_PRODUCT_VERSION };
  }
  if (request.command === "runtime.cancel") {
    const args = record(request.arguments);
    const requestId = stringValue(args.requestId, "requestId");
    const controller = requestControllers.get(requestId);
    if (controller === undefined) return { accepted: false };
    controller.abort();
    return { accepted: true };
  }
  if (request.command === "runtime.shutdown") {
    shuttingDown = true;
    connectionStatus = "stopping";
    emitStatus(connectionStatus);
    if (host !== undefined) await host.dispose();
    initialized = false;
    host = undefined;
    connectionStatus = "disconnected";
    emitStatus(connectionStatus);
    return undefined;
  }
  if (!initialized || host === undefined) throw new RuntimeProtocolError("RUNTIME_NOT_INITIALIZED", "Runtime 尚未完成初始化");

  switch (request.command) {
    case "runtime.getSnapshot": return host.getSnapshot();
    case "agent.sendInput": {
      const args = record(request.arguments);
      await host.sendInput(stringValue(args.workspaceId, "workspaceId"), stringValue(args.rootPath, "rootPath"), stringValue(args.input, "input"));
      return undefined;
    }
    case "agent.stop": await host.stop(); return undefined;
    case "agent.retry": await host.retry(); return undefined;
    case "permission.resolve": {
      const args = record(request.arguments);
      const decision = stringValue(args.decision, "decision");
      if (decision !== "allow" && decision !== "deny") throw new RuntimeProtocolError("INVALID_ARGUMENTS", "permission decision 无效");
      return { accepted: host.resolvePermission(stringValue(args.requestId, "requestId"), decision) };
    }
    case "plan.resolve": {
      const args = record(request.arguments);
      const decision = stringValue(args.decision, "decision");
      if (decision !== "approved" && decision !== "rejected") throw new RuntimeProtocolError("INVALID_ARGUMENTS", "plan decision 无效");
      await host.resolvePlan(stringValue(args.planId, "planId"), decision);
      return undefined;
    }
    case "diff.accept": { const args = record(request.arguments); await host.acceptDiff(stringValue(args.proposalId, "proposalId")); return undefined; }
    case "diff.reject": { const args = record(request.arguments); await host.rejectDiff(stringValue(args.proposalId, "proposalId")); return undefined; }
    case "checkpoint.restore": { const args = record(request.arguments); await host.restoreCheckpoint(stringValue(args.checkpointId, "checkpointId")); return undefined; }
    case "browser.create": {
      const args = record(request.arguments);
      const networkMode = stringValue(args.networkMode, "networkMode");
      const locale = stringValue(args.locale, "locale");
      if ((networkMode !== "offline" && networkMode !== "lan" && networkMode !== "internet") || (locale !== "zh-CN" && locale !== "en-US")) throw new RuntimeProtocolError("INVALID_ARGUMENTS", "浏览器创建参数无效");
      return host.createBrowser(stringValue(args.workspaceId, "workspaceId"), networkMode, locale);
    }
    case "browser.navigate": { const args = record(request.arguments); return host.navigateBrowser(stringValue(args.sessionId, "sessionId"), stringValue(args.url, "url")); }
    case "browser.snapshot": { const args = record(request.arguments); return host.refreshBrowserSnapshot(stringValue(args.sessionId, "sessionId")); }
    case "browser.download": { const args = record(request.arguments); return host.downloadBrowser(stringValue(args.sessionId, "sessionId"), stringValue(args.url, "url"), optionalPositiveInteger(args.maxBytes, "maxBytes", 20 * 1024 * 1024)); }
    case "browser.click": { const args = record(request.arguments); return host.clickBrowser(stringValue(args.sessionId, "sessionId"), stringValue(args.snapshotId, "snapshotId"), stringValue(args.elementId, "elementId")); }
    case "browser.type": { const args = record(request.arguments); return host.typeBrowser(stringValue(args.sessionId, "sessionId"), stringValue(args.snapshotId, "snapshotId"), stringValue(args.elementId, "elementId"), stringValue(args.text, "text")); }
    case "browser.close": { const args = record(request.arguments); return host.closeBrowser(stringValue(args.sessionId, "sessionId")); }
    case "computer.windows": return host.refreshComputerWindows();
    case "computer.inspect": { const args = record(request.arguments); return host.inspectComputerWindow(stringValue(args.windowHandle, "windowHandle")); }
    case "computer.screenshot": { const args = record(request.arguments); return host.screenshotComputerWindow(stringValue(args.snapshotId, "snapshotId")); }
    default: throw new RuntimeProtocolError("COMMAND_NOT_FOUND", `Runtime 命令未注册：${request.command}`);
  }
}

function optionalPositiveInteger(value: unknown, name: string, defaultValue: number): number {
  const result = value ?? defaultValue;
  if (!Number.isInteger(result) || Number(result) < 1) throw new RuntimeProtocolError("INVALID_ARGUMENTS", `${name} 必须是正整数`);
  return Number(result);
}

function isModelConfigured(model: DesktopModelConfiguration): boolean {
  return [model.baseUrl, model.chatCompletionsPath, model.model, model.apiKeyEnvironmentVariable].every(value => typeof value === "string" && value.trim() !== "");
}

function emitStatus(status: RuntimeConnectionStatus, message?: string): void {
  emit("runtime.status", {
    status,
    protocolVersion: RUNTIME_PROTOCOL_VERSION,
    productVersion: RUNTIME_PRODUCT_VERSION,
    ...(message === undefined ? {} : { message }),
  });
}

function withTimeout<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error("Runtime 请求已取消"));
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Runtime 请求超时")), REQUEST_TIMEOUT_MS);
    const abort = () => { clearTimeout(timer); reject(new Error("Runtime 请求已取消")); };
    signal.addEventListener("abort", abort, { once: true });
    promise.then(value => { clearTimeout(timer); signal.removeEventListener("abort", abort); resolve(value); }, error => { clearTimeout(timer); signal.removeEventListener("abort", abort); reject(error); });
  });
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", line => {
  let request: RuntimeRequest;
  try {
    request = codec.parseRequest(line);
  } catch (error) {
    const value = (() => { try { return JSON.parse(line) as { id?: unknown }; } catch { return {}; } })();
    writeError(typeof value.id === "string" ? value.id : "invalid", error);
    return;
  }
  const controller = new AbortController();
  requestControllers.set(request.id, controller);
  void withTimeout(handle(request, controller.signal), controller.signal)
    .then(result => writeResponse(request.id, result))
    .catch(error => writeError(request.id, error))
    .finally(() => {
      requestControllers.delete(request.id);
      codec.completeRequest(request.id);
      if (request.command === "runtime.shutdown") process.exit(0);
    });
});

process.on("uncaughtException", error => { process.stderr.write(`${error.stack ?? error.message}\n`); process.exitCode = 1; });
process.on("unhandledRejection", error => { process.stderr.write(`${String(error)}\n`); process.exitCode = 1; });
