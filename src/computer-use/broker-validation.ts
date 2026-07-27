import {
  WINDOWS_UI_AUTOMATION_BROKER_PROTOCOL_VERSION,
  type ComputerBrokerHelloResult,
  type WindowsUiAutomationFeatures,
} from "./broker-protocol.js";
import type {
  ComputerActionResult,
  ComputerCertificationDecision,
  ComputerElementSnapshot,
  ComputerScreenshot,
  ComputerUiSnapshot,
  RunningApplicationIdentity,
} from "./types.js";

const SHA256 = /^[a-f0-9]{64}$/;
const HANDLE = /^0x[0-9a-f]+$/i;

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label}必须是对象`);
  return value as Record<string, unknown>;
}
function string(value: unknown, label: string, empty = false): string {
  if (typeof value !== "string" || (!empty && value.trim() === "")) throw new Error(`${label}必须是字符串`);
  return value;
}
function integer(value: unknown, label: string): number {
  if (!Number.isInteger(value) || Number(value) < 0) throw new Error(`${label}必须是非负整数`);
  return Number(value);
}
function finiteNumber(value: unknown, label: string, nonNegative = false): number {
  if (typeof value !== "number" || !Number.isFinite(value) || (nonNegative && value < 0)) {
    throw new Error(`${label}必须是${nonNegative ? "非负" : "有限"}数字`);
  }
  return value;
}
function boolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label}必须是布尔值`);
  return value;
}
function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== "string")) throw new Error(`${label}必须是字符串数组`);
  return [...value];
}
function sha(value: unknown, label: string): string {
  const result = string(value, label);
  if (!SHA256.test(result)) throw new Error(`${label}必须是 SHA-256`);
  return result;
}

export function validateComputerBrokerHello(value: unknown): ComputerBrokerHelloResult {
  const item = record(value, "hello");
  const featureRecord = record(item.features, "hello.features");
  const names: readonly (keyof WindowsUiAutomationFeatures)[] = [
    "uiAutomationTree", "authenticodeIdentity", "windowProcessBinding", "screenshotEvidence",
    "invokePattern", "valuePattern", "keyboardInput", "secureDesktopDetection",
    "postActionVerification", "utf8Protocol",
  ];
  const features = Object.fromEntries(names.map(name => [name, boolean(featureRecord[name], `hello.features.${name}`)])) as unknown as WindowsUiAutomationFeatures;
  return {
    protocolVersion: item.protocolVersion === WINDOWS_UI_AUTOMATION_BROKER_PROTOCOL_VERSION
      ? WINDOWS_UI_AUTOMATION_BROKER_PROTOCOL_VERSION
      : (() => { throw new Error("UI Automation Broker 协议版本不匹配"); })(),
    brokerVersion: string(item.brokerVersion, "hello.brokerVersion"),
    platform: item.platform === "windows" ? "windows" : (() => { throw new Error("Broker 平台必须是 windows"); })(),
    architecture: item.architecture === "x64" ? "x64" : (() => { throw new Error("Broker 架构必须是 x64"); })(),
    features,
  };
}

export function validateRunningApplicationIdentity(value: unknown): RunningApplicationIdentity {
  const item = record(value, "application");
  const integrity = item.integrityLevel;
  if (integrity !== "low" && integrity !== "medium" && integrity !== "high" && integrity !== "system" && integrity !== "unknown") {
    throw new Error("application.integrityLevel 无效");
  }
  const handle = string(item.windowHandle, "application.windowHandle");
  if (!HANDLE.test(handle)) throw new Error("application.windowHandle 无效");
  return {
    processId: integer(item.processId, "application.processId"),
    executablePath: string(item.executablePath, "application.executablePath"),
    executableName: string(item.executableName, "application.executableName"),
    publisherSubject: string(item.publisherSubject, "application.publisherSubject", true),
    signerThumbprint: string(item.signerThumbprint, "application.signerThumbprint", true),
    version: string(item.version, "application.version"),
    fileSha256: sha(item.fileSha256, "application.fileSha256"),
    windowHandle: handle.toLowerCase(),
    windowTitle: string(item.windowTitle, "application.windowTitle", true),
    windowClass: string(item.windowClass, "application.windowClass"),
    integrityLevel: integrity,
    secureDesktop: boolean(item.secureDesktop, "application.secureDesktop"),
  };
}

function validateCertification(value: unknown): ComputerCertificationDecision {
  const item = record(value, "certification");
  if (item.status !== "certified" && item.status !== "inspect-only" && item.status !== "blocked") throw new Error("certification.status 无效");
  return {
    status: item.status,
    ...(item.applicationId === undefined ? {} : { applicationId: string(item.applicationId, "certification.applicationId") }),
    ...(item.displayName === undefined ? {} : { displayName: string(item.displayName, "certification.displayName") }),
    allowedActions: stringArray(item.allowedActions, "certification.allowedActions") as ComputerCertificationDecision["allowedActions"],
    allowedShortcuts: stringArray(item.allowedShortcuts, "certification.allowedShortcuts"),
    reasons: stringArray(item.reasons, "certification.reasons"),
    ...(item.manifestSha256 === undefined ? {} : { manifestSha256: sha(item.manifestSha256, "certification.manifestSha256") }),
  };
}

function validateElement(value: unknown): ComputerElementSnapshot {
  const item = record(value, "element");
  const boundsRecord = record(item.bounds, "element.bounds");
  const runtimeId = item.runtimeId;
  if (!Array.isArray(runtimeId) || runtimeId.some(part => !Number.isInteger(part))) throw new Error("element.runtimeId 无效");
  const patterns = stringArray(item.patterns, "element.patterns") as ComputerElementSnapshot["patterns"];
  return {
    id: string(item.id, "element.id"),
    runtimeId: runtimeId.map(Number),
    controlType: string(item.controlType, "element.controlType"),
    role: string(item.role, "element.role"),
    name: string(item.name, "element.name", true),
    automationId: string(item.automationId, "element.automationId", true),
    className: string(item.className, "element.className", true),
    bounds: {
      x: finiteNumber(boundsRecord.x, "element.bounds.x"),
      y: finiteNumber(boundsRecord.y, "element.bounds.y"),
      width: finiteNumber(boundsRecord.width, "element.bounds.width", true),
      height: finiteNumber(boundsRecord.height, "element.bounds.height", true),
    },
    enabled: boolean(item.enabled, "element.enabled"),
    offscreen: boolean(item.offscreen, "element.offscreen"),
    focusable: boolean(item.focusable, "element.focusable"),
    hasKeyboardFocus: boolean(item.hasKeyboardFocus, "element.hasKeyboardFocus"),
    isPassword: boolean(item.isPassword, "element.isPassword"),
    patterns,
  };
}

export function validateComputerUiSnapshot(value: unknown): ComputerUiSnapshot {
  const item = record(value, "snapshot");
  if (!Array.isArray(item.elements)) throw new Error("snapshot.elements 必须是数组");
  return {
    id: string(item.id, "snapshot.id"),
    identity: validateRunningApplicationIdentity(item.identity),
    certification: validateCertification(item.certification),
    elements: item.elements.map(validateElement),
    ...(item.focusedElementId === undefined ? {} : { focusedElementId: string(item.focusedElementId, "snapshot.focusedElementId") }),
    sha256: sha(item.sha256, "snapshot.sha256"),
    createdAt: string(item.createdAt, "snapshot.createdAt"),
  };
}

export function validateComputerScreenshot(value: unknown): ComputerScreenshot {
  const item = record(value, "screenshot");
  return {
    snapshotId: string(item.snapshotId, "screenshot.snapshotId"),
    windowHandle: string(item.windowHandle, "screenshot.windowHandle"),
    mimeType: item.mimeType === "image/png" ? "image/png" : (() => { throw new Error("screenshot.mimeType 无效"); })(),
    base64: string(item.base64, "screenshot.base64", true),
    byteLength: integer(item.byteLength, "screenshot.byteLength"),
    sha256: sha(item.sha256, "screenshot.sha256"),
  };
}

export function validateComputerActionResult(value: unknown): ComputerActionResult {
  const item = record(value, "actionResult");
  if (item.action !== "click" && item.action !== "type" && item.action !== "shortcut") throw new Error("actionResult.action 无效");
  if (item.verified !== true) throw new Error("actionResult 必须声明 verified=true");
  return {
    actionId: string(item.actionId, "actionResult.actionId"),
    action: item.action,
    verified: true,
    beforeSnapshotId: string(item.beforeSnapshotId, "actionResult.beforeSnapshotId"),
    afterSnapshot: validateComputerUiSnapshot(item.afterSnapshot),
    receiptSha256: sha(item.receiptSha256, "actionResult.receiptSha256"),
  };
}
