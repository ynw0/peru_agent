// 导入用户提供的固定 Code OSS 归档；哈希、版本或关键文件任一不符都立即失败。
import { mkdir, readFile, rename, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { pathExists, sha256File, verifyCodeOssTree } from "./source-utils.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDirectory, "../..");
const pin = JSON.parse(await readFile(resolve(scriptDirectory, "source-pin.json"), "utf8"));
const archivePath = resolve(process.argv[2] ?? "");
const upstreamRoot = resolve(projectRoot, "upstream");
const target = resolve(upstreamRoot, `code-oss-${pin.version}`);
const staging = resolve(upstreamRoot, `.code-oss-${pin.version}-staging`);

if (!process.argv[2]) {
  throw new Error("缺少 Code OSS 归档路径。用法：npm run code-oss:import -- <archive-path>");
}
if (!await pathExists(archivePath)) {
  throw new Error(`Code OSS 归档不存在：${archivePath}`);
}

const actualArchiveSha256 = await sha256File(archivePath);
if (actualArchiveSha256 !== pin.archiveSha256) {
  throw new Error("Code OSS 归档 SHA-256 不匹配");
}

function runExtractor() {
  const command = process.platform === "win32" ? "pwsh" : "unzip";
  const args = process.platform === "win32"
    ? ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "Expand-Archive -LiteralPath $args[0] -DestinationPath $args[1] -Force", archivePath, staging]
    : ["-q", archivePath, "-d", staging];

  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { cwd: projectRoot, stdio: "inherit", shell: false });
    child.once("error", rejectPromise);
    child.once("exit", code => code === 0
      ? resolvePromise()
      : rejectPromise(new Error(`${command} 解压失败，退出码：${String(code)}`)));
  });
}

await mkdir(upstreamRoot, { recursive: true });
await rm(staging, { recursive: true, force: true });
await runExtractor();

const extractedRoot = resolve(staging, pin.archiveRootDirectory);
await verifyCodeOssTree(extractedRoot, pin);

// 验证完成后才替换正式上游目录，避免留下半解压或未校验源码。
await rm(target, { recursive: true, force: true });
await rename(extractedRoot, target);
await rm(staging, { recursive: true, force: true });
console.log(`Code OSS ${pin.version} 归档导入并校验成功：${actualArchiveSha256}`);
