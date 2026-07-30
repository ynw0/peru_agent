import type { Capability, NetworkMode } from "../agent-protocol.js";

// Broker 协议版本必须精确匹配；版本不同直接拒绝，不做旧协议兼容。
export const WINDOWS_SANDBOX_BROKER_PROTOCOL_VERSION = 2 as const;

// 这些能力缺一不可；Broker 不能只报告“进程启动成功”就冒充强沙箱。
export interface WindowsSandboxFeatures {
  readonly powerShellAst: boolean;
  readonly restrictedToken: boolean;
  readonly appContainer: boolean;
  readonly jobObject: boolean;
  readonly filesystemAcl: boolean;
  readonly networkIsolation: boolean;
  readonly processTreeTermination: boolean;
  readonly utf8Protocol: boolean;
}

export interface BrokerHelloResult {
  readonly protocolVersion: typeof WINDOWS_SANDBOX_BROKER_PROTOCOL_VERSION;
  readonly brokerVersion: string;
  readonly platform: "windows";
  readonly architecture: "x64";
  readonly powerShellVersion: string;
  readonly powerShellExecutable: string;
  readonly features: WindowsSandboxFeatures;
}

export interface AnalyzePowerShellRequest {
  readonly script: string;
  readonly cwd: string;
  readonly allowedPaths: readonly string[];
  readonly networkMode: NetworkMode;
  readonly timeoutMs: number;
}

export interface PowerShellParseError {
  readonly message: string;
  readonly startOffset: number;
  readonly endOffset: number;
}

export interface PowerShellCommandInfo {
  readonly name: string;
  readonly text: string;
  readonly startOffset: number;
  readonly endOffset: number;
}

// 分析结果绑定脚本哈希；执行时必须提交完全相同的脚本和分析 ID。
export interface PowerShellAnalysisResult {
  readonly analysisId: string;
  readonly scriptSha256: string;
  readonly parseErrors: readonly PowerShellParseError[];
  readonly commands: readonly PowerShellCommandInfo[];
  readonly affectedFiles: readonly string[];
  readonly networkTargets: readonly string[];
  readonly requestedCapabilities: readonly Capability[];
  readonly deniedReasons: readonly string[];
  readonly readOnly: boolean;
}

export interface ExecutePowerShellRequest extends AnalyzePowerShellRequest {
  // executionId 由 Agent 侧生成，用于中止指定执行，不能由 Broker 临时猜测。
  readonly executionId: string;
  readonly analysisId: string;
  readonly scriptSha256: string;
}

export interface CancelPowerShellRequest {
  readonly executionId: string;
}

export interface CancelPowerShellResult {
  readonly canceled: boolean;
}

export interface DiscardPowerShellAnalysisRequest {
  readonly analysisId: string;
}

export interface DiscardPowerShellAnalysisResult {
  readonly discarded: boolean;
}

export interface PowerShellExecutionResult {
  // Broker 必须把三个绑定字段原样返回，避免错配其他执行结果。
  readonly executionId: string;
  readonly analysisId: string;
  readonly scriptSha256: string;
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly timedOut: boolean;
  readonly interrupted: boolean;
  readonly auditLogPath: string;
  readonly durationMs: number;
}

// 后台终端使用独立 sessionId；每次读输出都带 cursor，避免重复返回或丢失输出。
export interface StartPowerShellTerminalRequest extends AnalyzePowerShellRequest {
  readonly terminalId: string;
  readonly analysisId: string;
  readonly scriptSha256: string;
}

export interface PowerShellTerminalStartedResult {
  readonly terminalId: string;
  readonly analysisId: string;
  readonly scriptSha256: string;
  readonly auditLogPath: string;
}

export interface ReadPowerShellTerminalRequest {
  readonly terminalId: string;
  readonly cursor: number;
}

export interface PowerShellTerminalOutput {
  readonly terminalId: string;
  readonly cursor: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly completed: boolean;
  readonly exitCode?: number;
  readonly timedOut: boolean;
  readonly interrupted: boolean;
}

export interface WritePowerShellTerminalRequest {
  readonly terminalId: string;
  readonly input: string;
}

export interface WritePowerShellTerminalResult {
  readonly accepted: boolean;
}

export interface CancelPowerShellTerminalRequest {
  readonly terminalId: string;
}

export interface CancelPowerShellTerminalResult {
  readonly canceled: boolean;
}
export interface BrokerRequestMap {
  readonly hello: {
    readonly params: Record<string, never>;
    readonly result: BrokerHelloResult;
  };
  readonly "powershell.analyze": {
    readonly params: AnalyzePowerShellRequest;
    readonly result: PowerShellAnalysisResult;
  };
  readonly "powershell.execute": {
    readonly params: ExecutePowerShellRequest;
    readonly result: PowerShellExecutionResult;
  };
  readonly "powershell.cancel": {
    readonly params: CancelPowerShellRequest;
    readonly result: CancelPowerShellResult;
  };
  readonly "powershell.discard-analysis": {
    readonly params: DiscardPowerShellAnalysisRequest;
    readonly result: DiscardPowerShellAnalysisResult;
  };  readonly "powershell.terminal.start": {
    readonly params: StartPowerShellTerminalRequest;
    readonly result: PowerShellTerminalStartedResult;
  };
  readonly "powershell.terminal.read": {
    readonly params: ReadPowerShellTerminalRequest;
    readonly result: PowerShellTerminalOutput;
  };
  readonly "powershell.terminal.write": {
    readonly params: WritePowerShellTerminalRequest;
    readonly result: WritePowerShellTerminalResult;
  };
  readonly "powershell.terminal.cancel": {
    readonly params: CancelPowerShellTerminalRequest;
    readonly result: CancelPowerShellTerminalResult;
  };
}

export type BrokerMethod = keyof BrokerRequestMap;

export type BrokerRequestMessage = {
  readonly [Method in BrokerMethod]: {
    readonly kind: "request";
    readonly id: string;
    readonly method: Method;
    readonly params: BrokerRequestMap[Method]["params"];
  };
}[BrokerMethod];

export interface BrokerSuccessResponseMessage {
  readonly kind: "response";
  readonly id: string;
  readonly ok: true;
  readonly result: unknown;
}

export interface BrokerErrorResponseMessage {
  readonly kind: "response";
  readonly id: string;
  readonly ok: false;
  readonly error: {
    readonly code: string;
    readonly message: string;
  };
}

export type BrokerResponseMessage = BrokerSuccessResponseMessage | BrokerErrorResponseMessage;
