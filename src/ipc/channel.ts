import { IpcError } from "./errors.js";
import type {
  IpcEventMap,
  IpcEventMethod,
  IpcMessage,
  IpcRequestMap,
  IpcRequestMethod,
  IpcRequestMessage,
  IpcResponseMessage,
} from "./protocol.js";
import type { Disposable, IpcTransport } from "./transport.js";
import { isIpcMessage, isResponseResult } from "./validation.js";

type RequestHandler<Method extends IpcRequestMethod> = (
  params: IpcRequestMap[Method]["params"],
) => Promise<IpcRequestMap[Method]["result"]> | IpcRequestMap[Method]["result"];

interface PendingRequest {
  readonly method: IpcRequestMethod;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timeoutHandle: ReturnType<typeof setTimeout>;
  readonly abortCleanup?: () => void;
}

export interface RequestOptions {
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

// Client 负责请求配对、超时、中止和事件订阅。
export class TypedIpcClient {
  private nextRequestId = 1;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly eventListeners = new Map<IpcEventMethod, Set<(payload: unknown) => void>>();
  private readonly transportSubscription: Disposable;

  public constructor(private readonly transport: IpcTransport) {
    this.transportSubscription = transport.onMessage(message => this.handleMessage(message));
  }

  public request<Method extends IpcRequestMethod>(
    method: Method,
    params: IpcRequestMap[Method]["params"],
    options: RequestOptions = { timeoutMs: DEFAULT_REQUEST_TIMEOUT_MS },
  ): Promise<IpcRequestMap[Method]["result"]> {
    if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
      throw new Error("IPC 请求超时时间必须大于 0");
    }
    if (options.signal?.aborted) {
      return Promise.reject(new IpcError("REQUEST_ABORTED", "IPC 请求在发送前已被取消"));
    }

    const id = `request-${this.nextRequestId++}`;
    const message = { kind: "request", id, method, params } as IpcRequestMessage;

    return new Promise<IpcRequestMap[Method]["result"]>((resolve, reject) => {
      const timeoutHandle = setTimeout(() => {
        const pending = this.pending.get(id);
        pending?.abortCleanup?.();
        this.pending.delete(id);
        reject(new IpcError("REQUEST_TIMEOUT", `IPC 请求超时：${method}`));
      }, options.timeoutMs);

      const abortListener = (): void => {
        const pending = this.pending.get(id);
        if (pending === undefined) {
          return;
        }
        clearTimeout(pending.timeoutHandle);
        this.pending.delete(id);
        reject(new IpcError("REQUEST_ABORTED", `IPC 请求已取消：${method}`));
      };

      options.signal?.addEventListener("abort", abortListener, { once: true });
      this.pending.set(id, {
        method,
        resolve: value => resolve(value as IpcRequestMap[Method]["result"]),
        reject,
        timeoutHandle,
        ...(options.signal === undefined
          ? {}
          : { abortCleanup: () => options.signal?.removeEventListener("abort", abortListener) }),
      });

      this.transport.send(message);
    });
  }

  public onEvent<Method extends IpcEventMethod>(
    method: Method,
    listener: (payload: IpcEventMap[Method]) => void,
  ): Disposable {
    const listeners = this.eventListeners.get(method) ?? new Set<(payload: unknown) => void>();
    listeners.add(listener as (payload: unknown) => void);
    this.eventListeners.set(method, listeners);

    return {
      dispose: () => {
        listeners.delete(listener as (payload: unknown) => void);
        if (listeners.size === 0) {
          this.eventListeners.delete(method);
        }
      },
    };
  }

  public dispose(): void {
    this.transportSubscription.dispose();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeoutHandle);
      pending.abortCleanup?.();
      pending.reject(new IpcError("REQUEST_ABORTED", "IPC Client 已关闭"));
    }
    this.pending.clear();
    this.eventListeners.clear();
  }

  private handleMessage(value: unknown): void {
    if (!isIpcMessage(value)) {
      return;
    }

    if (value.kind === "response") {
      this.handleResponse(value);
      return;
    }

    if (value.kind === "event") {
      for (const listener of this.eventListeners.get(value.method) ?? []) {
        listener(value.payload);
      }
    }
  }

  private handleResponse(message: IpcResponseMessage): void {
    const pending = this.pending.get(message.id);
    if (pending === undefined) {
      return;
    }

    clearTimeout(pending.timeoutHandle);
    pending.abortCleanup?.();
    this.pending.delete(message.id);

    if (message.ok) {
      if (!isResponseResult(pending.method, message.result)) {
        pending.reject(new IpcError("INVALID_MESSAGE", `IPC 响应结构无效：${pending.method}`));
        return;
      }
      pending.resolve(message.result);
    } else {
      pending.reject(new IpcError(message.error.code, message.error.message));
    }
  }
}

// Server 只执行已注册方法；未注册方法返回明确错误。
export class TypedIpcServer {
  private readonly handlers = new Map<IpcRequestMethod, (params: unknown) => Promise<unknown>>();
  private readonly transportSubscription: Disposable;

  public constructor(private readonly transport: IpcTransport) {
    this.transportSubscription = transport.onMessage(message => {
      void this.handleMessage(message);
    });
  }

  public registerHandler<Method extends IpcRequestMethod>(
    method: Method,
    handler: RequestHandler<Method>,
  ): Disposable {
    if (this.handlers.has(method)) {
      throw new Error(`IPC 方法已注册：${method}`);
    }

    this.handlers.set(method, async params => handler(params as IpcRequestMap[Method]["params"]));
    return {
      dispose: () => {
        this.handlers.delete(method);
      },
    };
  }

  public emit<Method extends IpcEventMethod>(method: Method, payload: IpcEventMap[Method]): void {
    this.transport.send({ kind: "event", method, payload } as IpcMessage);
  }

  public dispose(): void {
    this.transportSubscription.dispose();
    this.handlers.clear();
  }

  private async handleMessage(value: unknown): Promise<void> {
    if (!isIpcMessage(value) || value.kind !== "request") {
      return;
    }

    const handler = this.handlers.get(value.method);
    if (handler === undefined) {
      this.sendError(value.id, "HANDLER_NOT_REGISTERED", `IPC 方法未注册：${value.method}`);
      return;
    }

    try {
      const result = await handler(value.params);
      if (!isResponseResult(value.method, result)) {
        this.sendError(value.id, "HANDLER_FAILED", `IPC Handler 返回结构无效：${value.method}`);
        return;
      }
      this.transport.send({ kind: "response", id: value.id, ok: true, result });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "未知 IPC 处理错误";
      this.sendError(value.id, "HANDLER_FAILED", message);
    }
  }

  private sendError(id: string, code: "HANDLER_NOT_REGISTERED" | "HANDLER_FAILED", message: string): void {
    this.transport.send({ kind: "response", id, ok: false, error: { code, message } });
  }
}
