import type { ToolManifest } from "../tool-runtime.js";
import type {
  SkillCandidatePayload,
  SkillForgeRequest,
  ToolCandidatePayload,
  ToolForgeRequest,
} from "./types.js";

export interface ToolForgeModel {
  generate(request: ToolForgeRequest, signal: AbortSignal): Promise<{
    readonly source: string;
    readonly testSource: string;
    readonly sdkVersion: string;
  }>;
}

// Tool Forge 只能生成候选包，不能注册或执行生成代码。
export class ToolForge {
  public constructor(private readonly model: ToolForgeModel) {}

  public async forge(request: ToolForgeRequest, signal: AbortSignal): Promise<ToolCandidatePayload> {
    if (request.gap.requiredCapabilities.some(capability => !request.capabilities.includes(capability))) {
      throw new Error("Tool Forge 声明能力未覆盖 Gap 所需能力");
    }
    const generated = await this.model.generate(request, signal);
    const manifest: ToolManifest = {
      name: validateIdentifier(request.name),
      version: "0.1.0-candidate",
      description: validateText(request.description, "Tool 描述", 1_000),
      riskLevel: request.riskLevel,
      capabilities: [...new Set(request.capabilities)],
      generated: true,
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    };
    return {
      manifest,
      source: validateText(generated.source, "Tool 源码", 200_000),
      testSource: validateText(generated.testSource, "Tool 测试源码", 200_000),
      sdkVersion: validateText(generated.sdkVersion, "Tool SDK 版本", 100),
    };
  }
}

// Skill Forge 只组合已有 Tool Manifest，不复制或扩大 Tool 权限。
export class SkillForge {
  public forge(request: SkillForgeRequest): SkillCandidatePayload {
    const toolNames = new Set(request.toolManifests.map(manifest => manifest.name));
    if (toolNames.size !== request.toolManifests.length || toolNames.size === 0) {
      throw new Error("Skill 必须引用至少一个且不重复的 Tool");
    }
    for (const step of request.steps) {
      if (!toolNames.has(step.toolName)) {
        throw new Error(`Skill 步骤引用未知 Tool：${step.toolName}`);
      }
    }
    return {
      name: validateIdentifier(request.name),
      version: validateText(request.version, "Skill 版本", 100),
      description: validateText(request.description, "Skill 描述", 1_000),
      toolManifests: request.toolManifests.map(manifest => ({ ...manifest, capabilities: [...manifest.capabilities] })),
      steps: request.steps.map(step => ({
        id: validateIdentifier(step.id),
        toolName: step.toolName,
        instruction: validateText(step.instruction, "Skill 步骤", 2_000),
      })),
    };
  }
}

function validateIdentifier(value: string): string {
  const result = value.trim();
  if (!/^[A-Za-z][A-Za-z0-9._-]{1,63}$/.test(result)) {
    throw new Error(`候选名称无效：${value}`);
  }
  return result;
}

function validateText(value: string, label: string, maxLength: number): string {
  const result = value.trim();
  if (result === "") throw new Error(`${label}不能为空`);
  if (result.length > maxLength) throw new Error(`${label}超过长度限制`);
  return result;
}
