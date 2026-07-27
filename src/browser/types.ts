import type { NetworkMode } from "../agent-protocol.js";

export type BrowserSessionStatus = "starting" | "ready" | "navigating" | "failed" | "closed";

export interface BrowserSessionRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly networkMode: NetworkMode;
  readonly status: BrowserSessionStatus;
  readonly currentUrl?: string;
  readonly title?: string;
  readonly lastSnapshotId?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly error?: { readonly code: string; readonly message: string };
}

export interface BrowserElementSnapshot {
  readonly id: string;
  readonly role: string;
  readonly name: string;
  readonly value?: string;
  readonly disabled: boolean;
}

export interface BrowserDomSnapshot {
  readonly id: string;
  readonly sessionId: string;
  readonly url: string;
  readonly title: string;
  readonly text: string;
  readonly elements: readonly BrowserElementSnapshot[];
  readonly sha256: string;
  readonly createdAt: string;
}

export interface BrowserScreenshot {
  readonly sessionId: string;
  readonly snapshotId: string;
  readonly mimeType: "image/png";
  readonly base64: string;
  readonly byteLength: number;
  readonly sha256: string;
}

export interface BrowserActionTarget {
  readonly snapshotId: string;
  readonly elementId: string;
}

export interface BrowserActionResult {
  readonly verified: true;
  readonly beforeSnapshotId: string;
  readonly afterSnapshot: BrowserDomSnapshot;
  readonly action: "click" | "type";
}

export interface BrowserDriverCreateRequest {
  readonly sessionId: string;
  readonly locale: "zh-CN" | "en-US";
  readonly proxyServerUrl: string;
  readonly viewport: { readonly width: number; readonly height: number };
  readonly authorizeResource: (url: string, signal: AbortSignal) => Promise<void>;
}

export interface BrowserDriver {
  readonly kind: string;
  readonly egressEnforcement: "broker-proxy";
  create(request: BrowserDriverCreateRequest, signal: AbortSignal): Promise<void>;
  navigate(sessionId: string, url: string, signal: AbortSignal): Promise<BrowserDomSnapshot>;
  snapshot(sessionId: string, signal: AbortSignal): Promise<BrowserDomSnapshot>;
  screenshot(sessionId: string, signal: AbortSignal): Promise<BrowserScreenshot>;
  click(sessionId: string, target: BrowserActionTarget, signal: AbortSignal): Promise<BrowserActionResult>;
  type(sessionId: string, target: BrowserActionTarget, text: string, signal: AbortSignal): Promise<BrowserActionResult>;
  close(sessionId: string): Promise<void>;
}

export interface BrowserCreateRequest {
  readonly workspaceId: string;
  readonly networkMode: NetworkMode;
  readonly locale: "zh-CN" | "en-US";
}
