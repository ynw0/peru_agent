import type { Capability, ToolRiskLevel } from "./agent-protocol.js";

// Tool Manifest 是安全审核的基础，实际行为不能超出这里声明的能力。
export interface ToolManifest {
  readonly name: string;
  readonly version: string;
  readonly riskLevel: ToolRiskLevel;
  readonly capabilities: readonly Capability[];
  readonly generated: boolean;
}

// Tool 使用统一接口，后续具体工具只实现 validate 和 execute。
export interface Tool<TInput, TOutput> {
  readonly manifest: ToolManifest;
  validate(input: unknown): TInput;
  execute(input: TInput, signal: AbortSignal): Promise<TOutput>;
}

// 自动晋级判断结果会说明原因，便于审计和 UI 展示。
export interface PromotionDecision {
  readonly allowed: boolean;
  readonly reason: string;
}

// 只有纯计算和严格只读 Tool 可以自动晋级。
export function canAutoPromoteTool(manifest: ToolManifest): PromotionDecision {
  if (!manifest.generated) {
    return { allowed: false, reason: "内置工具不需要走自生成工具晋级流程" };
  }

  if (manifest.riskLevel === "pure-compute") {
    return { allowed: true, reason: "纯计算工具没有文件、进程或网络副作用" };
  }

  if (manifest.riskLevel === "workspace-read") {
    const onlyReadCapability = manifest.capabilities.every(
      capability => capability === "workspace.read",
    );

    return onlyReadCapability
      ? { allowed: true, reason: "工具只声明工作区读取能力" }
      : { allowed: false, reason: "只读工具声明了额外高权限能力" };
  }

  return {
    allowed: false,
    reason: "写入、进程、网络、浏览器、Computer Use 和安全核心工具禁止自动晋级",
  };
}
