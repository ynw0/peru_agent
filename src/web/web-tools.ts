import type { Capability, NetworkMode } from "../agent-protocol.js";
import type { Tool } from "../tool-runtime.js";
import type { PreparedWebFetch, PreparedWebSearch, WebFetchService, WebSearchService } from "./web-services.js";

interface FetchInput { readonly url: string; readonly maxChars: number }
interface SearchInput { readonly query: string; readonly maxResults: number }

export interface WebToolDependencies {
  readonly fetch: WebFetchService;
  readonly search?: WebSearchService;
  readonly getNetworkMode: () => NetworkMode;
}

export function createWebTools(dependencies: WebToolDependencies): readonly Tool<unknown, unknown>[] {
  const preparedFetch = new Map<string, PreparedWebFetch>();
  const preparedSearch = new Map<string, PreparedWebSearch>();

  const fetchTool: Tool<FetchInput, object> = {
    manifest: {
      name: "WebFetch",
      version: "1.0.0",
      description: "通过统一 Egress Broker 抓取经过审核的网页文本",
      inputSchema: {
        type: "object",
        properties: { url: { type: "string" }, maxChars: { type: "number" } },
        required: ["url"],
        additionalProperties: false,
      },
      riskLevel: "network",
      capabilities: [],
      generated: false,
    },
    validate(value) {
      const record = asRecord(value);
      return { url: requireString(record, "url"), maxChars: optionalInteger(record, "maxChars", 50_000, 200_000) };
    },
    async inspect(input, context) {
      if (context === undefined) throw new Error("WebFetch 检查需要 Tool 上下文");
      const mode = dependencies.getNetworkMode();
      const prepared = await dependencies.fetch.prepare(input.url, mode, input.maxChars, context.signal);
      preparedFetch.set(context.toolCallId, prepared);
      return {
        affectedFiles: [],
        certifiedComputerApplication: false,
        requestedCapabilities: [capabilityForMode(mode)],
        networkTargets: [prepared.lease.hostname],
        reason: `抓取 ${prepared.lease.hostname} 的网页文本`,
      };
    },
    async execute(_input, context) {
      const prepared = preparedFetch.get(context.toolCallId);
      if (prepared === undefined) throw new Error("WebFetch 缺少已审核出口授权");
      preparedFetch.delete(context.toolCallId);
      return dependencies.fetch.execute(prepared, context.signal);
    },
    releaseInspection(_input, context) {
      const prepared = preparedFetch.get(context.toolCallId);
      if (prepared !== undefined) {
        dependencies.fetch.discard(prepared);
        preparedFetch.delete(context.toolCallId);
      }
    },
    serializeOutput: output => JSON.stringify(output),
  };

  const searchTool: Tool<SearchInput, object> = {
    manifest: {
      name: "WebSearch",
      version: "1.0.0",
      description: "通过配置的搜索 Provider 和统一 Egress Broker 搜索互联网",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" }, maxResults: { type: "number" } },
        required: ["query"],
        additionalProperties: false,
      },
      riskLevel: "network",
      capabilities: [],
      generated: false,
    },
    validate(value) {
      const record = asRecord(value);
      return { query: requireString(record, "query"), maxResults: optionalInteger(record, "maxResults", 5, 20) };
    },
    async inspect(input, context) {
      if (context === undefined) throw new Error("WebSearch 检查需要 Tool 上下文");
      const mode = dependencies.getNetworkMode();
      if (dependencies.search === undefined) throw new Error("WebSearch Runtime 未配置");
      const prepared = await dependencies.search.prepare(input.query, input.maxResults, mode, context.signal);
      preparedSearch.set(context.toolCallId, prepared);
      return {
        affectedFiles: [],
        certifiedComputerApplication: false,
        requestedCapabilities: [capabilityForMode(mode)],
        networkTargets: [prepared.lease.hostname],
        reason: `使用受控 Provider 搜索：${input.query}`,
      };
    },
    async execute(_input, context) {
      const prepared = preparedSearch.get(context.toolCallId);
      if (prepared === undefined) throw new Error("WebSearch 缺少已审核出口授权");
      preparedSearch.delete(context.toolCallId);
      if (dependencies.search === undefined) throw new Error("WebSearch Runtime 未配置");
      return dependencies.search.execute(prepared, context.signal);
    },
    releaseInspection(_input, context) {
      const prepared = preparedSearch.get(context.toolCallId);
      if (prepared !== undefined) {
        dependencies.search?.discard(prepared);
        preparedSearch.delete(context.toolCallId);
      }
    },
    serializeOutput: output => JSON.stringify(output),
  };

  return dependencies.search === undefined
    ? [fetchTool as Tool<unknown, unknown>]
    : [fetchTool as Tool<unknown, unknown>, searchTool as Tool<unknown, unknown>];
}

export function capabilityForMode(mode: NetworkMode): Capability {
  if (mode === "offline") return "network.loopback";
  if (mode === "lan") return "network.lan";
  return "network.internet";
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

function optionalInteger(record: Record<string, unknown>, name: string, fallback: number, maximum: number): number {
  const value = record[name] ?? fallback;
  if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > maximum) {
    throw new Error(`${name} 必须是 1~${maximum} 的整数`);
  }
  return Number(value);
}
