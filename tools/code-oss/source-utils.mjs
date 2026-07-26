// Code OSS 固定源码归档的通用校验函数，只使用 Node.js 标准库。
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";

export async function pathExists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

export function sha256File(path) {
  return new Promise((resolvePromise, rejectPromise) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", chunk => hash.update(chunk));
    stream.once("error", rejectPromise);
    stream.once("end", () => resolvePromise(hash.digest("hex")));
  });
}

export async function verifyCodeOssTree(codeOssRoot, pin) {
  const packageJson = JSON.parse(await readFile(resolve(codeOssRoot, "package.json"), "utf8"));
  if (packageJson.name !== "code-oss-dev" || packageJson.version !== pin.version) {
    throw new Error(`Code OSS 版本不匹配：期望 ${pin.version}，实际 ${String(packageJson.version)}`);
  }

  const licenseText = await readFile(resolve(codeOssRoot, "LICENSE.txt"), "utf8");
  if (!licenseText.startsWith("MIT License")) {
    throw new Error("Code OSS LICENSE.txt 不是预期的 MIT License");
  }

  for (const [relativePath, expectedSha256] of Object.entries(pin.requiredFileSha256)) {
    const actualSha256 = await sha256File(resolve(codeOssRoot, relativePath));
    if (actualSha256 !== expectedSha256) {
      throw new Error(`Code OSS 文件指纹不匹配：${relativePath}`);
    }
  }
}
