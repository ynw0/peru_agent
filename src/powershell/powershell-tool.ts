import type { NetworkMode } from "../agent-protocol.js";
import type { WindowsSandboxBrokerClient } from "../sandbox/broker-client.js";
import type { PowerShellAnalysisResult, PowerShellExecutionResult } from "../sandbox/broker-protocol.js";
import type {
  Tool,
  ToolExecutionContext,
  ToolInspection,
  ToolInspectionContext,
} from "../tool-runtime.js";
import { normalizeWorkspacePath } from "../workspace/path-guard.js";
import type { WorkspaceRegistry } from "../workspace/workspace-service.js";

interface PowerShellInput {
  readonly script: string;
  readonly timeoutMs: number;
  readonly description?: string;
}

interface CachedAnalysis {
  readonly input: PowerShellInput;
  readonly analysis: PowerShellAnalysisResult;
  readonly cwd: string;
  readonly networkMode: NetworkMode;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("PowerShell 参数必须是对象");
  }
  return value as Record<string, unknown>;
}

function validateInput(value: unknown, maximumTimeoutMs: number): PowerShellInput {
  const record = asRecord(value);
  const allowedKeys = new Set(["script", "timeoutMs", "description"]);
  const unknownKeys = Object.keys(record).filter(key => !allowedKeys.has(key));
  if (unknownKeys.length > 0) {
    throw new Error(`PowerShell 参数包含未知字段：${unknownKeys.join(", ")}`);
  }
  if (typeof record.script !== "string" || record.script.trim() === "") {
    throw new Error("script 必须是非空字符串");
  }
  const timeoutValue = record.timeoutMs ?? 30_000;
  if (!Number.isInteger(timeoutValue) || Number(timeoutValue) < 100 || Number(timeoutValue) > maximumTimeoutMs) {
    throw new Error(`timeoutMs 必须是 100~${maximumTimeoutMs} 的整数`);
  }
  if (record.description !== undefined
    && (typeof record.description !== "string" || record.description.trim() === "")) {
    throw new Error("description 必须是非空字符串");
  }
  return {
    script: record.script,
    timeoutMs: Number(timeoutValue),
    ...(record.description === undefined ? {} : { description: record.description as string }),
  };
}

function inspectionKey(context: ToolInspectionContext): string {
  return `${context.sessionId}:${context.toolCallId}`;
}

export interface PowerShellToolDependencies {
  readonly broker: WindowsSandboxBrokerClient;
  readonly workspaces: WorkspaceRegistry;
  readonly getNetworkMode: () => NetworkMode;
  readonly maximumTimeoutMs?: number;
}

// PowerShell Tool 不直接启动 pwsh；所有分析和执行必须经过已验证的 Windows Broker。
export function createPowerShellTool(
  dependencies: PowerShellToolDependencies,
): Tool<PowerShellInput, PowerShellExecutionResult> {
  const maximumTimeoutMs = dependencies.maximumTimeoutMs ?? 120_000;
  const analyses = new Map<string, CachedAnalysis>();

  return {
    manifest: {
      name: "PowerShell",
      version: "1.0.0",
      description: "在 Windows 强沙箱中分析并执行 PowerShell 7 脚本",
      inputSchema: {
        type: "object",
        properties: {
          script: { type: "string" },
          timeoutMs: { type: "integer", minimum: 100, maximum: maximumTimeoutMs },
          description: { type: "string" },
        },
        required: ["script"],
        additionalProperties: false,
      },
      riskLevel: "process",
      capabilities: ["process.execute"],
      generated: false,
    },

    validate: value => validateInput(value, maximumTimeoutMs),

    async inspect(input: PowerShellInput, context?: ToolInspectionContext): Promise<ToolInspection> {
      if (context === undefined) {
        throw new Error("PowerShell Tool 检查缺少会话上下文");
      }
      const workspace = dependencies.workspaces.get(context.workspaceId);
      const networkMode = dependencies.getNetworkMode();
      const analysis = await dependencies.broker.analyzePowerShell({
        script: input.script,
        cwd: workspace.root,
        allowedPaths: [workspace.root],
        networkMode,
        timeoutMs: input.timeoutMs,
      }, context.signal);
      if (analysis.parseErrors.length > 0) {
        throw new Error(`PowerShell AST 解析失败：${analysis.parseErrors.map(item => item.message).join("；")}`);
      }
      if (analysis.deniedReasons.length > 0) {
        throw new Error(`PowerShell 安全分析拒绝：${analysis.deniedReasons.join("；")}`);
      }

      // Broker 对工作区文件只返回相对路径；这里再次复用 Workspace 规则校验边界。
      const affectedFiles = analysis.affectedFiles.map(path => normalizeWorkspacePath(path));
      const key = inspectionKey(context);
      if (analyses.has(key)) {
        throw new Error("同一 ToolCall 已存在未释放的 PowerShell 分析结果");
      }
      analyses.set(key, {
        input,
        analysis,
        cwd: workspace.root,
        networkMode,
      });
      return {
        affectedFiles,
        certifiedComputerApplication: false,
        requestedCapabilities: [...analysis.requestedCapabilities],
        networkTargets: [...analysis.networkTargets],
        commands: analysis.commands.map(command => command.name),
        sandboxRequired: true,
      };
    },

    async execute(input: PowerShellInput, context: ToolExecutionContext): Promise<PowerShellExecutionResult> {
      const key = inspectionKey(context);
      const cached = analyses.get(key);
      if (cached === undefined) {
        throw new Error("PowerShell 执行缺少已通过的 AST 分析结果");
      }
      if (cached.input.script !== input.script || cached.input.timeoutMs !== input.timeoutMs) {
        throw new Error("PowerShell 输入在权限审核后发生变化");
      }
      await context.reportProgress("正在通过 Windows Sandbox Broker 执行 PowerShell");
      return dependencies.broker.executePowerShell({
        executionId: `execution:${context.sessionId}:${context.toolCallId}`,
        analysisId: cached.analysis.analysisId,
        scriptSha256: cached.analysis.scriptSha256,
        script: input.script,
        cwd: cached.cwd,
        allowedPaths: [cached.cwd],
        networkMode: cached.networkMode,
        timeoutMs: input.timeoutMs,
      }, context.signal);
    },

    async releaseInspection(_input: PowerShellInput, context: ToolInspectionContext): Promise<void> {
      const key = inspectionKey(context);
      const cached = analyses.get(key);
      analyses.delete(key);
      if (cached !== undefined) {
        await dependencies.broker.discardPowerShellAnalysis(cached.analysis.analysisId);
      }
    },

    serializeOutput: output => JSON.stringify(output),
  };
}
