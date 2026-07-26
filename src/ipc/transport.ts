import type { IpcMessage } from "./protocol.js";

export interface Disposable {
  dispose(): void;
}

// Transport 只负责传递消息，不包含请求路由和业务规则。
export interface IpcTransport {
  send(message: IpcMessage): void;
  onMessage(listener: (message: unknown) => void): Disposable;
}

class InMemoryTransport implements IpcTransport {
  private peer: InMemoryTransport | undefined;
  private readonly listeners = new Set<(message: unknown) => void>();

  public connect(peer: InMemoryTransport): void {
    if (this.peer !== undefined) {
      throw new Error("IPC Transport 已连接，禁止重复连接");
    }
    this.peer = peer;
  }

  public send(message: IpcMessage): void {
    if (this.peer === undefined) {
      throw new Error("IPC Transport 尚未连接");
    }

    // 使用 queueMicrotask 模拟异步进程边界，避免同步重入业务处理器。
    queueMicrotask(() => {
      for (const listener of this.peer?.listeners ?? []) {
        listener(message);
      }
    });
  }

  public onMessage(listener: (message: unknown) => void): Disposable {
    this.listeners.add(listener);
    return {
      dispose: () => {
        this.listeners.delete(listener);
      },
    };
  }
}

// 单元测试和 Smoke Test 使用内存通道；正式 IDE 将实现 Electron/进程 IPC Transport。
export function createInMemoryTransportPair(): readonly [IpcTransport, IpcTransport] {
  const client = new InMemoryTransport();
  const server = new InMemoryTransport();
  client.connect(server);
  server.connect(client);
  return [client, server];
}
