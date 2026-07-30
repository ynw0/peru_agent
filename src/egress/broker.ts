import { createHash } from "node:crypto";
import type { IdGenerator } from "../agent/id-generator.js";
import { assertAddressesAllowed, classifyNetworkAddress } from "./address-policy.js";
import type {
  EgressAuditEntry,
  EgressAuditStore,
  EgressAuthorizationLease,
  EgressAuthorizationRequest,
  EgressFetchRequest,
  EgressFetchResponse,
  EgressRedirectHop,
  EgressResolver,
  PinnedHttpTransport,
} from "./types.js";

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const FORBIDDEN_REQUEST_HEADERS = new Set([
  "connection",
  "content-length",
  "host",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);
const SENSITIVE_HEADERS = new Set(["authorization", "cookie", "proxy-authorization"]);

export interface EgressBrokerOptions {
  readonly allowedPorts: readonly number[];
  readonly authorizationTtlMs: number;
  readonly defaultTimeoutMs: number;
  readonly defaultMaxResponseBytes: number;
  readonly defaultMaxRedirects: number;
  readonly maxRequestBodyBytes: number;
}

const DEFAULT_OPTIONS: EgressBrokerOptions = {
  allowedPorts: [80, 443],
  authorizationTtlMs: 60_000,
  defaultTimeoutMs: 20_000,
  defaultMaxResponseBytes: 2 * 1024 * 1024,
  defaultMaxRedirects: 5,
  maxRequestBodyBytes: 256 * 1024,
};

export class EgressBroker {
  private readonly leases = new Map<string, EgressAuthorizationLease>();
  private readonly allowedPorts: ReadonlySet<number>;
  private readonly options: EgressBrokerOptions;

  public constructor(
    private readonly resolver: EgressResolver,
    private readonly transport: PinnedHttpTransport,
    private readonly audit: EgressAuditStore,
    private readonly ids: IdGenerator,
    options: Partial<EgressBrokerOptions> = {},
  ) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
    validateOptions(this.options);
    this.allowedPorts = new Set(this.options.allowedPorts);
  }

  public async authorize(
    request: EgressAuthorizationRequest,
    signal: AbortSignal,
  ): Promise<EgressAuthorizationLease> {
    const auditId = this.ids.next("egress-audit");
    let normalized: URL | undefined;
    try {
      normalized = normalizeEgressUrl(request.url, this.allowedPorts);
      const hostname = canonicalHostname(normalized.hostname);
      const resolved = await this.resolver.resolve(hostname, signal);
      const addresses = resolved.map(record => classifyNetworkAddress(record.address));
      assertAddressesAllowed(request.mode, addresses);
      const now = Date.now();
      const lease: EgressAuthorizationLease = {
        id: this.ids.next("egress-lease"),
        normalizedUrl: normalized.toString(),
        urlSha256: sha256(normalized.toString()),
        hostname,
        port: Number(normalized.port || (normalized.protocol === "https:" ? 443 : 80)),
        addresses,
        selectedAddress: addresses[0]!,
        mode: request.mode,
        purpose: request.purpose,
        method: request.method ?? "GET",
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + this.options.authorizationTtlMs).toISOString(),
      };
      this.leases.set(lease.id, lease);
      await this.audit.append(this.auditEntry(auditId, lease, "allowed", "URL、DNS 和网络模式校验通过"));
      return structuredClone(lease);
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : "未知出口授权错误";
      const fallbackUrl = normalized ?? safeParseUrl(request.url);
      await this.audit.append({
        id: auditId,
        timestamp: new Date().toISOString(),
        purpose: request.purpose,
        mode: request.mode,
        method: request.method ?? "GET",
        redactedUrl: fallbackUrl === undefined ? "invalid-url" : redactUrl(fallbackUrl),
        hostname: fallbackUrl?.hostname ?? "invalid-host",
        port: fallbackUrl === undefined ? 0 : Number(fallbackUrl.port || (fallbackUrl.protocol === "https:" ? 443 : 80)),
        addresses: [],
        decision: "denied",
        reason,
      });
      throw error;
    }
  }

  public discardAuthorization(leaseId: string): boolean {
    return this.leases.delete(leaseId);
  }

  // Browser Proxy 的 CONNECT 隧道没有完整 HTTP 响应，仍必须消费一次已审核
  // Lease，并返回固定 DNS 地址；调用方不能重新解析原始主机名。
  public consumeAuthorizationForTunnel(
    leaseId: string,
    request: EgressAuthorizationRequest,
  ): EgressAuthorizationLease {
    return structuredClone(this.consumeLease(leaseId, request));
  }

  public async fetchAuthorized(
    leaseId: string,
    request: EgressFetchRequest,
    signal: AbortSignal,
  ): Promise<EgressFetchResponse> {
    const initial = this.consumeLease(leaseId, request);
    const maxResponseBytes = boundedPositiveInteger(
      request.maxResponseBytes,
      this.options.defaultMaxResponseBytes,
      32 * 1024 * 1024,
      "maxResponseBytes",
    );
    const timeoutMs = boundedPositiveInteger(request.timeoutMs, this.options.defaultTimeoutMs, 120_000, "timeoutMs");
    const maxRedirects = boundedNonNegativeInteger(
      request.maxRedirects,
      this.options.defaultMaxRedirects,
      10,
      "maxRedirects",
    );
    const bodyBytes = request.body === undefined ? 0 : new TextEncoder().encode(request.body).byteLength;
    if (bodyBytes > this.options.maxRequestBodyBytes) {
      throw new Error(`请求体超过限制 ${this.options.maxRequestBodyBytes} 字节`);
    }

    let lease = initial;
    let method = initial.method;
    let body = request.body;
    let headers = sanitizeHeaders(request.headers ?? {});
    const redirects: EgressRedirectHop[] = [];
    const requestId = this.ids.next("egress-request");

    while (true) {
      if (signal.aborted) {
        throw new Error("出口请求已取消");
      }
      let response;
      try {
        response = await this.transport.request({
          requestId,
          url: lease.normalizedUrl,
          hostname: lease.hostname,
          port: lease.port,
          selectedAddress: lease.selectedAddress.address,
          family: lease.selectedAddress.family,
          method,
          headers: {
            "accept-encoding": "identity",
            "user-agent": "Independent-AI-IDE-Egress/1.0",
            ...headers,
          },
          ...(body === undefined ? {} : { body }),
          maxResponseBytes,
          timeoutMs,
        }, signal);
      } catch (error: unknown) {
        await this.audit.append(this.auditEntry(
          this.ids.next("egress-audit"),
          lease,
          "failed",
          error instanceof Error ? error.message : "未知传输错误",
        ));
        throw error;
      }

      if (!REDIRECT_STATUSES.has(response.status)) {
        await this.audit.append({
          ...this.auditEntry(this.ids.next("egress-audit"), lease, "completed", "出口请求完成"),
          status: response.status,
          byteLength: response.body.byteLength,
        });
        return {
          requestId,
          finalUrl: lease.normalizedUrl,
          status: response.status,
          headers: response.headers,
          body: response.body,
          byteLength: response.body.byteLength,
          redirects,
        };
      }

      const location = findHeader(response.headers, "location");
      if (location === undefined) {
        throw new Error(`HTTP ${response.status} 缺少 Location`);
      }
      if (redirects.length >= maxRedirects) {
        throw new Error(`重定向超过限制 ${maxRedirects}`);
      }
      const nextUrl = new URL(location, lease.normalizedUrl).toString();
      const nextMethod = response.status === 303 || ((response.status === 301 || response.status === 302) && method === "POST")
        ? "GET"
        : method;
      const next = await this.authorize({
        url: nextUrl,
        mode: lease.mode,
        purpose: lease.purpose,
        method: nextMethod,
      }, signal);
      this.discardAuthorization(next.id);
      redirects.push({ fromUrl: lease.normalizedUrl, toUrl: next.normalizedUrl, status: response.status });
      if (new URL(lease.normalizedUrl).origin !== new URL(next.normalizedUrl).origin) {
        headers = removeSensitiveHeaders(headers);
      }
      if (nextMethod === "GET") {
        body = undefined;
        headers = removeEntityHeaders(headers);
      }
      lease = next;
      method = nextMethod;
    }
  }

  public async listAudit(): Promise<readonly EgressAuditEntry[]> {
    return this.audit.list();
  }

  private consumeLease(leaseId: string, request: EgressFetchRequest): EgressAuthorizationLease {
    const lease = this.leases.get(leaseId);
    this.leases.delete(leaseId);
    if (lease === undefined) {
      throw new Error(`出口授权不存在或已经使用：${leaseId}`);
    }
    if (Date.parse(lease.expiresAt) <= Date.now()) {
      throw new Error(`出口授权已过期：${leaseId}`);
    }
    const normalized = normalizeEgressUrl(request.url, this.allowedPorts).toString();
    if (sha256(normalized) !== lease.urlSha256
      || request.mode !== lease.mode
      || request.purpose !== lease.purpose
      || (request.method ?? "GET") !== lease.method) {
      throw new Error("出口请求与已审核授权不一致");
    }
    return lease;
  }

  private auditEntry(
    id: string,
    lease: EgressAuthorizationLease,
    decision: EgressAuditEntry["decision"],
    reason: string,
  ): EgressAuditEntry {
    return {
      id,
      timestamp: new Date().toISOString(),
      purpose: lease.purpose,
      mode: lease.mode,
      method: lease.method,
      redactedUrl: redactUrl(new URL(lease.normalizedUrl)),
      hostname: lease.hostname,
      port: lease.port,
      addresses: lease.addresses.map(address => address.address),
      selectedAddress: lease.selectedAddress.address,
      decision,
      reason,
    };
  }
}

export function normalizeEgressUrl(raw: string, allowedPorts: ReadonlySet<number>): URL {
  if (raw.trim() === "") {
    throw new Error("URL 不能为空");
  }
  const url = new URL(raw);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`只允许 http/https：${url.protocol}`);
  }
  if (url.username !== "" || url.password !== "") {
    throw new Error("URL 不允许包含用户名或密码");
  }
  if (url.hash !== "") {
    url.hash = "";
  }
  url.hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  const hostname = canonicalHostname(url.hostname);
  if (hostname === "" || hostname.includes("%")) {
    throw new Error("URL 主机名无效");
  }
  const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  if (!Number.isInteger(port) || port <= 0 || port > 65_535 || !allowedPorts.has(port)) {
    throw new Error(`端口不在出口白名单：${port}`);
  }
  return url;
}

function canonicalHostname(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

function validateOptions(options: EgressBrokerOptions): void {
  if (options.allowedPorts.length === 0 || options.allowedPorts.some(port => !Number.isInteger(port) || port <= 0 || port > 65_535)) {
    throw new Error("allowedPorts 必须包含有效端口");
  }
  boundedPositiveInteger(options.authorizationTtlMs, options.authorizationTtlMs, 10 * 60_000, "authorizationTtlMs");
  boundedPositiveInteger(options.defaultTimeoutMs, options.defaultTimeoutMs, 120_000, "defaultTimeoutMs");
  boundedPositiveInteger(options.defaultMaxResponseBytes, options.defaultMaxResponseBytes, 32 * 1024 * 1024, "defaultMaxResponseBytes");
  boundedNonNegativeInteger(options.defaultMaxRedirects, options.defaultMaxRedirects, 10, "defaultMaxRedirects");
  boundedPositiveInteger(options.maxRequestBodyBytes, options.maxRequestBodyBytes, 4 * 1024 * 1024, "maxRequestBodyBytes");
}

function sanitizeHeaders(headers: Readonly<Record<string, string>>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const normalized = name.toLowerCase().trim();
    if (normalized === "" || FORBIDDEN_REQUEST_HEADERS.has(normalized)) {
      throw new Error(`禁止请求头：${name}`);
    }
    if (/[^a-z0-9!#$%&'*+.^_`|~-]/.test(normalized) || /[\r\n]/.test(value)) {
      throw new Error(`请求头无效：${name}`);
    }
    result[normalized] = value;
  }
  return result;
}

function removeSensitiveHeaders(headers: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !SENSITIVE_HEADERS.has(name.toLowerCase())));
}

function removeEntityHeaders(headers: Readonly<Record<string, string>>): Record<string, string> {
  const denied = new Set(["content-type", "content-encoding"]);
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !denied.has(name.toLowerCase())));
}

function findHeader(headers: Readonly<Record<string, string>>, name: string): string | undefined {
  const normalized = name.toLowerCase();
  return Object.entries(headers).find(([key]) => key.toLowerCase() === normalized)?.[1];
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function redactUrl(url: URL): string {
  return `${url.protocol}//${url.host}${url.pathname}`;
}

function safeParseUrl(raw: string): URL | undefined {
  try {
    return new URL(raw);
  } catch {
    return undefined;
  }
}

function boundedPositiveInteger(value: number | undefined, fallback: number, maximum: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved <= 0 || resolved > maximum) {
    throw new Error(`${name} 必须是 1~${maximum} 的整数`);
  }
  return resolved;
}

function boundedNonNegativeInteger(value: number | undefined, fallback: number, maximum: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 0 || resolved > maximum) {
    throw new Error(`${name} 必须是 0~${maximum} 的整数`);
  }
  return resolved;
}
