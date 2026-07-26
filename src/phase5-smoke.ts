import { IncrementingIdGenerator } from "./agent/id-generator.js";
import { PermissionCoordinator } from "./agent/permission-coordinator.js";
import { AgentSession } from "./agent/session.js";
import type { SandboxBrokerTransport } from "./sandbox/broker-transport.js";
import type { BrokerMethod, BrokerRequestMap, ExecutePowerShellRequest } from "./sandbox/broker-protocol.js";
import { WindowsSandboxBrokerClient, sha256Text } from "./sandbox/broker-client.js";
import { SandboxRuntime } from "./sandbox/sandbox-runtime.js";

class SmokeBrokerTransport implements SandboxBrokerTransport {
  public async request<Method extends BrokerMethod>(
    method: Method,
    params: BrokerRequestMap[Method]["params"],
  ): Promise<unknown> {
    if (method === "hello") {
      return {
        protocolVersion: 1,
        brokerVersion: "smoke",
        platform: "windows",
        architecture: "x64",
        powerShellVersion: "7.4",
        powerShellExecutable: "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
        features: {
          powerShellAst: true,
          restrictedToken: true,
          appContainer: true,
          jobObject: true,
          filesystemAcl: true,
          networkIsolation: true,
          processTreeTermination: true,
          utf8Protocol: true,
        },
      };
    }
    if (method === "powershell.analyze") {
      const record = params as BrokerRequestMap["powershell.analyze"]["params"];
      return {
        analysisId: "analysis-smoke",
        scriptSha256: sha256Text(record.script),
        parseErrors: [],
        commands: [{ name: "Get-ChildItem", text: "Get-ChildItem", startOffset: 0, endOffset: 13 }],
        affectedFiles: [],
        networkTargets: [],
        requestedCapabilities: ["process.execute"],
        deniedReasons: [],
        readOnly: true,
      };
    }
    if (method === "powershell.execute") {
      const record = params as ExecutePowerShellRequest;
      return {
        executionId: record.executionId,
        analysisId: record.analysisId,
        scriptSha256: record.scriptSha256,
        stdout: "ok",
        stderr: "",
        exitCode: 0,
        timedOut: false,
        interrupted: false,
        auditLogPath: "C:\\audit\\smoke.jsonl",
        durationMs: 1,
      };
    }
    if (method === "powershell.cancel") {
      return { canceled: true };
    }
    return { discarded: true };
  }
  public dispose(): void {}
}

const client = new WindowsSandboxBrokerClient(new SmokeBrokerTransport());
const runtime = new SandboxRuntime(client);
const status = await runtime.initialize();
if (!status.healthy) {
  throw new Error(status.reason ?? "Phase 5 Sandbox smoke 失败");
}

// 动态权限能力必须继续经过 PermissionCoordinator，不可绕过现有权限系统。
const session = new AgentSession("session-smoke", "workspace-smoke", "autoReview");
session.start("run-smoke");
const decision = await new PermissionCoordinator(new IncrementingIdGenerator()).authorize(
  session,
  "tool-call-permission",
  {
    name: "PowerShell",
    version: "1.0.0",
    riskLevel: "process",
    capabilities: ["process.execute"],
    generated: false,
  },
  {
    affectedFiles: [],
    certifiedComputerApplication: false,
    requestedCapabilities: ["network.internet"],
  },
  async () => undefined,
  new AbortController().signal,
);
if (decision !== "deny") {
  throw new Error("Phase 5 动态高权限能力没有被 autoReview 拒绝");
}

console.log("Phase 5 smoke passed");
