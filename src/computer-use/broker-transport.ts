import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { ComputerBrokerMethod, ComputerBrokerRequestMap } from "./broker-protocol.js";

const MAX_BUFFER = 16 * 1024 * 1024;

export interface ComputerUseBrokerTransport {
  request<Method extends ComputerBrokerMethod>(
    method: Method,
    params: ComputerBrokerRequestMap[Method]["params"],
    signal?: AbortSignal,
  ): Promise<unknown>;
  dispose(): void;
}

interface Pending {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly cleanup: () => void;
}

export class ChildProcessComputerUseBrokerTransport implements ComputerUseBrokerTransport {
  private readonly process: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<string, Pending>();
  private readonly ignored = new Set<string>();
  private buffer = "";
  private sequence = 1;
  private disposed = false;

  public constructor(executablePath: string) {
    if (!/^[A-Za-z]:\\/.test(executablePath)) throw new Error("UI Automation Broker 必须使用绝对 Windows 路径");
    this.process = spawn(executablePath, [], { shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    this.process.stdout.setEncoding("utf8");
    this.process.stderr.setEncoding("utf8");
    this.process.stdout.on("data", chunk => this.accept(String(chunk)));
    this.process.stderr.on("data", chunk => {
      if (String(chunk).trim() !== "") this.rejectAll(new Error(`UI Automation Broker stderr：${String(chunk).trim()}`));
    });
    this.process.on("error", error => this.rejectAll(error));
    this.process.on("exit", code => {
      if (!this.disposed) this.rejectAll(new Error(`UI Automation Broker 意外退出：${String(code)}`));
    });
  }

  public request<Method extends ComputerBrokerMethod>(
    method: Method,
    params: ComputerBrokerRequestMap[Method]["params"],
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (this.disposed) return Promise.reject(new Error("UI Automation Broker Transport 已关闭"));
    if (signal?.aborted === true) return Promise.reject(new Error("UI Automation Broker 请求已取消"));
    const id = `computer-broker-${this.sequence++}`;
    return new Promise((resolve, reject) => {
      const abort = (): void => {
        const pending = this.pending.get(id);
        this.pending.delete(id);
        this.ignored.add(id);
        pending?.cleanup();
        reject(new Error("UI Automation Broker 请求已取消"));
      };
      signal?.addEventListener("abort", abort, { once: true });
      this.pending.set(id, { resolve, reject, cleanup: () => signal?.removeEventListener("abort", abort) });
      this.process.stdin.write(`${JSON.stringify({ kind: "request", id, method, params })}\n`, "utf8", error => {
        if (error === undefined || error === null) return;
        const pending = this.pending.get(id);
        this.pending.delete(id);
        pending?.cleanup();
        pending?.reject(error);
      });
    });
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.rejectAll(new Error("UI Automation Broker Transport 已关闭"));
    this.process.kill();
  }

  private accept(chunk: string): void {
    this.buffer += chunk;
    if (this.buffer.length > MAX_BUFFER) {
      this.rejectAll(new Error("UI Automation Broker 输出超过协议限制"));
      this.dispose();
      return;
    }
    while (true) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line === "") continue;
      let message: unknown;
      try { message = JSON.parse(line); } catch { this.rejectAll(new Error("UI Automation Broker 返回无效 JSON")); return; }
      if (typeof message !== "object" || message === null || Array.isArray(message)) {
        this.rejectAll(new Error("UI Automation Broker 返回无效响应")); return;
      }
      const response = message as Record<string, unknown>;
      if (response.kind !== "response" || typeof response.id !== "string") {
        this.rejectAll(new Error("UI Automation Broker 返回无效响应结构")); return;
      }
      if (this.ignored.delete(response.id)) continue;
      const pending = this.pending.get(response.id);
      if (pending === undefined) { this.rejectAll(new Error(`UI Automation Broker 返回未知请求 ID：${response.id}`)); return; }
      this.pending.delete(response.id);
      pending.cleanup();
      if (response.ok === true) pending.resolve(response.result);
      else {
        const error = response.error;
        if (typeof error === "object" && error !== null && !Array.isArray(error)) {
          const item = error as Record<string, unknown>;
          pending.reject(new Error(`${String(item.code)}: ${String(item.message)}`));
        } else pending.reject(new Error("UI Automation Broker 返回无效错误"));
      }
    }
  }

  private rejectAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      pending.cleanup();
      pending.reject(error);
    }
  }
}
