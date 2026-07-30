import type { Capability } from "../agent-protocol.js";
import {
  WINDOWS_SANDBOX_BROKER_PROTOCOL_VERSION,
  type BrokerHelloResult,
  type CancelPowerShellResult,
  type DiscardPowerShellAnalysisResult,
  type PowerShellAnalysisResult,
  type PowerShellExecutionResult,
  type PowerShellTerminalStartedResult,
  type PowerShellTerminalOutput,
  type WritePowerShellTerminalResult,
  type CancelPowerShellTerminalResult,
  type WindowsSandboxFeatures,
} from "./broker-protocol.js";

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const WINDOWS_ABSOLUTE_PATH = /^[A-Za-z]:\\/;

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label}必须是对象`);
  }
  return value as Record<string, unknown>;
}

function requireString(record: Record<string, unknown>, key: string, label: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label}.${key} 必须是非空字符串`);
  }
  return value;
}

function requireBoolean(record: Record<string, unknown>, key: string, label: string): boolean {
  const value = record[key];
  if (typeof value !== "boolean") {
    throw new Error(`${label}.${key} 必须是布尔值`);
  }
  return value;
}

function requireInteger(record: Record<string, unknown>, key: string, label: string): number {
  const value = record[key];
  if (!Number.isInteger(value)) {
    throw new Error(`${label}.${key} 必须是整数`);
  }
  return Number(value);
}

function requireNonNegativeInteger(record: Record<string, unknown>, key: string, label: string): number {
  const value = requireInteger(record, key, label);
  if (value < 0) {
    throw new Error(`${label}.${key} 不能是负数`);
  }
  return value;
}

function requireStringArray(record: Record<string, unknown>, key: string, label: string): string[] {
  const value = record[key];
  if (!Array.isArray(value) || value.some(item => typeof item !== "string")) {
    throw new Error(`${label}.${key} 必须是字符串数组`);
  }
  return [...value];
}

function requireSha256(record: Record<string, unknown>, key: string, label: string): string {
  const value = requireString(record, key, label);
  if (!SHA256_PATTERN.test(value)) {
    throw new Error(`${label}.${key} 必须是小写十六进制 SHA-256`);
  }
  return value;
}

const CAPABILITIES: ReadonlySet<Capability> = new Set([
  "workspace.read",
  "workspace.write",
  "workspace.propose",
  "workspace.delete",
  "process.execute",
  "process.background",
  "git.write",
  "network.loopback",
  "network.lan",
  "network.internet",
  "browser.navigate",
  "browser.interact",
  "computer.inspect",
  "computer.interact",
  "tool.install",
  "skill.install",
]);

export function validateBrokerHello(value: unknown): BrokerHelloResult {
  const record = asRecord(value, "Broker hello");
  if (record.protocolVersion !== WINDOWS_SANDBOX_BROKER_PROTOCOL_VERSION) {
    throw new Error(`Broker 协议版本不匹配：${String(record.protocolVersion)}`);
  }
  if (record.platform !== "windows" || record.architecture !== "x64") {
    throw new Error("Broker 必须运行在 Windows x64");
  }
  const executable = requireString(record, "powerShellExecutable", "Broker hello");
  if (!WINDOWS_ABSOLUTE_PATH.test(executable)) {
    throw new Error("Broker PowerShell 路径必须是绝对 Windows 路径");
  }
  const featureRecord = asRecord(record.features, "Broker hello.features");
  const features: WindowsSandboxFeatures = {
    powerShellAst: requireBoolean(featureRecord, "powerShellAst", "features"),
    restrictedToken: requireBoolean(featureRecord, "restrictedToken", "features"),
    appContainer: requireBoolean(featureRecord, "appContainer", "features"),
    jobObject: requireBoolean(featureRecord, "jobObject", "features"),
    filesystemAcl: requireBoolean(featureRecord, "filesystemAcl", "features"),
    networkIsolation: requireBoolean(featureRecord, "networkIsolation", "features"),
    processTreeTermination: requireBoolean(featureRecord, "processTreeTermination", "features"),
    utf8Protocol: requireBoolean(featureRecord, "utf8Protocol", "features"),
  };
  return {
    protocolVersion: WINDOWS_SANDBOX_BROKER_PROTOCOL_VERSION,
    brokerVersion: requireString(record, "brokerVersion", "Broker hello"),
    platform: "windows",
    architecture: "x64",
    powerShellVersion: requireString(record, "powerShellVersion", "Broker hello"),
    powerShellExecutable: executable,
    features,
  };
}

export function validatePowerShellAnalysis(value: unknown): PowerShellAnalysisResult {
  const record = asRecord(value, "PowerShell 分析结果");
  const parseErrorsValue = record.parseErrors;
  if (!Array.isArray(parseErrorsValue)) {
    throw new Error("parseErrors 必须是数组");
  }
  const parseErrors = parseErrorsValue.map((item, index) => {
    const error = asRecord(item, `parseErrors[${index}]`);
    const startOffset = requireNonNegativeInteger(error, "startOffset", `parseErrors[${index}]`);
    const endOffset = requireNonNegativeInteger(error, "endOffset", `parseErrors[${index}]`);
    if (endOffset < startOffset) {
      throw new Error(`parseErrors[${index}] 的 endOffset 不能小于 startOffset`);
    }
    return {
      message: requireString(error, "message", `parseErrors[${index}]`),
      startOffset,
      endOffset,
    };
  });

  const commandsValue = record.commands;
  if (!Array.isArray(commandsValue)) {
    throw new Error("commands 必须是数组");
  }
  const commands = commandsValue.map((item, index) => {
    const command = asRecord(item, `commands[${index}]`);
    const startOffset = requireNonNegativeInteger(command, "startOffset", `commands[${index}]`);
    const endOffset = requireNonNegativeInteger(command, "endOffset", `commands[${index}]`);
    if (endOffset < startOffset) {
      throw new Error(`commands[${index}] 的 endOffset 不能小于 startOffset`);
    }
    return {
      name: requireString(command, "name", `commands[${index}]`),
      text: requireString(command, "text", `commands[${index}]`),
      startOffset,
      endOffset,
    };
  });

  const requestedCapabilitiesRaw = requireStringArray(record, "requestedCapabilities", "分析结果");
  const requestedCapabilities: Capability[] = requestedCapabilitiesRaw.map(capability => {
    if (!CAPABILITIES.has(capability as Capability)) {
      throw new Error(`Broker 返回未知 Capability：${capability}`);
    }
    return capability as Capability;
  });

  return {
    analysisId: requireString(record, "analysisId", "分析结果"),
    scriptSha256: requireSha256(record, "scriptSha256", "分析结果"),
    parseErrors,
    commands,
    affectedFiles: requireStringArray(record, "affectedFiles", "分析结果"),
    networkTargets: requireStringArray(record, "networkTargets", "分析结果"),
    requestedCapabilities,
    deniedReasons: requireStringArray(record, "deniedReasons", "分析结果"),
    readOnly: requireBoolean(record, "readOnly", "分析结果"),
  };
}

export function validatePowerShellExecution(value: unknown): PowerShellExecutionResult {
  const record = asRecord(value, "PowerShell 执行结果");
  const auditLogPath = requireString(record, "auditLogPath", "执行结果");
  if (!WINDOWS_ABSOLUTE_PATH.test(auditLogPath)) {
    throw new Error("执行结果 auditLogPath 必须是绝对 Windows 路径");
  }
  return {
    executionId: requireString(record, "executionId", "执行结果"),
    analysisId: requireString(record, "analysisId", "执行结果"),
    scriptSha256: requireSha256(record, "scriptSha256", "执行结果"),
    stdout: typeof record.stdout === "string" ? record.stdout : (() => { throw new Error("执行结果.stdout 必须是字符串"); })(),
    stderr: typeof record.stderr === "string" ? record.stderr : (() => { throw new Error("执行结果.stderr 必须是字符串"); })(),
    exitCode: requireInteger(record, "exitCode", "执行结果"),
    timedOut: requireBoolean(record, "timedOut", "执行结果"),
    interrupted: requireBoolean(record, "interrupted", "执行结果"),
    auditLogPath,
    durationMs: requireNonNegativeInteger(record, "durationMs", "执行结果"),
  };
}

export function validatePowerShellTerminalStarted(value: unknown): PowerShellTerminalStartedResult {
  const record = asRecord(value, "后台终端启动结果");
  const auditLogPath = requireString(record, "auditLogPath", "后台终端启动结果");
  if (!WINDOWS_ABSOLUTE_PATH.test(auditLogPath)) {
    throw new Error("后台终端 auditLogPath 必须是绝对 Windows 路径");
  }
  return {
    terminalId: requireString(record, "terminalId", "后台终端启动结果"),
    analysisId: requireString(record, "analysisId", "后台终端启动结果"),
    scriptSha256: requireSha256(record, "scriptSha256", "后台终端启动结果"),
    auditLogPath,
  };
}

export function validatePowerShellTerminalOutput(value: unknown): PowerShellTerminalOutput {
  const record = asRecord(value, "后台终端输出");
  const completed = requireBoolean(record, "completed", "后台终端输出");
  const exitCode = record.exitCode;
  if (completed && !Number.isInteger(exitCode)) {
    throw new Error("已完成的后台终端输出必须包含整数 exitCode");
  }
  if (!completed && exitCode !== undefined) {
    throw new Error("运行中的后台终端输出不能包含 exitCode");
  }
  return {
    terminalId: requireString(record, "terminalId", "后台终端输出"),
    cursor: requireNonNegativeInteger(record, "cursor", "后台终端输出"),
    stdout: typeof record.stdout === "string" ? record.stdout : (() => { throw new Error("后台终端输出.stdout 必须是字符串"); })(),
    stderr: typeof record.stderr === "string" ? record.stderr : (() => { throw new Error("后台终端输出.stderr 必须是字符串"); })(),
    completed,
    ...(completed ? { exitCode: Number(exitCode) } : {}),
    timedOut: requireBoolean(record, "timedOut", "后台终端输出"),
    interrupted: requireBoolean(record, "interrupted", "后台终端输出"),
  };
}

export function validateWritePowerShellTerminal(value: unknown): WritePowerShellTerminalResult {
  const record = asRecord(value, "后台终端写入结果");
  return { accepted: requireBoolean(record, "accepted", "后台终端写入结果") };
}

export function validateCancelPowerShellTerminal(value: unknown): CancelPowerShellTerminalResult {
  const record = asRecord(value, "后台终端取消结果");
  return { canceled: requireBoolean(record, "canceled", "后台终端取消结果") };
}
export function validateCancelPowerShell(value: unknown): CancelPowerShellResult {
  const record = asRecord(value, "PowerShell 取消结果");
  return { canceled: requireBoolean(record, "canceled", "取消结果") };
}

export function validateDiscardPowerShellAnalysis(value: unknown): DiscardPowerShellAnalysisResult {
  const record = asRecord(value, "PowerShell 分析释放结果");
  return { discarded: requireBoolean(record, "discarded", "分析释放结果") };
}
