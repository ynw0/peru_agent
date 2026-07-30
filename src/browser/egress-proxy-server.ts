import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { connect, type Socket } from "node:net";
import type { Duplex } from "node:stream";
import type { IdGenerator } from "../agent/id-generator.js";
import type { NetworkMode } from "../agent-protocol.js";
import { EgressBroker } from "../egress/broker.js";
import { BROWSER_PROXY_PROTOCOL_VERSION } from "./proxy-verifier.js";

const MAX_PROXY_BODY_BYTES = 16 * 1024 * 1024;
const HOP_BY_HOP_HEADERS = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"]);

export interface BrowserEgressProxyServerOptions {
  readonly getNetworkMode: () => NetworkMode;
}

// Browser 只连接此本机代理；HTTP 请求和 HTTPS CONNECT 均先经过 EgressBroker 的
// DNS、地址策略和一次性 Lease。代理不接受凭据，也不监听局域网地址。
export class BrowserEgressProxyServer {
  private server: Server | undefined;
  private readonly sockets = new Set<Socket>();
  private serverUrl: string | undefined;

  public constructor(
    private readonly broker: EgressBroker,
    private readonly ids: IdGenerator,
    private readonly options: BrowserEgressProxyServerOptions,
  ) {}

  public async start(): Promise<string> {
    if (this.serverUrl !== undefined) return this.serverUrl;
    const server = createServer((request, response) => { void this.handleRequest(request, response); });
    server.on("connection", socket => {
      this.sockets.add(socket);
      socket.once("close", () => this.sockets.delete(socket));
    });
    server.on("connect", (request, clientSocket, head) => { void this.handleConnect(request, clientSocket, head); });
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => { server.removeListener("listening", onListening); reject(error); };
      const onListening = (): void => { server.removeListener("error", onError); resolve(); };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen({ host: "127.0.0.1", port: 0 });
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
      server.close();
      throw new Error("Browser Egress Proxy 未返回本地端口");
    }
    this.server = server;
    this.serverUrl = `http://127.0.0.1:${address.port}/`;
    return this.serverUrl;
  }

  public async stop(): Promise<void> {
    this.serverUrl = undefined;
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    const server = this.server;
    this.server = undefined;
    if (server === undefined) return;
    await new Promise<void>(resolve => server.close(() => resolve()));
  }

  public getUrl(): string | undefined { return this.serverUrl; }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.headers["proxy-authorization"] !== undefined) {
      response.writeHead(407, { "content-type": "text/plain; charset=utf-8" });
      response.end("Proxy credentials are not accepted");
      return;
    }
    const rawUrl = request.url ?? "";
    if (rawUrl === "/.well-known/independent-ai-ide-egress-health" || rawUrl === "/__independent_ai_ide_proxy_capabilities") {
      const body = JSON.stringify({
        protocolVersion: BROWSER_PROXY_PROTOCOL_VERSION,
        ...(rawUrl === "/.well-known/independent-ai-ide-egress-health" ? { healthy: true } : {}),
        enforcement: "egress-broker",
        serverUrl: this.serverUrl,
      });
      response.writeHead(200, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body) });
      response.end(body);
      return;
    }
    let url: URL;
    try {
      url = new URL(rawUrl, `http://${request.headers.host ?? "127.0.0.1"}`);
    } catch {
      response.writeHead(400); response.end("Invalid proxy URL"); return;
    }
    const method = request.method === "HEAD" ? "HEAD" : request.method === "POST" ? "POST" : "GET";
    const controller = new AbortController();
    request.once("close", () => controller.abort());
    try {
      const lease = await this.broker.authorize({ url: url.toString(), mode: this.options.getNetworkMode(), purpose: "browser.resource", method }, controller.signal);
      const body = await readBody(request, MAX_PROXY_BODY_BYTES, controller.signal);
      const result = await this.broker.fetchAuthorized(lease.id, {
        url: lease.normalizedUrl,
        mode: lease.mode,
        purpose: lease.purpose,
        method: lease.method,
        headers: copyRequestHeaders(request.headers),
        ...(body === undefined ? {} : { body }),
        maxResponseBytes: MAX_PROXY_BODY_BYTES,
      }, controller.signal);
      const headers = filterResponseHeaders(result.headers);
      headers["content-length"] = String(result.body.byteLength);
      response.writeHead(result.status, headers);
      response.end(result.body);
    } catch (error: unknown) {
      if (!response.headersSent) response.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
      response.end(error instanceof Error ? error.message : "Proxy request failed");
    }
  }

  private async handleConnect(request: IncomingMessage, clientSocket: Duplex, head: Buffer): Promise<void> {
    if (request.headers["proxy-authorization"] !== undefined) {
      clientSocket.end("HTTP/1.1 407 Proxy Authentication Required\r\n\r\n");
      return;
    }
    const target = request.url ?? "";
    let url: URL;
    try { url = new URL(`https://${target}`); } catch { clientSocket.end("HTTP/1.1 400 Bad Request\r\n\r\n"); return; }
    if (url.pathname !== "/" || url.search !== "" || url.hash !== "") {
      clientSocket.end("HTTP/1.1 400 Bad Request\r\n\r\n"); return;
    }
    const controller = new AbortController();
    clientSocket.once("close", () => controller.abort());
    try {
      const lease = await this.broker.authorize({
        url: url.toString(),
        mode: this.options.getNetworkMode(),
        purpose: "browser.resource",
        method: "GET",
      }, controller.signal);
      const tunnelLease = this.broker.consumeAuthorizationForTunnel(lease.id, {
        url: lease.normalizedUrl,
        mode: lease.mode,
        purpose: lease.purpose,
        method: "GET",
      });
      const targetSocket = connect({
        host: tunnelLease.selectedAddress.address,
        port: tunnelLease.port,
        family: tunnelLease.selectedAddress.family,
      });
      targetSocket.once("error", error => clientSocket.end(`HTTP/1.1 502 Bad Gateway\r\n\r\n${error.message}`));
      targetSocket.once("connect", () => {
        clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length > 0) targetSocket.write(head);
        targetSocket.pipe(clientSocket);
        clientSocket.pipe(targetSocket);
      });
      clientSocket.once("close", () => targetSocket.destroy());
      targetSocket.once("close", () => clientSocket.destroy());
    } catch (error: unknown) {
      clientSocket.end(`HTTP/1.1 502 Bad Gateway\r\n\r\n${error instanceof Error ? error.message : "Proxy CONNECT failed"}`);
    }
  }
}

async function readBody(request: IncomingMessage, maximum: number, signal: AbortSignal): Promise<string | undefined> {
  if (request.method !== "POST" && request.method !== "PUT" && request.method !== "PATCH") return undefined;
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    if (signal.aborted) throw new Error("Proxy 请求已取消");
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.byteLength;
    if (length > maximum) throw new Error(`Proxy 请求体超过 ${maximum} 字节`);
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function copyRequestHeaders(headers: IncomingMessage["headers"]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (HOP_BY_HOP_HEADERS.has(name.toLowerCase()) || value === undefined) continue;
    result[name] = Array.isArray(value) ? value.join(", ") : value;
  }
  return result;
}

function filterResponseHeaders(headers: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !HOP_BY_HOP_HEADERS.has(name.toLowerCase())));
}
