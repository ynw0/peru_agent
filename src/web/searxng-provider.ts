import type { PreparedSearchRequest, WebSearchProvider, WebSearchResultItem } from "./types.js";

export interface SearxngProviderOptions {
  readonly endpoint: string;
  readonly language?: string;
  readonly categories?: readonly string[];
}

// SearXNG Provider 只生成请求和解析 JSON；实际联网始终由 Egress Broker 执行。
export class SearxngJsonSearchProvider implements WebSearchProvider {
  public readonly name = "searxng-json";
  private readonly endpoint: URL;
  private readonly language: string;
  private readonly categories: readonly string[];

  public constructor(options: SearxngProviderOptions) {
    this.endpoint = normalizeEndpoint(options.endpoint);
    this.language = validateToken(options.language ?? "all", "language");
    this.categories = (options.categories ?? ["general"]).map(item => validateToken(item, "category"));
    if (this.categories.length === 0 || this.categories.length > 10) {
      throw new Error("SearXNG categories 必须包含 1~10 项");
    }
  }

  public prepare(query: string, maxResults: number): PreparedSearchRequest {
    const url = new URL(this.endpoint);
    url.searchParams.set("q", query);
    url.searchParams.set("format", "json");
    url.searchParams.set("language", this.language);
    url.searchParams.set("categories", this.categories.join(","));
    url.searchParams.set("pageno", "1");
    return {
      url: url.toString(),
      method: "GET",
      headers: {
        accept: "application/json",
        "x-independent-ai-ide-max-results": String(maxResults),
      },
    };
  }

  public parse(body: string, maxResults: number): readonly WebSearchResultItem[] {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch (error: unknown) {
      throw new Error(`SearXNG 返回的 JSON 无效：${error instanceof Error ? error.message : "解析失败"}`);
    }
    if (!isRecord(parsed) || !Array.isArray(parsed.results)) {
      throw new Error("SearXNG 响应缺少 results 数组");
    }
    const results: WebSearchResultItem[] = [];
    for (const [index, raw] of parsed.results.entries()) {
      if (results.length >= maxResults) break;
      if (!isRecord(raw)) throw new Error(`SearXNG 结果 ${index} 不是对象`);
      const title = requireString(raw.title, `results[${index}].title`);
      const url = requireHttpUrl(raw.url, `results[${index}].url`);
      const snippet = requireString(raw.content ?? raw.snippet, `results[${index}].content`);
      results.push({
        title,
        url,
        snippet,
        ...(typeof raw.engine === "string" && raw.engine.trim() !== "" ? { source: raw.engine.trim() } : {}),
      });
    }
    return results;
  }
}

function normalizeEndpoint(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("SearXNG endpoint 只允许 HTTP/HTTPS");
  }
  if (url.username !== "" || url.password !== "") {
    throw new Error("SearXNG endpoint 禁止 URL 内嵌凭据");
  }
  if (url.hash !== "" || url.search !== "") {
    throw new Error("SearXNG endpoint 不允许预置查询参数或 Fragment");
  }
  return url;
}

function validateToken(value: string, label: string): string {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9_-]{1,50}$/.test(normalized)) {
    throw new Error(`SearXNG ${label} 无效`);
  }
  return normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} 必须是非空字符串`);
  return value.trim();
}

function requireHttpUrl(value: unknown, label: string): string {
  const raw = requireString(value, label);
  const url = new URL(raw);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`${label} 协议无效`);
  return url.toString();
}
