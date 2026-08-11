import type { NetworkMode } from "../agent-protocol.js";
import { EgressBroker } from "../egress/broker.js";
import type { EgressAuthorizationLease } from "../egress/types.js";
import { toolPermission, type Tool } from "../tool-runtime.js";
import { capabilityForMode } from "../web/web-tools.js";
import { BrowserRuntime } from "./browser-runtime.js";
import type { PreparedWebDownload, WebDownloadService } from "../web/web-download-service.js";

interface CreateInput { readonly workspaceId: string; readonly locale: "zh-CN" | "en-US" }
interface NavigateInput { readonly sessionId: string; readonly url: string }
interface SessionInput { readonly sessionId: string }
interface TargetInput extends SessionInput { readonly snapshotId: string; readonly elementId: string }
interface TypeInput extends TargetInput { readonly text: string }
interface DownloadInput extends SessionInput { readonly url: string; readonly maxBytes: number }

export interface BrowserToolDependencies {
  readonly runtime: BrowserRuntime;
  readonly broker: EgressBroker;
  readonly download: WebDownloadService;
  readonly getNetworkMode: () => NetworkMode;
}

export function createBrowserTools(dependencies: BrowserToolDependencies): readonly Tool<unknown, unknown>[] {
  const navigationLeases = new Map<string, EgressAuthorizationLease>();
  const preparedDownloads = new Map<string, PreparedWebDownload>();

  const create: Tool<CreateInput, object> = {
    manifest: {
      name: "BrowserCreate",
      version: "1.0.0",
      description: "创建使用 Broker Proxy 的受控 Chromium 会话",
      inputSchema: {
        type: "object",
        properties: { workspaceId: { type: "string" }, locale: { type: "string", enum: ["zh-CN", "en-US"] } },
        required: ["workspaceId"],
        additionalProperties: false,
      },
      riskLevel: "browser",
      capabilities: ["browser.navigate"],
      generated: false,
    },
    validate(value) {
      const record = asRecord(value);
      const locale = record.locale ?? "zh-CN";
      if (locale !== "zh-CN" && locale !== "en-US") throw new Error("locale 无效");
      return { workspaceId: requireString(record, "workspaceId"), locale };
    },
    inspect() {
      const mode = dependencies.getNetworkMode();
      return {
        affectedFiles: [],
        certifiedComputerApplication: false,
        requestedCapabilities: [capabilityForMode(mode)],
        reason: `创建 ${mode} 模式的受控浏览器会话`,
      };
    },
    permissions: input => toolPermission("browser", [`create:${input.workspaceId}`], { workspaceId: input.workspaceId, locale: input.locale }),
    execute: (input, context) => dependencies.runtime.create({
      workspaceId: input.workspaceId,
      networkMode: dependencies.getNetworkMode(),
      locale: input.locale,
    }, context.signal),
    serializeOutput: output => JSON.stringify(output),
  };

  const navigate: Tool<NavigateInput, object> = {
    manifest: {
      name: "BrowserNavigate",
      version: "1.0.0",
      description: "在受控浏览器中导航到经过审核的 URL",
      inputSchema: {
        type: "object",
        properties: { sessionId: { type: "string" }, url: { type: "string" } },
        required: ["sessionId", "url"],
        additionalProperties: false,
      },
      riskLevel: "browser",
      capabilities: ["browser.navigate"],
      generated: false,
    },
    validate(value) {
      const record = asRecord(value);
      return { sessionId: requireString(record, "sessionId"), url: requireString(record, "url") };
    },
    async inspect(input, context) {
      if (context === undefined) throw new Error("BrowserNavigate 检查需要 Tool 上下文");
      const mode = dependencies.getNetworkMode();
      const lease = await dependencies.broker.authorize({
        url: input.url,
        mode,
        purpose: "browser.navigation",
        method: "GET",
      }, context.signal);
      navigationLeases.set(context.toolCallId, lease);
      return {
        affectedFiles: [],
        certifiedComputerApplication: false,
        requestedCapabilities: [capabilityForMode(mode)],
        networkTargets: [lease.hostname],
        reason: `浏览器导航到 ${lease.hostname}`,
      };
    },
    permissions: (input, inspection) => toolPermission("browser", [input.url], { url: input.url, networkTargets: inspection.networkTargets ?? [] }),
    async execute(input, context) {
      const lease = navigationLeases.get(context.toolCallId);
      if (lease === undefined) throw new Error("BrowserNavigate 缺少已审核 URL");
      navigationLeases.delete(context.toolCallId);
      dependencies.broker.discardAuthorization(lease.id);
      if (new URL(input.url).hostname.toLowerCase().replace(/\.$/, "") !== lease.hostname) {
        throw new Error("浏览器导航 URL 与审核目标不一致");
      }
      return dependencies.runtime.navigate(input.sessionId, input.url, context.signal);
    },
    releaseInspection(_input, context) {
      const lease = navigationLeases.get(context.toolCallId);
      if (lease !== undefined) {
        dependencies.broker.discardAuthorization(lease.id);
        navigationLeases.delete(context.toolCallId);
      }
    },
    serializeOutput: output => JSON.stringify(output),
  };

  const snapshot: Tool<SessionInput, object> = {
    manifest: {
      name: "BrowserSnapshot",
      version: "1.0.0",
      description: "读取受控浏览器当前 DOM 和可操作元素快照",
      inputSchema: sessionSchema,
      riskLevel: "browser",
      capabilities: ["browser.navigate"],
      generated: false,
    },
    validate: validateSession,
    inspect: () => ({ affectedFiles: [], certifiedComputerApplication: false, reason: "读取浏览器 DOM Snapshot" }),
    permissions: input => toolPermission("browser", [`snapshot:${input.sessionId}`], { sessionId: input.sessionId }),
    execute: (input, context) => dependencies.runtime.snapshot(input.sessionId, context.signal),
    serializeOutput: output => JSON.stringify(output),
  };

  const screenshot: Tool<SessionInput, object> = {
    manifest: {
      name: "BrowserScreenshot",
      version: "1.0.0",
      description: "获取与当前 DOM Snapshot 绑定的浏览器 PNG 截图证据",
      inputSchema: sessionSchema,
      riskLevel: "browser",
      capabilities: ["browser.navigate"],
      generated: false,
    },
    validate: validateSession,
    inspect: () => ({ affectedFiles: [], certifiedComputerApplication: false, reason: "获取浏览器截图证据" }),
    permissions: input => toolPermission("browser", [`screenshot:${input.sessionId}`], { sessionId: input.sessionId }),
    execute: (input, context) => dependencies.runtime.screenshot(input.sessionId, context.signal),
    serializeOutput: output => JSON.stringify(output),
  };


  const download: Tool<DownloadInput, object> = {
    manifest: {
      name: "BrowserDownload",
      version: "1.0.0",
      description: "通过统一 Egress Broker 下载到受控 Artifact 目录，不写入任意工作区路径",
      inputSchema: {
        type: "object",
        properties: {
          sessionId: { type: "string" },
          url: { type: "string" },
          maxBytes: { type: "number" },
        },
        required: ["sessionId", "url"],
        additionalProperties: false,
      },
      riskLevel: "browser",
      capabilities: ["browser.navigate", "workspace.write"],
      generated: false,
    },
    validate(value) {
      const record = asRecord(value);
      const rawMax = record.maxBytes ?? 16 * 1024 * 1024;
      if (!Number.isInteger(rawMax) || Number(rawMax) < 1 || Number(rawMax) > 32 * 1024 * 1024) {
        throw new Error("maxBytes 必须是 1~33554432 的整数");
      }
      return {
        sessionId: requireString(record, "sessionId"),
        url: requireString(record, "url"),
        maxBytes: Number(rawMax),
      };
    },
    async inspect(input, context) {
      if (context === undefined) throw new Error("BrowserDownload 检查需要 Tool 上下文");
      const session = dependencies.runtime.get(input.sessionId);
      const prepared = await dependencies.download.prepare(
        session.workspaceId,
        input.url,
        session.networkMode,
        input.maxBytes,
        context.signal,
      );
      preparedDownloads.set(context.toolCallId, prepared);
      return {
        affectedFiles: [],
        certifiedComputerApplication: false,
        requestedCapabilities: [capabilityForMode(session.networkMode)],
        networkTargets: [prepared.lease.hostname],
        reason: `下载 ${prepared.lease.hostname} 到受控 Artifact 目录`,
      };
    },
    permissions: (input, inspection) => toolPermission("browser", [input.url], { sessionId: input.sessionId, url: input.url, networkTargets: inspection.networkTargets ?? [] }),
    async execute(_input, context) {
      const prepared = preparedDownloads.get(context.toolCallId);
      if (prepared === undefined) throw new Error("BrowserDownload 缺少已审核下载授权");
      preparedDownloads.delete(context.toolCallId);
      return dependencies.download.execute(prepared, context.signal);
    },
    releaseInspection(_input, context) {
      const prepared = preparedDownloads.get(context.toolCallId);
      if (prepared !== undefined) {
        dependencies.download.discard(prepared);
        preparedDownloads.delete(context.toolCallId);
      }
    },
    serializeOutput: output => JSON.stringify(output),
  };

  const click: Tool<TargetInput, object> = {
    manifest: {
      name: "BrowserClick",
      version: "1.0.0",
      description: "点击当前 DOM Snapshot 中经过验证的元素，并返回动作后证据",
      inputSchema: targetSchema,
      riskLevel: "browser",
      capabilities: ["browser.interact"],
      generated: false,
    },
    validate: validateTarget,
    inspect: () => ({ affectedFiles: [], certifiedComputerApplication: false, reason: "点击已验证浏览器元素" }),
    permissions: input => toolPermission("browser", [`click:${input.sessionId}:${input.elementId}`], { sessionId: input.sessionId, snapshotId: input.snapshotId, elementId: input.elementId }),
    execute: (input, context) => dependencies.runtime.click(input.sessionId, input, context.signal),
    serializeOutput: output => JSON.stringify(output),
  };

  const type: Tool<TypeInput, object> = {
    manifest: {
      name: "BrowserType",
      version: "1.0.0",
      description: "向当前 DOM Snapshot 中经过验证的元素输入文本，并返回动作后证据",
      inputSchema: {
        type: "object",
        properties: {
          sessionId: { type: "string" },
          snapshotId: { type: "string" },
          elementId: { type: "string" },
          text: { type: "string" },
        },
        required: ["sessionId", "snapshotId", "elementId", "text"],
        additionalProperties: false,
      },
      riskLevel: "browser",
      capabilities: ["browser.interact"],
      generated: false,
    },
    validate(value) {
      const target = validateTarget(value);
      return { ...target, text: requireString(asRecord(value), "text") };
    },
    inspect: () => ({ affectedFiles: [], certifiedComputerApplication: false, reason: "向已验证浏览器元素输入文本" }),
    permissions: input => toolPermission("browser", [`type:${input.sessionId}:${input.elementId}`], { sessionId: input.sessionId, snapshotId: input.snapshotId, elementId: input.elementId }),
    execute: (input, context) => dependencies.runtime.type(input.sessionId, input, input.text, context.signal),
    serializeOutput: output => JSON.stringify(output),
  };

  return [create, navigate, snapshot, screenshot, download, click, type] as readonly Tool<unknown, unknown>[];
}

const sessionSchema = {
  type: "object" as const,
  properties: { sessionId: { type: "string" as const } },
  required: ["sessionId"],
  additionalProperties: false,
};

const targetSchema = {
  type: "object" as const,
  properties: {
    sessionId: { type: "string" as const },
    snapshotId: { type: "string" as const },
    elementId: { type: "string" as const },
  },
  required: ["sessionId", "snapshotId", "elementId"],
  additionalProperties: false,
};

function validateSession(value: unknown): SessionInput {
  const record = asRecord(value);
  return { sessionId: requireString(record, "sessionId") };
}

function validateTarget(value: unknown): TargetInput {
  const record = asRecord(value);
  return {
    sessionId: requireString(record, "sessionId"),
    snapshotId: requireString(record, "snapshotId"),
    elementId: requireString(record, "elementId"),
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("参数必须是对象");
  return value as Record<string, unknown>;
}

function requireString(record: Record<string, unknown>, name: string): string {
  const value = record[name];
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${name} 必须是非空字符串`);
  return value;
}
