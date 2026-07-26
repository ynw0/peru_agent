import { createHash } from "node:crypto";
import type {
  AnalyzePowerShellRequest,
  BrokerHelloResult,
  ExecutePowerShellRequest,
  PowerShellAnalysisResult,
  PowerShellExecutionResult,
  WindowsSandboxFeatures,
} from "./broker-protocol.js";
import type { SandboxBrokerTransport } from "./broker-transport.js";
import {
  validateBrokerHello,
  validateDiscardPowerShellAnalysis,
  validatePowerShellAnalysis,
  validatePowerShellExecution,
} from "./broker-validation.js";

const REQUIRED_FEATURES: readonly (keyof WindowsSandboxFeatures)[] = [
  "powerShellAst",
  "restrictedToken",
  "appContainer",
  "jobObject",
  "filesystemAcl",
  "networkIsolation",
  "processTreeTermination",
  "utf8Protocol",
];

export function sha256Text(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

// Client 会验证 Broker 自报能力；缺任一强制能力都拒绝启用 PowerShell Tool。
export class WindowsSandboxBrokerClient {
  private helloResult: BrokerHelloResult | undefined;

  public constructor(private readonly transport: SandboxBrokerTransport) {}

  public async initialize(signal?: AbortSignal): Promise<BrokerHelloResult> {
    const result = validateBrokerHello(await this.transport.request("hello", {}, signal));
    const missing = REQUIRED_FEATURES.filter(feature => !result.features[feature]);
    if (missing.length > 0) {
      throw new Error(`Windows Sandbox Broker 缺少强制能力：${missing.join(", ")}`);
    }
    this.helloResult = result;
    return result;
  }

  public status(): BrokerHelloResult | undefined {
    return this.helloResult;
  }

  public async analyzePowerShell(
    request: AnalyzePowerShellRequest,
    signal?: AbortSignal,
  ): Promise<PowerShellAnalysisResult> {
    this.assertInitialized();
    const result = validatePowerShellAnalysis(
      await this.transport.request("powershell.analyze", request, signal),
    );
    const localHash = sha256Text(request.script);
    if (result.scriptSha256 !== localHash) {
      throw new Error("Broker 分析结果的脚本 SHA-256 与本地脚本不一致");
    }
    return result;
  }

  public async discardPowerShellAnalysis(analysisId: string): Promise<boolean> {
    this.assertInitialized();
    if (analysisId.trim() === "") {
      throw new Error("analysisId 不能为空");
    }
    const result = validateDiscardPowerShellAnalysis(
      await this.transport.request("powershell.discard-analysis", { analysisId }),
    );
    return result.discarded;
  }

  public async executePowerShell(
    request: ExecutePowerShellRequest,
    signal?: AbortSignal,
  ): Promise<PowerShellExecutionResult> {
    this.assertInitialized();
    const localHash = sha256Text(request.script);
    if (localHash !== request.scriptSha256) {
      throw new Error("执行请求脚本与已分析脚本不一致");
    }
    const result = validatePowerShellExecution(
      await this.transport.request("powershell.execute", request, signal),
    );
    if (result.executionId !== request.executionId
      || result.analysisId !== request.analysisId
      || result.scriptSha256 !== request.scriptSha256) {
      throw new Error("Broker 执行结果与当前 executionId、analysisId 或脚本哈希不匹配");
    }
    return result;
  }

  public dispose(): void {
    this.transport.dispose();
  }

  private assertInitialized(): void {
    if (this.helloResult === undefined) {
      throw new Error("Windows Sandbox Broker 尚未初始化");
    }
  }
}
