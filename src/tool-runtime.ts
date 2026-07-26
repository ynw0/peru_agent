import type { Capability, ToolRiskLevel } from "./agent-protocol.js";
import type { JsonSchema, ModelToolDefinition } from "./model/types.js";

// Tool Manifest 是安全审核的基础，实际行为不能超出这里声明的能力。
export interface ToolManifest {
  readonly name: string;
  readonly version: string;
  readonly description?: string;
  readonly inputSchema?: JsonSchema;
  readonly riskLevel: ToolRiskLevel;
  readonly capabilities: readonly Capability[];
  readonly generated: boolean;
}

export interface ToolInspection {
  readonly affectedFiles: readonly string[];
  readonly certifiedComputerApplication: boolean;
}

export interface ToolExecutionContext {
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly toolCallId: string;
  readonly signal: AbortSignal;
  reportProgress(message: string): Promise<void>;
}

// Tool 使用统一接口；参数先 validate，再 inspect，最后才允许 execute。
export interface Tool<TInput, TOutput> {
  readonly manifest: ToolManifest;
  validate(input: unknown): TInput;
  inspect(input: TInput): Promise<ToolInspection> | ToolInspection;
  execute(input: TInput, context: ToolExecutionContext): Promise<TOutput>;
  serializeOutput(output: TOutput): string;
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

// ToolRegistry 是当前 Agent 会话可见工具的唯一注册入口。
export class ToolRegistry {
  private readonly tools = new Map<string, Tool<unknown, unknown>>();

  public register<TInput, TOutput>(tool: Tool<TInput, TOutput>): void {
    const name = tool.manifest.name.trim();
    if (name === "") {
      throw new Error("Tool 名称不能为空");
    }
    if (this.tools.has(name)) {
      throw new Error(`Tool 已注册：${name}`);
    }
    if (tool.manifest.description?.trim() === "") {
      throw new Error(`Tool 描述不能为空：${name}`);
    }
    this.tools.set(name, tool as Tool<unknown, unknown>);
  }

  public get(name: string): Tool<unknown, unknown> | undefined {
    return this.tools.get(name);
  }

  public listModelDefinitions(): readonly ModelToolDefinition[] {
    return [...this.tools.values()]
      .sort((left, right) => left.manifest.name.localeCompare(right.manifest.name))
      .map(tool => ({
        name: tool.manifest.name,
        description: tool.manifest.description ?? tool.manifest.name,
        inputSchema: tool.manifest.inputSchema ?? {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
      }));
  }
}
