import type {
  ComputerActionResult,
  ComputerElementEvidence,
  ComputerScreenshot,
  ComputerUiSnapshot,
  RunningApplicationIdentity,
} from "./types.js";

export const WINDOWS_UI_AUTOMATION_BROKER_PROTOCOL_VERSION = 1 as const;

export interface WindowsUiAutomationFeatures {
  readonly uiAutomationTree: boolean;
  readonly authenticodeIdentity: boolean;
  readonly windowProcessBinding: boolean;
  readonly screenshotEvidence: boolean;
  readonly invokePattern: boolean;
  readonly valuePattern: boolean;
  readonly keyboardInput: boolean;
  readonly secureDesktopDetection: boolean;
  readonly postActionVerification: boolean;
  readonly utf8Protocol: boolean;
}

export interface ComputerBrokerHelloResult {
  readonly protocolVersion: typeof WINDOWS_UI_AUTOMATION_BROKER_PROTOCOL_VERSION;
  readonly brokerVersion: string;
  readonly platform: "windows";
  readonly architecture: "x64";
  readonly features: WindowsUiAutomationFeatures;
}

export interface InspectWindowRequest { readonly windowHandle: string; readonly maxElements: number }
export interface ScreenshotWindowRequest { readonly snapshotId: string }

export interface BrokerComputerActionRequest {
  readonly actionId: string;
  readonly action: "click" | "type" | "shortcut";
  readonly identityFingerprint: string;
  readonly manifestSha256: string;
  readonly snapshotId: string;
  readonly snapshotSha256: string;
  readonly windowHandle: string;
  readonly processId: number;
  readonly evidence?: ComputerElementEvidence;
  readonly text?: string;
  readonly shortcut?: string;
}

export interface ComputerBrokerRequestMap {
  readonly hello: { readonly params: Record<string, never>; readonly result: ComputerBrokerHelloResult };
  readonly "computer.list-windows": { readonly params: Record<string, never>; readonly result: readonly RunningApplicationIdentity[] };
  readonly "computer.inspect": { readonly params: InspectWindowRequest; readonly result: ComputerUiSnapshot };
  readonly "computer.screenshot": { readonly params: ScreenshotWindowRequest; readonly result: ComputerScreenshot };
  readonly "computer.action": { readonly params: BrokerComputerActionRequest; readonly result: ComputerActionResult };
}

export type ComputerBrokerMethod = keyof ComputerBrokerRequestMap;
