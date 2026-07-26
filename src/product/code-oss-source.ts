// 固定版本避免开发期间上游变化导致 Overlay 和测试结果漂移。
export interface CodeOssSourcePin {
  readonly repository: "https://github.com/microsoft/vscode.git";
  readonly tag: string;
  readonly commit: string;
  readonly license: "MIT";
}

export const CODE_OSS_SOURCE_PIN: CodeOssSourcePin = {
  repository: "https://github.com/microsoft/vscode.git",
  tag: "1.130.0",
  commit: "1b6a188127eeaf9194f945eb6eb89a657e93c54c",
  license: "MIT",
};

export function validateCodeOssSourcePin(pin: CodeOssSourcePin): void {
  if (!/^\d+\.\d+\.\d+$/.test(pin.tag)) {
    throw new Error("Code OSS Tag 格式无效");
  }
  if (!/^[0-9a-f]{40}$/.test(pin.commit)) {
    throw new Error("Code OSS Commit 必须是 40 位小写十六进制 SHA");
  }
  if (pin.license !== "MIT") {
    throw new Error("Code OSS 上游许可必须明确为 MIT");
  }
}
