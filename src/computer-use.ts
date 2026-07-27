export interface CertifiedApplication {
  readonly id: string;
  readonly executableName: string;
  readonly publisher: string;
  readonly supportedVersionPattern: RegExp;
  readonly interactive: true;
}

export interface RunningApplication {
  readonly executableName: string;
  readonly publisher: string;
  readonly version: string;
}

// Phase 0 兼容测试入口；正式 Computer Use 使用 computer-use/certification.ts 的强身份绑定。
export function isComputerInteractionAllowed(
  application: RunningApplication,
  certifiedApplications: readonly CertifiedApplication[],
): boolean {
  return certifiedApplications.some(certified =>
    certified.executableName.toLowerCase() === application.executableName.toLowerCase()
    && certified.publisher === application.publisher
    && certified.supportedVersionPattern.test(application.version),
  );
}

export * from "./computer-use/types.js";
export * from "./computer-use/certification.js";
export * from "./computer-use/broker-protocol.js";
export * from "./computer-use/broker-validation.js";
export * from "./computer-use/broker-transport.js";
export * from "./computer-use/broker-client.js";
export * from "./computer-use/audit.js";
export * from "./computer-use/runtime.js";
export * from "./computer-use/computer-tools.js";
