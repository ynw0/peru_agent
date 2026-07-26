// 认证应用记录必须绑定可执行文件、发布者和支持版本范围。
export interface CertifiedApplication {
  readonly id: string;
  readonly executableName: string;
  readonly publisher: string;
  readonly supportedVersionPattern: RegExp;
  readonly interactive: true;
}

// 当前运行应用的信息由 Windows Broker 提供，不能由模型自行声明。
export interface RunningApplication {
  readonly executableName: string;
  readonly publisher: string;
  readonly version: string;
}

// 只有匹配认证清单的应用才允许点击或输入。
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
