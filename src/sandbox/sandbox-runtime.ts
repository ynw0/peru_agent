import type { BrokerHelloResult } from "./broker-protocol.js";
import type { WindowsSandboxBrokerClient } from "./broker-client.js";

export interface SandboxRuntimeStatus {
  readonly initialized: boolean;
  readonly healthy: boolean;
  readonly reason?: string;
  readonly broker?: BrokerHelloResult;
}

// Runtime 只有在全部强制能力通过握手后才标记为健康。
export class SandboxRuntime {
  private currentStatus: SandboxRuntimeStatus = {
    initialized: false,
    healthy: false,
    reason: "Windows Sandbox Broker 尚未初始化",
  };

  public constructor(private readonly broker: WindowsSandboxBrokerClient) {}

  public async initialize(signal?: AbortSignal): Promise<SandboxRuntimeStatus> {
    try {
      const hello = await this.broker.initialize(signal);
      this.currentStatus = { initialized: true, healthy: true, broker: hello };
    } catch (error: unknown) {
      this.currentStatus = {
        initialized: true,
        healthy: false,
        reason: error instanceof Error ? error.message : "未知 Broker 初始化错误",
      };
    }
    return this.status();
  }

  public status(): SandboxRuntimeStatus {
    return {
      ...this.currentStatus,
      ...(this.currentStatus.broker === undefined ? {} : { broker: this.currentStatus.broker }),
    };
  }
}
