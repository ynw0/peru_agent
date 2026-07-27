import type { NetworkMode } from "../agent-protocol.js";
import type { EgressAuthorizationLease } from "../egress/types.js";
import { EgressBroker } from "../egress/broker.js";
import { decodeTextBody, extractReadableText } from "./content-extractor.js";
import type {
  PreparedSearchRequest,
  WebFetchResult,
  WebSearchProvider,
  WebSearchResult,
} from "./types.js";

export interface PreparedWebFetch {
  readonly lease: EgressAuthorizationLease;
  readonly url: string;
  readonly mode: NetworkMode;
  readonly maxChars: number;
}

export interface PreparedWebSearch {
  readonly lease: EgressAuthorizationLease;
  readonly query: string;
  readonly maxResults: number;
  readonly mode: NetworkMode;
  readonly request: PreparedSearchRequest;
}

export class WebFetchService {
  public constructor(private readonly broker: EgressBroker) {}

  public async prepare(url: string, mode: NetworkMode, maxChars: number, signal: AbortSignal): Promise<PreparedWebFetch> {
    validateMaxChars(maxChars);
    const lease = await this.broker.authorize({ url, mode, purpose: "web.fetch", method: "GET" }, signal);
    return { lease, url: lease.normalizedUrl, mode, maxChars };
  }

  public discard(prepared: PreparedWebFetch): void {
    this.broker.discardAuthorization(prepared.lease.id);
  }

  public async execute(prepared: PreparedWebFetch, signal: AbortSignal): Promise<WebFetchResult> {
    const response = await this.broker.fetchAuthorized(prepared.lease.id, {
      url: prepared.url,
      mode: prepared.mode,
      purpose: "web.fetch",
      method: "GET",
      headers: { accept: "text/html, text/plain, application/json, application/xml;q=0.9" },
      maxResponseBytes: Math.min(8 * 1024 * 1024, prepared.maxChars * 8),
    }, signal);
    const contentType = response.headers["content-type"] ?? response.headers["Content-Type"] ?? "application/octet-stream";
    if (!isReadableContentType(contentType)) {
      throw new Error(`WebFetch 拒绝非文本响应：${contentType}`);
    }
    const decoded = decodeTextBody(response.body, contentType);
    const extracted = extractReadableText(decoded, contentType);
    const truncated = extracted.text.length > prepared.maxChars;
    return {
      url: response.finalUrl,
      status: response.status,
      contentType,
      ...(extracted.title === undefined ? {} : { title: extracted.title }),
      text: truncated ? extracted.text.slice(0, prepared.maxChars) : extracted.text,
      truncated,
      byteLength: response.byteLength,
      redirects: response.redirects,
    };
  }
}

export class WebSearchService {
  public constructor(
    private readonly broker: EgressBroker,
    private readonly provider: WebSearchProvider,
  ) {}

  public async prepare(query: string, maxResults: number, mode: NetworkMode, signal: AbortSignal): Promise<PreparedWebSearch> {
    if (query.trim() === "" || query.length > 500) {
      throw new Error("搜索词必须是 1~500 个字符");
    }
    if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > 20) {
      throw new Error("maxResults 必须是 1~20 的整数");
    }
    const request = await this.provider.prepare(query, maxResults);
    const lease = await this.broker.authorize({
      url: request.url,
      mode,
      purpose: "web.search",
      method: request.method,
    }, signal);
    return { lease, query, maxResults, mode, request: { ...request, url: lease.normalizedUrl } };
  }

  public discard(prepared: PreparedWebSearch): void {
    this.broker.discardAuthorization(prepared.lease.id);
  }

  public async execute(prepared: PreparedWebSearch, signal: AbortSignal): Promise<WebSearchResult> {
    const response = await this.broker.fetchAuthorized(prepared.lease.id, {
      url: prepared.request.url,
      mode: prepared.mode,
      purpose: "web.search",
      method: prepared.request.method,
      headers: prepared.request.headers,
      ...(prepared.request.body === undefined ? {} : { body: prepared.request.body }),
      maxResponseBytes: 2 * 1024 * 1024,
    }, signal);
    const contentType = response.headers["content-type"] ?? "application/json";
    const body = decodeTextBody(response.body, contentType);
    const results = this.provider.parse(body, prepared.maxResults);
    validateSearchResults(results, prepared.maxResults);
    return { query: prepared.query, provider: this.provider.name, results };
  }
}

function validateSearchResults(results: readonly { title: string; url: string; snippet: string }[], maximum: number): void {
  if (results.length > maximum) {
    throw new Error("搜索 Provider 返回结果数量超过请求限制");
  }
  for (const [index, result] of results.entries()) {
    if (result.title.trim() === "" || result.snippet.trim() === "") {
      throw new Error(`搜索结果 ${index} 缺少标题或摘要`);
    }
    const url = new URL(result.url);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error(`搜索结果 ${index} URL 协议无效`);
    }
  }
}

function validateMaxChars(maxChars: number): void {
  if (!Number.isInteger(maxChars) || maxChars < 1 || maxChars > 200_000) {
    throw new Error("maxChars 必须是 1~200000 的整数");
  }
}

function isReadableContentType(value: string): boolean {
  const normalized = value.toLowerCase();
  return normalized.startsWith("text/")
    || normalized.includes("application/json")
    || normalized.includes("application/xml")
    || normalized.includes("application/xhtml+xml")
    || normalized.includes("application/javascript");
}
