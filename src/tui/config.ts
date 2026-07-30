import { lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import type { NetworkMode, PermissionMode } from "../agent-protocol.js";
import { ChildProcessSandboxBrokerTransport } from "../sandbox/broker-transport.js";
import { WindowsSandboxBrokerClient } from "../sandbox/broker-client.js";

export interface TuiConfiguration {
  readonly configPath: string;
  readonly dataDirectory: string;
  readonly sandboxBrokerExecutablePath: string;
  readonly permissionMode: PermissionMode;
  readonly networkMode: NetworkMode;
  readonly model: {
    readonly baseUrl: string;
    readonly chatCompletionsPath: string;
    readonly model: string;
    readonly apiKey: string;
    readonly contextWindowTokens: number;
  };
}

export interface TuiSetupDraft {
  readonly configPath: string;
  readonly baseUrl: string;
  readonly chatCompletionsPath: string;
  readonly model: string;
  readonly apiKey: string;
  readonly contextWindowTokens: string;
  readonly sandboxBrokerExecutablePath: string;
  readonly permissionMode: PermissionMode;
  readonly networkMode: NetworkMode;
}

export interface TuiHealthReport {
  readonly ok: boolean;
  readonly apiKeyPresent: boolean;
  readonly configuration?: {
    readonly configPath: string;
    readonly dataDirectory: string;
    readonly apiKeyConfigured: boolean;
    readonly brokerPath: string;
    readonly model: string;
    readonly contextWindowTokens: number;
  };
  readonly workspace?: {
    readonly id: string;
    readonly root: string;
    readonly ok: boolean;
  };
  readonly modelEndpoint: {
    readonly ok: boolean;
    readonly modelPresent: boolean;
    readonly message: string;
  };
  readonly broker: {
    readonly ok: boolean;
    readonly protocolVersion?: number;
    readonly brokerVersion?: string;
    readonly message: string;
  };
  readonly messages: readonly string[];
}

interface TuiConfigFile {
  readonly model?: {
    readonly baseUrl?: unknown;
    readonly chatCompletionsPath?: unknown;
    readonly model?: unknown;
    readonly apiKey?: unknown;
    readonly contextWindowTokens?: unknown;
  };
  readonly sandboxBrokerExecutablePath?: unknown;
  readonly permissionMode?: unknown;
  readonly networkMode?: unknown;
}

export function defaultTuiConfigPath(): string {
  return join(homedir(), ".independent-ai-agent", "config.json");
}

export async function loadTuiSetupDraft(configPath = defaultTuiConfigPath()): Promise<{
  readonly draft: TuiSetupDraft;
  readonly exists: boolean;
  readonly error?: string;
}> {
  const absoluteConfigPath = resolve(configPath);
  const defaults: TuiSetupDraft = {
    configPath: absoluteConfigPath,
    baseUrl: "http://127.0.0.1:1234/v1",
    chatCompletionsPath: "/chat/completions",
    model: "google/gemma-4-e2b",
    apiKey: "",
    contextWindowTokens: "131072",
    sandboxBrokerExecutablePath: await discoverBrokerExecutablePath(),
    permissionMode: "default",
    networkMode: "offline",
  };
  let text: string;
  try {
    text = await readFile(absoluteConfigPath, "utf8");
  } catch (error: unknown) {
    if (isMissingFileError(error)) return { draft: defaults, exists: false };
    throw error;
  }
  try {
    return { draft: draftFromRecord(parseConfig(text), defaults), exists: true };
  } catch (error: unknown) {
    return {
      draft: defaults,
      exists: true,
      error: error instanceof Error ? error.message : "TUI 配置无效",
    };
  }
}

export async function writeTuiConfiguration(draft: TuiSetupDraft): Promise<void> {
  requiredString(draft.apiKey, "model.apiKey");
  const configPath = resolve(draft.configPath);
  await mkdir(dirname(configPath), { recursive: true });
  let existingText: string | undefined;
  try {
    existingText = await readFile(configPath, "utf8");
  } catch (error: unknown) {
    if (!isMissingFileError(error)) throw error;
  }
  if (existingText !== undefined) {
    try {
      const existing = parseConfig(existingText);
      if (!isPersistedConfigShapeValid(existing)) throw new Error("TUI 配置字段无效");
    } catch {
      const backupPath = `${configPath}.invalid-${Date.now()}.bak`;
      await rename(configPath, backupPath);
    }
  }
  const value = {
    model: {
      baseUrl: draft.baseUrl,
      chatCompletionsPath: draft.chatCompletionsPath,
      model: draft.model,
      apiKey: draft.apiKey,
      contextWindowTokens: Number.parseInt(draft.contextWindowTokens, 10),
    },
    permissionMode: draft.permissionMode,
    networkMode: draft.networkMode,
  };
  const temporaryPath = `${configPath}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporaryPath, configPath);
}

export async function discoverBrokerExecutablePath(): Promise<string> {
  const relative = join(
    "native",
    "windows-sandbox-broker",
    "bin",
    "Release",
    "net8.0-windows",
    "win-x64",
    "publish",
    "IndependentAiIde.WindowsSandboxBroker.exe",
  );
  const moduleRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  const packaged = join(moduleRoot, "resources", "app", "bin", "windows-sandbox-broker", "IndependentAiIde.WindowsSandboxBroker.exe");
  const candidates = [packaged, resolve(process.cwd(), relative), join(moduleRoot, relative)];
  for (const candidate of [...new Set(candidates)]) {
    const status = await lstat(candidate).catch(() => undefined);
    if (status?.isFile() === true) return candidate;
  }
  return "";
}

export async function checkTuiHealth(draft: TuiSetupDraft): Promise<TuiHealthReport> {
  const messages: string[] = [];
  const apiKeyPresent = !isBlank(draft.apiKey);

  let modelEndpoint: TuiHealthReport["modelEndpoint"];
  if (!apiKeyPresent) {
    modelEndpoint = {
      ok: false,
      modelPresent: false,
      message: "未填写 API Key；请在配置向导中直接填写后重试",
    };
  } else {
    try {
      const url = new URL("models", `${new URL(draft.baseUrl).toString().replace(/\/$/, "")}/`);
      const response = await fetch(url, {
        headers: { authorization: `Bearer ${draft.apiKey}` },
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) {
        modelEndpoint = { ok: false, modelPresent: false, message: `模型服务返回 HTTP ${response.status}` };
      } else {
        const body = await response.json() as unknown;
        const ids = isRecord(body) && Array.isArray(body.data)
          ? body.data.flatMap(item => isRecord(item) && typeof item.id === "string" ? [item.id] : [])
          : [];
        const modelPresent = ids.includes(draft.model);
        modelEndpoint = {
          ok: modelPresent,
          modelPresent,
          message: modelPresent ? `已找到模型：${draft.model}` : `模型服务未返回：${draft.model}`,
        };
      }
    } catch (error: unknown) {
      modelEndpoint = { ok: false, modelPresent: false, message: error instanceof Error ? error.message : "模型服务不可达" };
    }
  }

  let broker: TuiHealthReport["broker"];
  if (draft.sandboxBrokerExecutablePath.trim() === "") {
    broker = { ok: false, message: "未填写 Windows Sandbox Broker 路径" };
  } else {
    const status = await lstat(draft.sandboxBrokerExecutablePath).catch(() => undefined);
    if (status?.isFile() !== true) {
      broker = { ok: false, message: `Broker 不存在：${draft.sandboxBrokerExecutablePath}` };
    } else {
      const client = new WindowsSandboxBrokerClient(
        new ChildProcessSandboxBrokerTransport(draft.sandboxBrokerExecutablePath),
      );
      try {
        const hello = await client.initialize();
        broker = {
          ok: true,
          protocolVersion: hello.protocolVersion,
          brokerVersion: hello.brokerVersion,
          message: `Broker ${hello.brokerVersion}，协议 ${hello.protocolVersion}`,
        };
      } catch (error: unknown) {
        broker = { ok: false, message: error instanceof Error ? error.message : "Broker 检查失败" };
      } finally {
        client.dispose();
      }
    }
  }

  if (apiKeyPresent) messages.push("API Key 已配置（不会显示值）");
  messages.push(modelEndpoint.message, broker.message);
  return {
    ok: apiKeyPresent && modelEndpoint.ok && broker.ok,
    apiKeyPresent,
    modelEndpoint,
    broker,
    messages,
  };
}

export async function configurationFromTuiSetupDraft(draft: TuiSetupDraft): Promise<TuiConfiguration> {
  const baseUrl = requiredString(draft.baseUrl, "model.baseUrl");
  void new URL(baseUrl);
  const model = requiredString(draft.model, "model.model");
  const apiKey = requiredString(draft.apiKey, "model.apiKey");
  const brokerPath = await discoverBrokerExecutablePath();
  const brokerStatus = await lstat(brokerPath).catch(() => undefined);
  if (brokerStatus?.isFile() !== true) {
    throw new Error(`Windows Sandbox Broker 不存在：${brokerPath || "当前安装包"}`);
  }
  if (draft.permissionMode !== "default" && draft.permissionMode !== "autoReview") {
    throw new Error("permissionMode 只允许 default 或 autoReview");
  }
  if (draft.networkMode !== "offline" && draft.networkMode !== "lan" && draft.networkMode !== "internet") {
    throw new Error("networkMode 必须是 offline、lan 或 internet");
  }
  return {
    configPath: resolve(draft.configPath),
    dataDirectory: join(homedir(), ".independent-ai-agent", "data"),
    sandboxBrokerExecutablePath: brokerPath,
    permissionMode: draft.permissionMode,
    networkMode: draft.networkMode,
    model: {
      baseUrl,
      chatCompletionsPath: draft.chatCompletionsPath.trim() === "" ? "/chat/completions" : draft.chatCompletionsPath,
      model,
      apiKey,
      contextWindowTokens: parseContextWindow(draft.contextWindowTokens),
    },
  };
}

export function configurationToTuiSetupDraft(configuration: TuiConfiguration): TuiSetupDraft {
  return {
    configPath: configuration.configPath,
    baseUrl: configuration.model.baseUrl,
    chatCompletionsPath: configuration.model.chatCompletionsPath,
    model: configuration.model.model,
    apiKey: configuration.model.apiKey,
    contextWindowTokens: String(configuration.model.contextWindowTokens),
    sandboxBrokerExecutablePath: configuration.sandboxBrokerExecutablePath,
    permissionMode: configuration.permissionMode,
    networkMode: configuration.networkMode,
  };
}

export async function loadTuiConfiguration(configPath = defaultTuiConfigPath()): Promise<TuiConfiguration> {
  const absoluteConfigPath = resolve(configPath);
  let record: TuiConfigFile;
  try {
    record = parseConfig(await readFile(absoluteConfigPath, "utf8"));
  } catch (error: unknown) {
    if (isMissingFileError(error)) {
      throw new Error(`TUI 配置不存在：${absoluteConfigPath}\n请创建配置文件，至少包含 model.apiKey；首次启动会进入配置向导。`);
    }
    throw error;
  }

  const modelRecord = record.model;
  if (modelRecord === undefined || typeof modelRecord !== "object" || modelRecord === null) {
    throw new Error("TUI 配置缺少 model 对象");
  }
  const baseUrl = requiredString(modelRecord.baseUrl, "model.baseUrl");
  const model = requiredString(modelRecord.model, "model.model");
  const apiKey = requiredString(modelRecord.apiKey, "model.apiKey");
  const brokerPath = await discoverBrokerExecutablePath();
  const brokerStatus = await lstat(brokerPath).catch(() => undefined);
  if (brokerStatus === undefined || !brokerStatus.isFile()) {
    throw new Error(`Windows Sandbox Broker 不存在于当前安装包：${brokerPath || "未发现"}`);
  }

  const permissionMode = record.permissionMode ?? "default";
  if (permissionMode !== "default" && permissionMode !== "autoReview") {
    throw new Error("TUI 首版 permissionMode 只允许 default 或 autoReview");
  }
  const networkMode = record.networkMode ?? "offline";
  if (networkMode !== "offline" && networkMode !== "lan" && networkMode !== "internet") {
    throw new Error("networkMode 必须是 offline、lan 或 internet");
  }

  return {
    configPath: absoluteConfigPath,
    dataDirectory: join(homedir(), ".independent-ai-agent", "data"),
    sandboxBrokerExecutablePath: brokerPath,
    permissionMode,
    networkMode,
    model: {
      baseUrl,
      chatCompletionsPath: typeof modelRecord.chatCompletionsPath === "string"
        && modelRecord.chatCompletionsPath.trim() !== ""
        ? modelRecord.chatCompletionsPath
        : "/chat/completions",
      model,
      apiKey,
      contextWindowTokens: modelRecord.contextWindowTokens === undefined ? 131072 : parseContextWindow(modelRecord.contextWindowTokens),
    },
  };
}

export async function resolveWorkspaceRoot(argument = process.cwd()): Promise<string> {
  const absolute = resolve(argument);
  const status = await lstat(absolute).catch(() => undefined);
  if (status === undefined || !status.isDirectory()) {
    throw new Error(`工作区必须是已经存在的目录：${absolute}`);
  }
  return absolute;
}

function parseConfig(text: string): TuiConfigFile {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch (error: unknown) {
    throw new Error(`TUI 配置不是有效 JSON：${error instanceof Error ? error.message : "解析失败"}`);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("TUI 配置必须是 JSON 对象");
  }
  return value as TuiConfigFile;
}

function draftFromRecord(record: TuiConfigFile, defaults: TuiSetupDraft): TuiSetupDraft {
  const model = record.model;
  if (model === undefined || typeof model !== "object" || model === null) {
    throw new Error("TUI 配置缺少 model 对象");
  }
  return {
    ...defaults,
    baseUrl: typeof model.baseUrl === "string" ? model.baseUrl : defaults.baseUrl,
    chatCompletionsPath: typeof model.chatCompletionsPath === "string" ? model.chatCompletionsPath : defaults.chatCompletionsPath,
    model: typeof model.model === "string" ? model.model : defaults.model,
    apiKey: typeof model.apiKey === "string" ? model.apiKey : defaults.apiKey,
    contextWindowTokens: typeof model.contextWindowTokens === "number" ? String(model.contextWindowTokens) : defaults.contextWindowTokens,
    sandboxBrokerExecutablePath: defaults.sandboxBrokerExecutablePath,
    permissionMode: record.permissionMode === "autoReview" ? "autoReview" : "default",
    networkMode: record.networkMode === "lan" || record.networkMode === "internet" ? record.networkMode : "offline",
  };
}

function isPersistedConfigShapeValid(record: TuiConfigFile): boolean {
  try {
    const model = record.model;
    if (model === undefined || typeof model !== "object" || model === null) return false;
    const baseUrl = requiredString(model.baseUrl, "model.baseUrl");
    void new URL(baseUrl);
    requiredString(model.model, "model.model");
    requiredString(model.apiKey, "model.apiKey");
    if (model.chatCompletionsPath !== undefined) requiredString(model.chatCompletionsPath, "model.chatCompletionsPath");
    if (model.contextWindowTokens !== undefined) parseContextWindow(model.contextWindowTokens);
    if (record.permissionMode !== undefined && record.permissionMode !== "default" && record.permissionMode !== "autoReview") return false;
    if (record.networkMode !== undefined && record.networkMode !== "offline" && record.networkMode !== "lan" && record.networkMode !== "internet") return false;
    return true;
  } catch {
    return false;
  }
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} 必须是非空字符串`);
  }
  return value;
}

function isBlank(value: string | undefined): boolean {
  return value === undefined || value.trim() === "";
}

function parseContextWindow(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed < 4096 || parsed > 2_000_000) throw new Error("model.contextWindowTokens 必须是 4096 到 2000000 的整数");
  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && (error as { readonly code?: unknown }).code === "ENOENT";
}
