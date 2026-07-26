// Overlay 清单只允许修改声明过的 Code OSS 路径，并要求每个源文件真实存在。
import { readFile, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDirectory, "../..");
const manifest = JSON.parse(await readFile(resolve(scriptDirectory, "overlay-manifest.json"), "utf8"));
const allowedRoots = [
  "product.json",
  "src/vs/workbench/contrib/independentAiIde/",
];
const allowedModes = new Set(["copy", "merge-json"]);
const targets = [];

for (const entry of manifest.entries) {
  if (!allowedRoots.some(root => entry.target === root || entry.target.startsWith(root))) {
    throw new Error(`Overlay 包含未批准目标：${entry.target}`);
  }
  if (!allowedModes.has(entry.mode)) {
    throw new Error(`Overlay 使用未批准模式：${entry.mode}`);
  }

  const sourcePath = resolve(projectRoot, entry.source);
  await stat(sourcePath);
  targets.push(entry.target);
}

if (new Set(targets).size !== targets.length) {
  throw new Error("Overlay 目标存在重复路径");
}

console.log(`Code OSS Overlay 清单通过：${targets.length} 个目标`);
