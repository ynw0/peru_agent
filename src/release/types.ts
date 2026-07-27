import type { SupportedLocale } from "../localization/types.js";

export type ReleaseChannel = "stable" | "preview";
export type ReleasePlatform = "win32" | "linux" | "darwin";
export type ReleaseArchitecture = "x64" | "arm64";

export interface ReleaseFileEntry {
  readonly path: string;
  readonly sha256: string;
  readonly size: number;
  readonly executable: boolean;
}

export interface UnsignedReleaseManifest {
  readonly schemaVersion: 1;
  readonly productId: "independent-ai-ide";
  readonly version: string;
  readonly channel: ReleaseChannel;
  readonly platform: ReleasePlatform;
  readonly architecture: ReleaseArchitecture;
  readonly createdAt: string;
  readonly sourceCommit: string;
  readonly codeOssVersion: "1.74.0";
  readonly sbomSha256: string;
  readonly files: readonly ReleaseFileEntry[];
}

export interface SignedReleaseManifest extends UnsignedReleaseManifest {
  readonly manifestDigest: string;
  readonly signerKeyId: string;
  readonly algorithm: "ed25519";
  readonly signatureBase64: string;
}

export type ReleaseGateName =
  | "source-audit"
  | "typescript"
  | "unit-tests"
  | "smoke-tests"
  | "code-oss-compile"
  | "windows-sandbox-red-team"
  | "computer-use-red-team"
  | "sbom"
  | "malware-scan"
  | "authenticode";

export interface ReleaseGateResult {
  readonly gate: ReleaseGateName;
  readonly passed: boolean;
  readonly evidence: string;
  readonly completedAt: string;
}

export interface ReleaseState {
  readonly currentVersion?: string;
  readonly previousVersion?: string;
  readonly installedVersions: readonly string[];
  readonly updatedAt: string;
}

export interface ReleaseAuditEntry {
  readonly id: string;
  readonly action: "manifest-verified" | "version-staged" | "version-activated" | "rollback" | "locale-changed";
  readonly version?: string;
  readonly actor: string;
  readonly timestamp: string;
  readonly details: string;
}

export interface ReleaseRuntimeSnapshot {
  readonly productVersion: string;
  readonly channel: ReleaseChannel;
  readonly locale: SupportedLocale;
  readonly currentVersion?: string;
  readonly previousVersion?: string;
  readonly installedVersions: readonly string[];
  readonly productionReady: boolean;
  readonly blockers: readonly ReleaseGateName[];
  readonly lastCheckedAt?: string;
}
