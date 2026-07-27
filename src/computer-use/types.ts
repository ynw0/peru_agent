import type { Capability } from "../agent-protocol.js";

export type ComputerInteractionAction = "click" | "type" | "shortcut";
export type ComputerCertificationStatus = "certified" | "inspect-only" | "blocked";
export type WindowsIntegrityLevel = "low" | "medium" | "high" | "system" | "unknown";

export interface CertifiedApplicationManifest {
  readonly id: string;
  readonly displayName: string;
  readonly executableNames: readonly string[];
  readonly allowedPathRoots: readonly string[];
  readonly publisherSubjects: readonly string[];
  readonly signerThumbprints: readonly string[];
  readonly allowedFileSha256: readonly string[];
  readonly versionPattern: string;
  readonly allowedWindowClasses: readonly string[];
  readonly allowedActions: readonly ComputerInteractionAction[];
  readonly allowedShortcuts: readonly string[];
}

export interface RunningApplicationIdentity {
  readonly processId: number;
  readonly executablePath: string;
  readonly executableName: string;
  readonly publisherSubject: string;
  readonly signerThumbprint: string;
  readonly version: string;
  readonly fileSha256: string;
  readonly windowHandle: string;
  readonly windowTitle: string;
  readonly windowClass: string;
  readonly integrityLevel: WindowsIntegrityLevel;
  readonly secureDesktop: boolean;
}

export interface ComputerCertificationDecision {
  readonly status: ComputerCertificationStatus;
  readonly applicationId?: string;
  readonly displayName?: string;
  readonly allowedActions: readonly ComputerInteractionAction[];
  readonly allowedShortcuts: readonly string[];
  readonly reasons: readonly string[];
  readonly manifestSha256?: string;
}

export interface ComputerWindowRecord {
  readonly identity: RunningApplicationIdentity;
  readonly certification: ComputerCertificationDecision;
}

export interface ComputerBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export type ComputerElementPattern = "invoke" | "value" | "selection" | "toggle" | "expand-collapse" | "text";

export interface ComputerElementSnapshot {
  readonly id: string;
  readonly runtimeId: readonly number[];
  readonly controlType: string;
  readonly role: string;
  readonly name: string;
  readonly automationId: string;
  readonly className: string;
  readonly bounds: ComputerBounds;
  readonly enabled: boolean;
  readonly offscreen: boolean;
  readonly focusable: boolean;
  readonly hasKeyboardFocus: boolean;
  readonly isPassword: boolean;
  readonly patterns: readonly ComputerElementPattern[];
}

export interface ComputerUiSnapshot {
  readonly id: string;
  readonly identity: RunningApplicationIdentity;
  readonly certification: ComputerCertificationDecision;
  readonly elements: readonly ComputerElementSnapshot[];
  readonly focusedElementId?: string;
  readonly sha256: string;
  readonly createdAt: string;
}

export interface ComputerScreenshot {
  readonly snapshotId: string;
  readonly windowHandle: string;
  readonly mimeType: "image/png";
  readonly base64: string;
  readonly byteLength: number;
  readonly sha256: string;
}

export interface ComputerElementEvidence {
  readonly snapshotId: string;
  readonly snapshotSha256: string;
  readonly elementId: string;
  readonly runtimeId: readonly number[];
  readonly role: string;
  readonly name: string;
  readonly automationId: string;
  readonly className: string;
  readonly bounds: ComputerBounds;
}

export interface ComputerActionRequestBase {
  readonly snapshotId: string;
  readonly elementId: string;
  readonly reason: string;
}

export interface ComputerClickRequest extends ComputerActionRequestBase {}
export interface ComputerTypeRequest extends ComputerActionRequestBase { readonly text: string }
export interface ComputerShortcutRequest {
  readonly snapshotId: string;
  readonly shortcut: string;
  readonly reason: string;
}

export interface PreparedComputerAction {
  readonly id: string;
  readonly action: ComputerInteractionAction;
  readonly applicationId: string;
  readonly identityFingerprint: string;
  readonly manifestSha256: string;
  readonly snapshotId: string;
  readonly evidence?: ComputerElementEvidence;
  readonly shortcut?: string;
  readonly textSha256?: string;
  readonly reason: string;
  readonly requestedCapabilities: readonly Capability[];
  readonly createdAt: string;
  readonly expiresAt: string;
}

export interface ComputerActionResult {
  readonly actionId: string;
  readonly action: ComputerInteractionAction;
  readonly verified: true;
  readonly beforeSnapshotId: string;
  readonly afterSnapshot: ComputerUiSnapshot;
  readonly receiptSha256: string;
}

export interface ComputerUseAuditEntry {
  readonly id: string;
  readonly timestamp: string;
  readonly action: "inspect" | "screenshot" | ComputerInteractionAction;
  readonly decision: "allowed" | "denied" | "completed" | "failed";
  readonly processId: number;
  readonly windowHandle: string;
  readonly applicationId?: string;
  readonly snapshotId?: string;
  readonly elementId?: string;
  readonly reason: string;
}
