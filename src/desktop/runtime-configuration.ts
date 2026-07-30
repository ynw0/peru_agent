import { isAbsolute } from "node:path";
import type { NetworkMode } from "../agent-protocol.js";

export type RuntimeConnectionStatus =
  | "starting"
  | "connected"
  | "stopping"
  | "disconnected"
  | "runtime-missing"
  | "protocol-mismatch"
  | "initialization-failed"
  | "model-not-configured"
  | "broker-unavailable"
  | "runtime-exited";

export interface RuntimeModelConfiguration {
  readonly baseUrl?: string;
  readonly chatCompletionsPath?: string;
  readonly model?: string;
  readonly apiKeyEnvironmentVariable?: string;
}

export interface RuntimeCapabilityConfiguration {
  readonly network: {
    readonly mode: NetworkMode;
    readonly webFetchEnabled: boolean;
    readonly webSearchEnabled: boolean;
    readonly searxngEndpoint?: string;
  };
  readonly browser: {
    readonly enabled: boolean;
    readonly chromiumExecutablePath?: string;
    readonly proxyHost: "127.0.0.1";
    readonly maxSessions: number;
  };
  readonly computerUse: {
    readonly enabled: boolean;
    readonly brokerExecutablePath?: string;
    readonly certificationManifestPath?: string;
  };
}

export interface RuntimeConfiguration extends RuntimeCapabilityConfiguration {
  readonly protocolVersion: 1;
  readonly productVersion: string;
  readonly dataDirectory: string;
  readonly sandboxBrokerExecutablePath: string;
  readonly model: RuntimeModelConfiguration;
}

export interface RuntimeConfigurationInput {
  readonly dataDirectory: string;
  readonly sandboxBrokerExecutablePath: string;
  readonly model?: RuntimeModelConfiguration;
  readonly productVersion?: string;
  readonly network?: Partial<RuntimeCapabilityConfiguration["network"]>;
  readonly browser?: Partial<RuntimeCapabilityConfiguration["browser"]>;
  readonly computerUse?: Partial<RuntimeCapabilityConfiguration["computerUse"]>;
}

const DEFAULT_PRODUCT_VERSION = "0.13.0";

// 唯一的 Runtime 配置组装点。能力启用但资产缺失时必须失败，不得切换到系统实现。
export function createRuntimeConfiguration(input: RuntimeConfigurationInput): RuntimeConfiguration {
  requireAbsolutePath(input.dataDirectory, "dataDirectory");
  requireAbsolutePath(input.sandboxBrokerExecutablePath, "sandboxBrokerExecutablePath");
  const networkMode = input.network?.mode ?? "offline";
  if (networkMode !== "offline" && networkMode !== "lan" && networkMode !== "internet") {
    throw new Error(`网络模式无效：${String(networkMode)}`);
  }
  const webSearchEnabled = input.network?.webSearchEnabled ?? false;
  const searxngEndpoint = input.network?.searxngEndpoint;
  if (webSearchEnabled && (typeof searxngEndpoint !== "string" || searxngEndpoint.trim() === "")) {
    throw new Error("WebSearch 已启用，但未配置 SearXNG endpoint");
  }
  if (searxngEndpoint !== undefined) {
    validateEndpoint(searxngEndpoint, "SearXNG endpoint");
  }

  const browserEnabled = input.browser?.enabled ?? false;
  const chromiumExecutablePath = input.browser?.chromiumExecutablePath;
  if (browserEnabled) {
    requireAbsolutePath(chromiumExecutablePath, "browser.chromiumExecutablePath");
  }
  const maxSessions = input.browser?.maxSessions ?? 3;
  if (!Number.isInteger(maxSessions) || maxSessions < 1 || maxSessions > 20) {
    throw new Error("browser.maxSessions 必须是 1~20 的整数");
  }

  const computerEnabled = input.computerUse?.enabled ?? false;
  const brokerExecutablePath = input.computerUse?.brokerExecutablePath;
  const certificationManifestPath = input.computerUse?.certificationManifestPath;
  if (computerEnabled) {
    requireAbsolutePath(brokerExecutablePath, "computerUse.brokerExecutablePath");
    requireAbsolutePath(certificationManifestPath, "computerUse.certificationManifestPath");
  }

  return {
    protocolVersion: 1,
    productVersion: input.productVersion ?? DEFAULT_PRODUCT_VERSION,
    dataDirectory: input.dataDirectory,
    sandboxBrokerExecutablePath: input.sandboxBrokerExecutablePath,
    model: input.model ?? {},
    network: {
      mode: networkMode,
      webFetchEnabled: input.network?.webFetchEnabled ?? true,
      webSearchEnabled,
      ...(searxngEndpoint === undefined ? {} : { searxngEndpoint }),
    },
    browser: {
      enabled: browserEnabled,
      proxyHost: "127.0.0.1",
      maxSessions,
      ...(chromiumExecutablePath === undefined ? {} : { chromiumExecutablePath }),
    },
    computerUse: {
      enabled: computerEnabled,
      ...(brokerExecutablePath === undefined ? {} : { brokerExecutablePath }),
      ...(certificationManifestPath === undefined ? {} : { certificationManifestPath }),
    },
  };
}

function requireAbsolutePath(value: string | undefined, name: string): string {
  if (typeof value !== "string" || value.trim() === "" || !isAbsolute(value)) {
    throw new Error(`${name} 必须是绝对路径`);
  }
  return value;
}

function validateEndpoint(value: string, name: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error: unknown) {
    throw new Error(`${name} 无效：${error instanceof Error ? error.message : "解析失败"}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${name} 只允许 HTTP/HTTPS`);
  }
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
    throw new Error(`${name} 不允许凭据、查询参数或 Fragment`);
  }
}
