import { request as httpRequest } from "node:http";

export const BROWSER_PROXY_PROTOCOL_VERSION = 1 as const;

export interface BrowserProxyVerification {
  readonly protocolVersion: typeof BROWSER_PROXY_PROTOCOL_VERSION;
  readonly healthy: true;
  readonly enforcement: "egress-broker";
  readonly serverUrl: string;
}

export interface BrowserProxyVerifier {
  verify(serverUrl: string, signal: AbortSignal): Promise<BrowserProxyVerification>;
}

// 生产环境通过本机健康端点验证代理身份和协议；失败时禁止启动浏览器。
export class HttpBrowserProxyVerifier implements BrowserProxyVerifier {
  public async verify(serverUrl: string, signal: AbortSignal): Promise<BrowserProxyVerification> {
    const base = normalizeProxyUrl(serverUrl);
    const healthUrl = new URL("/.well-known/independent-ai-ide-egress-health", base);
    const body = await requestHealth(healthUrl, signal);
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch (error: unknown) {
      throw new Error(`Browser Proxy 健康响应不是 JSON：${error instanceof Error ? error.message : "解析失败"}`);
    }
    if (!isRecord(parsed)
      || parsed.protocolVersion !== BROWSER_PROXY_PROTOCOL_VERSION
      || parsed.healthy !== true
      || parsed.enforcement !== "egress-broker"
      || parsed.serverUrl !== base.toString()) {
      throw new Error("Browser Proxy 能力握手不匹配");
    }
    return {
      protocolVersion: BROWSER_PROXY_PROTOCOL_VERSION,
      healthy: true,
      enforcement: "egress-broker",
      serverUrl: base.toString(),
    };
  }
}

function requestHealth(url: URL, signal: AbortSignal): Promise<string> {
  if (signal.aborted) return Promise.reject(new Error("Browser Proxy 握手已取消"));
  return new Promise<string>((resolve, reject) => {
    let settled = false;
    const chunks: Uint8Array[] = [];
    let byteLength = 0;
    const finishReject = (error: Error): void => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const hostname = canonicalProxyHostname(url.hostname);
    const resolvedAddress = hostname === "localhost" ? "127.0.0.1" : hostname;
    const request = httpRequest({
      protocol: "http:",
      hostname,
      port: Number(url.port),
      path: url.pathname,
      method: "GET",
      headers: { accept: "application/json" },
      lookup: (_hostname, _options, callback) => callback(null, resolvedAddress, resolvedAddress === "::1" ? 6 : 4),
      timeout: 2_000,
    }, response => {
      response.on("data", chunk => {
        if (settled) return;
        byteLength += chunk.byteLength;
        if (byteLength > 4_096) {
          finishReject(new Error("Browser Proxy 健康响应超过 4096 字节"));
          response.destroy();
          request.destroy();
          return;
        }
        chunks.push(chunk);
      });
      response.on("error", finishReject);
      response.on("end", () => {
        if (settled) return;
        if (response.statusCode !== 200) {
          finishReject(new Error(`Browser Proxy 健康检查失败：HTTP ${String(response.statusCode)}`));
          return;
        }
        settled = true;
        resolve(new TextDecoder().decode(concatenate(chunks, byteLength)));
      });
    });
    request.on("error", finishReject);
    request.on("timeout", () => {
      finishReject(new Error("Browser Proxy 健康检查超时"));
      request.destroy();
    });
    const abort = (): void => {
      finishReject(new Error("Browser Proxy 握手已取消"));
      request.destroy();
    };
    signal.addEventListener("abort", abort, { once: true });
    request.on("close", () => signal.removeEventListener("abort", abort));
    request.end();
  });
}

function normalizeProxyUrl(value: string): URL {
  const url = new URL(value);
  const hostname = canonicalProxyHostname(url.hostname);
  if (url.protocol !== "http:" || (hostname !== "127.0.0.1" && hostname !== "::1" && hostname !== "localhost")) {
    throw new Error("Browser Proxy 必须是本机 HTTP 地址");
  }
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "" || url.pathname !== "/") {
    throw new Error("Browser Proxy URL 不能包含凭据、路径、查询或 Fragment");
  }
  if (url.port === "") throw new Error("Browser Proxy 必须声明端口");
  return url;
}

function canonicalProxyHostname(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1).toLowerCase()
    : hostname.toLowerCase();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function concatenate(chunks: readonly Uint8Array[], length: number): Uint8Array {
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}
