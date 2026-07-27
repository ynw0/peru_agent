import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { PinnedHttpRequest, PinnedHttpResponse, PinnedHttpTransport } from "./types.js";

export class NodePinnedHttpTransport implements PinnedHttpTransport {
  public request(request: PinnedHttpRequest, signal: AbortSignal): Promise<PinnedHttpResponse> {
    const url = new URL(request.url);
    const createRequest = url.protocol === "https:" ? httpsRequest : httpRequest;
    return new Promise<PinnedHttpResponse>((resolve, reject) => {
      let settled = false;
      const finishReject = (error: Error): void => {
        if (settled) return;
        settled = true;
        reject(error);
      };
      const clientRequest = createRequest({
        protocol: url.protocol,
        hostname: request.hostname,
        port: request.port,
        path: `${url.pathname}${url.search}`,
        method: request.method,
        headers: request.headers,
        servername: request.hostname,
        lookup: (_hostname, _options, callback) => callback(null, request.selectedAddress, request.family),
        timeout: request.timeoutMs,
      }, response => {
        const chunks: Uint8Array[] = [];
        let byteLength = 0;
        response.on("data", (chunk: Uint8Array) => {
          if (settled) return;
          byteLength += chunk.byteLength;
          if (byteLength > request.maxResponseBytes) {
            finishReject(new Error(`响应超过限制 ${request.maxResponseBytes} 字节`));
            response.destroy();
            clientRequest.destroy();
            return;
          }
          chunks.push(chunk);
        });
        response.on("error", finishReject);
        response.on("end", () => {
          if (settled) return;
          settled = true;
          const body = concatenate(chunks, byteLength);
          const headers: Record<string, string> = {};
          for (const [name, value] of Object.entries(response.headers)) {
            if (typeof value === "string") headers[name] = value;
            else if (Array.isArray(value)) headers[name] = value.join(", ");
          }
          resolve({ status: response.statusCode ?? 0, headers, body });
        });
      });
      clientRequest.on("error", finishReject);
      clientRequest.on("timeout", () => {
        finishReject(new Error(`出口请求超时：${request.timeoutMs}ms`));
        clientRequest.destroy();
      });
      const abort = (): void => {
        finishReject(new Error("出口请求已取消"));
        clientRequest.destroy();
      };
      signal.addEventListener("abort", abort, { once: true });
      clientRequest.on("close", () => signal.removeEventListener("abort", abort));
      if (request.body !== undefined) {
        clientRequest.write(request.body, "utf8");
      }
      clientRequest.end();
    });
  }
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
