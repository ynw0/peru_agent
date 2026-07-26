import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { BrokerMethod, BrokerRequestMap, BrokerResponseMessage } from "./broker-protocol.js";

const MAX_PROTOCOL_BUFFER_CHARS = 16 * 1024 * 1024;

export interface SandboxBrokerTransport {
  request<Method extends BrokerMethod>(
    method: Method,
    params: BrokerRequestMap[Method]["params"],
    signal?: AbortSignal,
  ): Promise<unknown>;
  dispose(): void;
}

interface PendingRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly abortCleanup: () => void;
}

// 生产环境通过标准输入输出使用 JSON Lines 通信，不启用 shell，也不拼接命令字符串。
export class ChildProcessSandboxBrokerTransport implements SandboxBrokerTransport {
  private readonly process: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<string, PendingRequest>();
  // 已取消请求的迟到响应只能忽略，不能误判为“未知 ID”并连带终止其他请求。
  private readonly ignoredResponseIds = new Set<string>();
  private nextId = 1;
  private stdoutBuffer = "";
  private disposed = false;

  public constructor(executablePath: string, args: readonly string[] = []) {
    if (!/^[A-Za-z]:\\/.test(executablePath)) {
      throw new Error("Windows Sandbox Broker 必须使用绝对 Windows 路径");
    }
    this.process = spawn(executablePath, [...args], {
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.process.stdout.setEncoding("utf8");
    this.process.stderr.setEncoding("utf8");
    this.process.stdout.on("data", chunk => this.acceptStdout(String(chunk)));
    this.process.stderr.on("data", chunk => {
      if (String(chunk).trim() !== "") {
        this.rejectAll(new Error(`Sandbox Broker stderr：${String(chunk).trim()}`));
      }
    });
    this.process.on("error", error => this.rejectAll(error));
    this.process.on("exit", code => {
      if (!this.disposed) {
        this.rejectAll(new Error(`Sandbox Broker 意外退出，exitCode=${String(code)}`));
      }
    });
  }

  public request<Method extends BrokerMethod>(
    method: Method,
    params: BrokerRequestMap[Method]["params"],
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (this.disposed) {
      return Promise.reject(new Error("Sandbox Broker Transport 已关闭"));
    }
    if (signal?.aborted === true) {
      return Promise.reject(new Error("Sandbox Broker 请求已取消"));
    }
    const id = `broker-${this.nextId++}`;
    return new Promise<unknown>((resolve, reject) => {
      const abortListener = (): void => {
        const pending = this.pending.get(id);
        this.pending.delete(id);
        this.ignoredResponseIds.add(id);
        pending?.abortCleanup();
        // 执行请求被中止时，额外通知 Broker 终止对应 Job Object 进程树。
        if (method === "powershell.execute") {
          const executionId = (params as BrokerRequestMap["powershell.execute"]["params"]).executionId;
          this.sendCancellation(executionId);
        }
        reject(new Error("Sandbox Broker 请求已取消"));
      };
      signal?.addEventListener("abort", abortListener, { once: true });
      this.pending.set(id, {
        resolve,
        reject,
        abortCleanup: () => signal?.removeEventListener("abort", abortListener),
      });
      this.writeMessage({ kind: "request", id, method, params }, error => {
        if (error === undefined) {
          return;
        }
        const pending = this.pending.get(id);
        this.pending.delete(id);
        pending?.abortCleanup();
        pending?.reject(error);
      });
    });
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.rejectAll(new Error("Sandbox Broker Transport 已关闭"));
    this.process.kill();
  }

  private sendCancellation(executionId: string): void {
    const id = `broker-cancel-${this.nextId++}`;
    this.ignoredResponseIds.add(id);
    this.writeMessage({
      kind: "request",
      id,
      method: "powershell.cancel",
      params: { executionId },
    }, error => {
      if (error !== undefined) {
        this.rejectAll(error);
      }
    });
  }

  private writeMessage(message: object, callback: (error?: Error) => void): void {
    this.process.stdin.write(`${JSON.stringify(message)}\n`, "utf8", error => {
      callback(error ?? undefined);
    });
  }

  private acceptStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    if (this.stdoutBuffer.length > MAX_PROTOCOL_BUFFER_CHARS) {
      this.rejectAll(new Error("Sandbox Broker 输出超过协议缓冲区限制"));
      this.dispose();
      return;
    }

    while (true) {
      const newline = this.stdoutBuffer.indexOf("\n");
      if (newline < 0) {
        return;
      }
      const line = this.stdoutBuffer.slice(0, newline).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (line === "") {
        continue;
      }
      let message: BrokerResponseMessage;
      try {
        message = JSON.parse(line) as BrokerResponseMessage;
      } catch (error: unknown) {
        this.rejectAll(new Error(`Sandbox Broker 返回无效 JSON：${error instanceof Error ? error.message : "未知错误"}`));
        return;
      }
      if (message.kind !== "response" || typeof message.id !== "string") {
        this.rejectAll(new Error("Sandbox Broker 返回无效响应结构"));
        return;
      }
      if (this.ignoredResponseIds.delete(message.id)) {
        continue;
      }
      const pending = this.pending.get(message.id);
      if (pending === undefined) {
        this.rejectAll(new Error(`Sandbox Broker 返回未知请求 ID：${message.id}`));
        return;
      }
      this.pending.delete(message.id);
      pending.abortCleanup();
      if (message.ok === true) {
        pending.resolve(message.result);
      } else if (message.ok === false
        && typeof message.error === "object"
        && message.error !== null
        && typeof message.error.code === "string"
        && typeof message.error.message === "string") {
        pending.reject(new Error(`${message.error.code}: ${message.error.message}`));
      } else {
        pending.reject(new Error("Sandbox Broker 返回无效错误响应"));
      }
    }
  }

  private rejectAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      pending.abortCleanup();
      pending.reject(error);
    }
  }
}
