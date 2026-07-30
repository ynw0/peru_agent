export const RUNTIME_PROTOCOL_VERSION = 1 as const;
export const RUNTIME_PRODUCT_VERSION = "0.13.0" as const;
export const RUNTIME_MAX_MESSAGE_BYTES = 8 * 1024 * 1024;

export interface RuntimeRequest {
  readonly version: typeof RUNTIME_PROTOCOL_VERSION;
  readonly productVersion?: string;
  readonly type: "request";
  readonly id: string;
  readonly command: string;
  readonly arguments?: unknown;
}

export interface RuntimeResponse {
  readonly version: typeof RUNTIME_PROTOCOL_VERSION;
  readonly productVersion: typeof RUNTIME_PRODUCT_VERSION;
  readonly type: "response";
  readonly id: string;
  readonly ok: boolean;
  readonly result?: unknown;
  readonly error?: { readonly code: string; readonly message: string };
}

export interface RuntimeEvent {
  readonly version: typeof RUNTIME_PROTOCOL_VERSION;
  readonly productVersion: typeof RUNTIME_PRODUCT_VERSION;
  readonly type: "event";
  readonly event: string;
  readonly data?: unknown;
}

export type RuntimeMessage = RuntimeResponse | RuntimeEvent;

export class RuntimeProtocolError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "RuntimeProtocolError";
  }
}

export class RuntimeNdjsonCodec {
  private readonly activeRequestIds = new Set<string>();

  public parseRequest(line: string): RuntimeRequest {
    const bytes = new TextEncoder().encode(line).byteLength;
    if (bytes > RUNTIME_MAX_MESSAGE_BYTES) {
      throw new RuntimeProtocolError("MESSAGE_TOO_LARGE", "Runtime IPC 消息超过最大长度");
    }
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (error: unknown) {
      throw new RuntimeProtocolError("INVALID_JSON", `Runtime IPC 收到非法 JSON：${error instanceof Error ? error.message : "解析失败"}`);
    }
    if (!isRecord(value)
      || value.type !== "request"
      || value.version !== RUNTIME_PROTOCOL_VERSION
      || typeof value.id !== "string"
      || !/^[A-Za-z0-9._:-]{1,200}$/.test(value.id)
      || typeof value.command !== "string"
      || value.command.trim() === "") {
      throw new RuntimeProtocolError("INVALID_REQUEST", "Runtime IPC 请求结构无效或协议版本不匹配");
    }
    if (value.productVersion !== undefined && value.productVersion !== RUNTIME_PRODUCT_VERSION) {
      throw new RuntimeProtocolError("PRODUCT_VERSION_MISMATCH", `Runtime 产品版本不匹配：${String(value.productVersion)}`);
    }
    const id = value.id;
    if (this.activeRequestIds.has(id)) {
      throw new RuntimeProtocolError("DUPLICATE_REQUEST_ID", `Runtime IPC 请求 ID 重复：${id}`);
    }
    this.activeRequestIds.add(id);
    const request: RuntimeRequest = {
      version: RUNTIME_PROTOCOL_VERSION,
      ...(typeof value.productVersion === "string" ? { productVersion: value.productVersion } : {}),
      type: "request",
      id,
      command: value.command,
      ...(Object.prototype.hasOwnProperty.call(value, "arguments") ? { arguments: value.arguments } : {}),
    };
    return request;
  }

  public completeRequest(id: string): void {
    this.activeRequestIds.delete(id);
  }

  public encodeResponse(response: Omit<RuntimeResponse, "version" | "productVersion">): string {
    return this.encode({ version: RUNTIME_PROTOCOL_VERSION, productVersion: RUNTIME_PRODUCT_VERSION, ...response });
  }

  public encodeEvent(event: Omit<RuntimeEvent, "version" | "productVersion">): string {
    return this.encode({ version: RUNTIME_PROTOCOL_VERSION, productVersion: RUNTIME_PRODUCT_VERSION, ...event });
  }

  private encode(message: RuntimeMessage): string {
    const line = JSON.stringify(message);
    if (new TextEncoder().encode(line).byteLength > RUNTIME_MAX_MESSAGE_BYTES) {
      throw new RuntimeProtocolError("MESSAGE_TOO_LARGE", "Runtime IPC 输出超过最大长度");
    }
    return `${line}\n`;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
