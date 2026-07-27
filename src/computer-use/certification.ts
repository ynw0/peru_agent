import { createHash } from "node:crypto";
import type {
  CertifiedApplicationManifest,
  ComputerCertificationDecision,
  ComputerInteractionAction,
  RunningApplicationIdentity,
} from "./types.js";

const SHA256 = /^[a-f0-9]{64}$/;
const THUMBPRINT = /^[A-F0-9]{40,64}$/;
const WINDOWS_ROOT = /^[A-Za-z]:\\/;

function normalizeCase(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeThumbprint(value: string): string {
  return value.replace(/\s/g, "").toUpperCase();
}

function normalizeWindowsPath(value: string): string {
  return value.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
}

function stableManifestJson(manifest: CertifiedApplicationManifest): string {
  return JSON.stringify({
    id: manifest.id,
    displayName: manifest.displayName,
    executableNames: [...manifest.executableNames].map(normalizeCase).sort(),
    allowedPathRoots: [...manifest.allowedPathRoots].map(normalizeWindowsPath).sort(),
    publisherSubjects: [...manifest.publisherSubjects].map(normalizeCase).sort(),
    signerThumbprints: [...manifest.signerThumbprints].map(normalizeThumbprint).sort(),
    allowedFileSha256: [...manifest.allowedFileSha256].map(normalizeCase).sort(),
    versionPattern: manifest.versionPattern,
    allowedWindowClasses: [...manifest.allowedWindowClasses].map(normalizeCase).sort(),
    allowedActions: [...manifest.allowedActions].sort(),
    allowedShortcuts: [...manifest.allowedShortcuts].map(item => item.toUpperCase()).sort(),
  });
}

export function manifestSha256(manifest: CertifiedApplicationManifest): string {
  return createHash("sha256").update(stableManifestJson(manifest), "utf8").digest("hex");
}

export function identityFingerprint(identity: RunningApplicationIdentity): string {
  return createHash("sha256").update(JSON.stringify({
    processId: identity.processId,
    executablePath: normalizeWindowsPath(identity.executablePath),
    executableName: normalizeCase(identity.executableName),
    publisherSubject: normalizeCase(identity.publisherSubject),
    signerThumbprint: normalizeThumbprint(identity.signerThumbprint),
    version: identity.version,
    fileSha256: normalizeCase(identity.fileSha256),
    windowHandle: identity.windowHandle.toLowerCase(),
    windowClass: normalizeCase(identity.windowClass),
    integrityLevel: identity.integrityLevel,
    secureDesktop: identity.secureDesktop,
  }), "utf8").digest("hex");
}

export function validateCertifiedApplicationManifest(manifest: CertifiedApplicationManifest): void {
  if (manifest.id.trim() === "" || manifest.displayName.trim() === "") {
    throw new Error("认证应用 ID 和显示名称不能为空");
  }
  if (manifest.executableNames.length === 0 || manifest.executableNames.some(item => item.trim() === "")) {
    throw new Error(`认证应用 ${manifest.id} 必须声明可执行文件名`);
  }
  if (manifest.allowedPathRoots.length === 0 || manifest.allowedPathRoots.some(root => !WINDOWS_ROOT.test(root))) {
    throw new Error(`认证应用 ${manifest.id} 必须声明绝对 Windows 安装根目录`);
  }
  if (manifest.publisherSubjects.length === 0) {
    throw new Error(`认证应用 ${manifest.id} 必须声明发布者证书主题`);
  }
  if (manifest.signerThumbprints.length === 0 || manifest.signerThumbprints.some(item => !THUMBPRINT.test(normalizeThumbprint(item)))) {
    throw new Error(`认证应用 ${manifest.id} 必须声明有效签名证书指纹`);
  }
  if (manifest.allowedFileSha256.length === 0 || manifest.allowedFileSha256.some(item => !SHA256.test(item))) {
    throw new Error(`认证应用 ${manifest.id} 必须声明精确文件 SHA-256`);
  }
  if (!manifest.versionPattern.startsWith("^") || !manifest.versionPattern.endsWith("$")) {
    throw new Error(`认证应用 ${manifest.id} 的版本正则必须完整锚定`);
  }
  try {
    new RegExp(manifest.versionPattern);
  } catch (error: unknown) {
    throw new Error(`认证应用 ${manifest.id} 的版本正则无效：${error instanceof Error ? error.message : "未知错误"}`);
  }
  if (manifest.allowedWindowClasses.length === 0) {
    throw new Error(`认证应用 ${manifest.id} 必须声明窗口类白名单`);
  }
  const allowedActions = new Set<ComputerInteractionAction>(["click", "type", "shortcut"]);
  if (manifest.allowedActions.some(action => !allowedActions.has(action))) {
    throw new Error(`认证应用 ${manifest.id} 包含未知动作`);
  }
  if (!manifest.allowedActions.includes("shortcut") && manifest.allowedShortcuts.length > 0) {
    throw new Error(`认证应用 ${manifest.id} 未允许 shortcut，却声明了快捷键`);
  }
}

function matchesPath(root: string, executablePath: string): boolean {
  const normalizedRoot = normalizeWindowsPath(root);
  const normalizedPath = normalizeWindowsPath(executablePath);
  return normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}\\`);
}

function manifestReasons(identity: RunningApplicationIdentity, manifest: CertifiedApplicationManifest): string[] {
  const reasons: string[] = [];
  if (!manifest.executableNames.some(name => normalizeCase(name) === normalizeCase(identity.executableName))) reasons.push("可执行文件名不匹配");
  if (!manifest.allowedPathRoots.some(root => matchesPath(root, identity.executablePath))) reasons.push("可执行路径不在认证目录");
  if (!manifest.publisherSubjects.some(subject => normalizeCase(subject) === normalizeCase(identity.publisherSubject))) reasons.push("发布者证书主题不匹配");
  if (!manifest.signerThumbprints.some(item => normalizeThumbprint(item) === normalizeThumbprint(identity.signerThumbprint))) reasons.push("签名证书指纹不匹配");
  if (!manifest.allowedFileSha256.includes(identity.fileSha256.toLowerCase())) reasons.push("应用文件 SHA-256 未认证");
  if (!new RegExp(manifest.versionPattern).test(identity.version)) reasons.push("应用版本不在认证范围");
  if (!manifest.allowedWindowClasses.some(item => normalizeCase(item) === normalizeCase(identity.windowClass))) reasons.push("窗口类不在认证范围");
  if (identity.secureDesktop) reasons.push("安全桌面禁止交互");
  if (identity.integrityLevel === "high" || identity.integrityLevel === "system" || identity.integrityLevel === "unknown") {
    reasons.push("窗口完整性级别不允许交互");
  }
  return reasons;
}

export function evaluateComputerCertification(
  identity: RunningApplicationIdentity,
  manifests: readonly CertifiedApplicationManifest[],
): ComputerCertificationDecision {
  for (const manifest of manifests) {
    validateCertifiedApplicationManifest(manifest);
    const reasons = manifestReasons(identity, manifest);
    if (reasons.length === 0) {
      return {
        status: "certified",
        applicationId: manifest.id,
        displayName: manifest.displayName,
        allowedActions: [...manifest.allowedActions],
        allowedShortcuts: [...manifest.allowedShortcuts],
        reasons: [],
        manifestSha256: manifestSha256(manifest),
      };
    }
  }
  return {
    status: identity.secureDesktop ? "blocked" : "inspect-only",
    allowedActions: [],
    allowedShortcuts: [],
    reasons: [identity.secureDesktop ? "安全桌面禁止 Computer Use" : "应用未通过认证清单"],
  };
}
