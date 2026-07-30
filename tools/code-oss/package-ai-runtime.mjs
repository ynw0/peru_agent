import { cp, mkdir, rm, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = resolve(fileURLToPath(new URL(".", import.meta.url)));
const projectRoot = resolve(scriptDirectory, "../..");
const targetIndex = process.argv.indexOf("--target");
const target = targetIndex === -1 ? undefined : process.argv[targetIndex + 1];
if (target === undefined || target.trim() === "") {
  throw new Error("用法：node tools/code-oss/package-ai-runtime.mjs --target <VSCode-win32-*>");
}
const source = resolve(projectRoot, "dist", "src");
const targetDirectory = resolve(target, "resources", "app", "ai-runtime");
const bundledNodeSource = resolve(projectRoot, "vendor", "node22-22.14.0", "node.exe");
const brokerSource = resolve(projectRoot, "native", "windows-sandbox-broker", "bin", "Release", "net8.0-windows", "win-x64", "publish");
const brokerTarget = resolve(target, "resources", "app", "bin", "windows-sandbox-broker");
try {
  await stat(resolve(source, "desktop", "agent-host.js"));
  await stat(resolve(source, "desktop", "runtime-entry.js"));
  await stat(bundledNodeSource);
  await stat(resolve(brokerSource, "IndependentAiIde.WindowsSandboxBroker.exe"));
} catch {
  throw new Error("AI Runtime 或内置 Node 22 尚未准备好。请先运行 npm run build 并准备 vendor/node22-22.14.0/node.exe。");
}
await rm(targetDirectory, { recursive: true, force: true });
await mkdir(targetDirectory, { recursive: true });
await cp(source, resolve(targetDirectory, "src"), { recursive: true, force: true });
await cp(bundledNodeSource, resolve(targetDirectory, "node.exe"), { force: true });
await rm(brokerTarget, { recursive: true, force: true });
await mkdir(brokerTarget, { recursive: true });
await cp(brokerSource, brokerTarget, { recursive: true, force: true });
console.log(`AI Runtime 已打包到：${targetDirectory}`);
console.log(`Windows Sandbox Broker 已打包到：${brokerTarget}`);
