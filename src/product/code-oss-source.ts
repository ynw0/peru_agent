// Code OSS 上游只接受经过哈希固定的源码归档，不接受运行时自动切换版本。
export interface CodeOssSourcePin {
  readonly sourceType: "archive";
  readonly version: string;
  readonly archiveFileName: string;
  readonly archiveSha256: string;
  readonly archiveRootDirectory: string;
  readonly license: "MIT";
  readonly requiredFileSha256: Readonly<Record<string, string>>;
}

export const CODE_OSS_SOURCE_PIN: CodeOssSourcePin = {
  sourceType: "archive",
  version: "1.74.0",
  archiveFileName: "code-main.zip",
  archiveSha256: "debf828bfd82cb4c167757aaa03ef1663ea5999e110f965ec2ae38d8bb884065",
  archiveRootDirectory: "code-main",
  license: "MIT",
  requiredFileSha256: {
    "package.json": "7bb5c3f8d4f03f9e911364efab6d9012fa9c150a351c6c02f21202b20db149d9",
    "product.json": "8f7059a91c5b51ad4f03f99004b60e3589c9c04346de110be666bdefb7ee4007",
    "LICENSE.txt": "cce33203a80863c22499035b1cfb6aba5df5f02e4ea2669cf5bc5730c1864236",
    "src/vs/workbench/workbench.desktop.main.ts":
      "90e5db8531ac0f7d75324fc5c5a1fe770b37b21405553f62fde42b66b70835e8",
  },
};

// 固定清单必须具备完整 SHA-256，避免把未知或被替换的源码当成可信上游。
export function validateCodeOssSourcePin(pin: CodeOssSourcePin): void {
  if (pin.sourceType !== "archive") {
    throw new Error("Phase 2 只接受固定源码归档");
  }
  if (!/^\d+\.\d+\.\d+$/.test(pin.version)) {
    throw new Error("Code OSS 版本格式无效");
  }
  if (!/^[0-9a-f]{64}$/.test(pin.archiveSha256)) {
    throw new Error("Code OSS 归档 SHA-256 必须是 64 位小写十六进制");
  }
  if (pin.archiveRootDirectory.trim() === "") {
    throw new Error("Code OSS 归档根目录不能为空");
  }
  if (pin.license !== "MIT") {
    throw new Error("Code OSS 上游许可必须明确为 MIT");
  }

  const requiredFiles = Object.entries(pin.requiredFileSha256);
  if (requiredFiles.length < 4) {
    throw new Error("Code OSS 固定清单缺少关键文件指纹");
  }
  for (const [path, sha256] of requiredFiles) {
    if (path.trim() === "" || !/^[0-9a-f]{64}$/.test(sha256)) {
      throw new Error(`Code OSS 文件指纹无效：${path}`);
    }
  }
}
