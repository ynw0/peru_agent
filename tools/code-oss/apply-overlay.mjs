// 将经过白名单校验的 Overlay 应用到固定 Code OSS 副本。
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyCodeOssTree } from "./source-utils.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDirectory, "../..");
const pin = JSON.parse(await readFile(resolve(scriptDirectory, "source-pin.json"), "utf8"));
const manifest = JSON.parse(await readFile(resolve(scriptDirectory, "overlay-manifest.json"), "utf8"));
const codeOssRoot = resolve(projectRoot, "upstream", `code-oss-${pin.version}`);

// Overlay 只能应用到仍与原始归档关键文件一致的上游树。
await verifyCodeOssTree(codeOssRoot, pin);

for (const entry of manifest.entries) {
  const source = resolve(projectRoot, entry.source);
  const target = resolve(codeOssRoot, entry.target);
  await mkdir(dirname(target), { recursive: true });

  if (entry.mode === "copy") {
    await copyFile(source, target);
    continue;
  }

  if (entry.mode === "merge-json") {
    const base = JSON.parse(await readFile(target, "utf8"));
    const overlay = JSON.parse(await readFile(source, "utf8"));
    const deletedKeys = Array.isArray(overlay.$delete) ? overlay.$delete : [];
    delete overlay.$delete;
    const merged = { ...base, ...overlay };
    for (const key of deletedKeys) {
      delete merged[key];
    }
    await writeFile(target, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
    continue;
  }

  if (entry.mode === "insert-before") {
    const targetText = await readFile(target, "utf8");
    const insertion = await readFile(source, "utf8");
    const occurrenceCount = targetText.split(entry.anchor).length - 1;
    if (occurrenceCount !== 1) {
      throw new Error(`Overlay 锚点必须且只能出现一次：${entry.target}`);
    }
    if (targetText.includes(insertion.trim())) {
      throw new Error(`Overlay 导入已存在，拒绝重复应用：${entry.target}`);
    }
    await writeFile(target, targetText.replace(entry.anchor, `${insertion}${entry.anchor}`), "utf8");
    continue;
  }

  throw new Error(`不支持的 Overlay 模式：${entry.mode}`);
}

console.log(`Code OSS Overlay 应用成功：${manifest.entries.length} 个操作`);
