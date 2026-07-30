// Overlay 清单只允许修改批准过的 Code OSS 路径，并验证模式、锚点与源文件。
import { readFile, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDirectory, "../..");
const pin = JSON.parse(await readFile(resolve(scriptDirectory, "source-pin.json"), "utf8"));
const manifest = JSON.parse(await readFile(resolve(scriptDirectory, "overlay-manifest.json"), "utf8"));
const allowedRoots = [
  "product.json",
  "src/vs/workbench/contrib/independentAiIde/",
  "src/vs/workbench/workbench.desktop.main.ts",
  "src/vs/code/electron-main/independentAiIdeRuntimeChannel.ts",
  "src/vs/code/electron-main/app.ts",
  "build/gulpfile.vscode.win32.js",
  "build/gulpfile.vscode.js",
];
const allowedModes = new Set(["copy", "merge-json", "insert-before"]);
const targets = [];

if (manifest.sourceVersion !== pin.version || manifest.sourceArchiveSha256 !== pin.archiveSha256) {
  throw new Error("Overlay 清单与固定 Code OSS 归档不一致");
}

for (const entry of manifest.entries) {
  if (!allowedRoots.some(root => entry.target === root || entry.target.startsWith(root))) {
    throw new Error(`Overlay 包含未批准目标：${entry.target}`);
  }
  if (!allowedModes.has(entry.mode)) {
    throw new Error(`Overlay 使用未批准模式：${entry.mode}`);
  }
  if (entry.mode === "insert-before" && (typeof entry.anchor !== "string" || entry.anchor.trim() === "")) {
    throw new Error(`insert-before 缺少明确锚点：${entry.target}`);
  }

  const sourcePath = resolve(projectRoot, entry.source);
  await stat(sourcePath);
  targets.push(`${entry.mode}:${entry.target}:${entry.anchor ?? ""}`);
}

if (new Set(targets).size !== targets.length) {
  throw new Error("Overlay 存在重复模式和目标组合");
}

console.log(`Code OSS Overlay 清单通过：${targets.length} 个操作`);
