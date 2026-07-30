import type { NetworkMode } from "../agent-protocol.js";
import type { WindowsSandboxBrokerClient } from "../sandbox/broker-client.js";
import type { PowerShellAnalysisResult } from "../sandbox/broker-protocol.js";
import type { Tool, ToolExecutionContext, ToolInspection, ToolInspectionContext } from "../tool-runtime.js";
import { normalizeWorkspacePath } from "../workspace/path-guard.js";
import type { WorkspaceRegistry } from "../workspace/workspace-service.js";

interface StartInput { readonly script: string; readonly timeoutMs: number; }
interface TerminalIdInput { readonly terminalId: string; }
interface TerminalReadInput extends TerminalIdInput { readonly cursor: number; }
interface TerminalWriteInput extends TerminalIdInput { readonly input: string; }
interface CachedStart { readonly input: StartInput; readonly analysis: PowerShellAnalysisResult; readonly cwd: string; readonly networkMode: NetworkMode; }

function record(value: unknown): Record<string, unknown> { if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("后台终端参数必须是对象"); return value as Record<string, unknown>; }
function nonEmpty(value: unknown, name: string): string { if (typeof value !== "string" || value.trim() === "") throw new Error(`${name} 必须是非空字符串`); return value; }
function terminalId(value: unknown): TerminalIdInput { const input = record(value); return { terminalId: nonEmpty(input.terminalId, "terminalId") }; }
function startInput(value: unknown, maximumTimeoutMs: number): StartInput { const input = record(value); const script = nonEmpty(input.script, "script"); const timeoutMs = input.timeoutMs ?? 120_000; if (!Number.isInteger(timeoutMs) || Number(timeoutMs) < 100 || Number(timeoutMs) > maximumTimeoutMs) throw new Error(`timeoutMs 必须是 100~${maximumTimeoutMs} 的整数`); return { script, timeoutMs: Number(timeoutMs) }; }
function inspectKey(context: ToolInspectionContext): string { return `${context.sessionId}:${context.toolCallId}`; }

export interface PowerShellTerminalToolDependencies {
  readonly broker: WindowsSandboxBrokerClient;
  readonly workspaces: WorkspaceRegistry;
  readonly getNetworkMode: () => NetworkMode;
  readonly maximumTimeoutMs?: number;
}

// 后台终端只经由已验证的 Windows Sandbox Broker 操作；Tool 永不直接 spawn PowerShell。
export function createPowerShellTerminalTools(dependencies: PowerShellTerminalToolDependencies): readonly Tool<unknown, unknown>[] {
  const maximumTimeoutMs = dependencies.maximumTimeoutMs ?? 120_000;
  const analyses = new Map<string, CachedStart>();
  const start: Tool<StartInput, object> = {
    manifest: { name: "PowerShellBackgroundStart", version: "1.0.0", description: "在 Windows 强沙箱中启动可读取输出和写入输入的 PowerShell 后台终端", inputSchema: { type: "object", properties: { script: { type: "string" }, timeoutMs: { type: "integer", minimum: 100, maximum: maximumTimeoutMs } }, required: ["script"], additionalProperties: false }, riskLevel: "process", capabilities: ["process.execute", "process.background"], generated: false },
    validate: value => startInput(value, maximumTimeoutMs),
    async inspect(input, context): Promise<ToolInspection> {
      if (context === undefined) throw new Error("后台终端检查缺少会话上下文");
      const workspace = dependencies.workspaces.get(context.workspaceId); const networkMode = dependencies.getNetworkMode();
      const analysis = await dependencies.broker.analyzePowerShell({ script: input.script, cwd: workspace.root, allowedPaths: [workspace.root], networkMode, timeoutMs: input.timeoutMs }, context.signal);
      if (analysis.parseErrors.length > 0) throw new Error(`PowerShell AST 解析失败：${analysis.parseErrors.map(item => item.message).join("；")}`);
      if (analysis.deniedReasons.length > 0) throw new Error(`PowerShell 安全分析拒绝：${analysis.deniedReasons.join("；")}`);
      const key = inspectKey(context); if (analyses.has(key)) throw new Error("同一后台终端 ToolCall 已存在未释放的分析结果");
      analyses.set(key, { input, analysis, cwd: workspace.root, networkMode });
      return { affectedFiles: analysis.affectedFiles.map(normalizeWorkspacePath), certifiedComputerApplication: false, requestedCapabilities: [...analysis.requestedCapabilities, "process.background"], networkTargets: [...analysis.networkTargets], commands: analysis.commands.map(command => command.name), sandboxRequired: true };
    },
    async execute(input, context) {
      const cached = analyses.get(inspectKey(context)); if (cached === undefined || cached.input.script !== input.script || cached.input.timeoutMs !== input.timeoutMs) throw new Error("后台终端执行缺少已审核且未变化的分析结果");
      const terminalId = `terminal:${context.sessionId}:${context.toolCallId}`;
      await context.reportProgress("正在通过 Windows Sandbox Broker 启动 PowerShell 后台终端");
      return dependencies.broker.startPowerShellTerminal({ terminalId, analysisId: cached.analysis.analysisId, scriptSha256: cached.analysis.scriptSha256, script: input.script, cwd: cached.cwd, allowedPaths: [cached.cwd], networkMode: cached.networkMode, timeoutMs: input.timeoutMs }, context.signal);
    },
    async releaseInspection(_input, context) { const cached = analyses.get(inspectKey(context)); analyses.delete(inspectKey(context)); if (cached !== undefined) await dependencies.broker.discardPowerShellAnalysis(cached.analysis.analysisId); },
    serializeOutput: output => JSON.stringify(output),
  };
  const read: Tool<TerminalReadInput, object> = {
    manifest: { name: "PowerShellBackgroundRead", version: "1.0.0", description: "读取 PowerShell 后台终端自 cursor 以来的增量输出", inputSchema: { type: "object", properties: { terminalId: { type: "string" }, cursor: { type: "integer", minimum: 0 } }, required: ["terminalId", "cursor"], additionalProperties: false }, riskLevel: "process", capabilities: ["process.background"], generated: false },
    validate(value) { const input = record(value); const cursor = input.cursor; if (!Number.isInteger(cursor) || Number(cursor) < 0) throw new Error("cursor 必须是非负整数"); return { ...terminalId(input), cursor: Number(cursor) }; }, inspect: input => ({ affectedFiles: [], certifiedComputerApplication: false, requestedCapabilities: ["process.background"], commands: [`terminal.read:${input.terminalId}`] }), execute: (input, context) => dependencies.broker.readPowerShellTerminal(input, context.signal), serializeOutput: output => JSON.stringify(output),
  };
  const write: Tool<TerminalWriteInput, object> = {
    manifest: { name: "PowerShellBackgroundWrite", version: "1.0.0", description: "向已审核的 PowerShell 后台终端写入 UTF-8 标准输入", inputSchema: { type: "object", properties: { terminalId: { type: "string" }, input: { type: "string" } }, required: ["terminalId", "input"], additionalProperties: false }, riskLevel: "process", capabilities: ["process.background"], generated: false },
    validate(value) { const input = record(value); return { ...terminalId(input), input: typeof input.input === "string" ? input.input : (() => { throw new Error("input 必须是字符串"); })() }; }, inspect: input => ({ affectedFiles: [], certifiedComputerApplication: false, requestedCapabilities: ["process.background"], commands: [`terminal.write:${input.terminalId}`] }), execute: (input, context) => dependencies.broker.writePowerShellTerminal(input, context.signal), serializeOutput: output => JSON.stringify(output),
  };
  const cancel: Tool<TerminalIdInput, object> = {
    manifest: { name: "PowerShellBackgroundCancel", version: "1.0.0", description: "终止 PowerShell 后台终端及其 Job Object 内的整个进程树", inputSchema: { type: "object", properties: { terminalId: { type: "string" } }, required: ["terminalId"], additionalProperties: false }, riskLevel: "process", capabilities: ["process.background"], generated: false },
    validate: terminalId, inspect: input => ({ affectedFiles: [], certifiedComputerApplication: false, requestedCapabilities: ["process.background"], commands: [`terminal.cancel:${input.terminalId}`], sandboxRequired: true }), execute: (input, context) => dependencies.broker.cancelPowerShellTerminal(input, context.signal), serializeOutput: output => JSON.stringify(output),
  };
  return [start, read, write, cancel];
}