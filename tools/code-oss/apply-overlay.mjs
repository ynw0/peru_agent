// 将经过白名单校验的 Overlay 应用到固定 Code OSS 副本。
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDirectory, "../..");
const pin = JSON.parse(await readFile(resolve(scriptDirectory, "source-pin.json"), "utf8"));
const manifest = JSON.parse(await readFile(resolve(scriptDirectory, "overlay-manifest.json"), "utf8"));
const codeOssRoot = resolve(projectRoot, "upstream", `code-oss-${pin.tag}`);

function readGitHead() {
  return new Promise((resolvePromise, rejectPromise) => {
    const chunks = [];
    const child = spawn("git", ["rev-parse", "HEAD"], { cwd: codeOssRoot, shell: false });
    child.stdout.on("data", chunk => chunks.push(chunk));
    child.stderr.pipe(process.stderr);
    child.once("error", rejectPromise);
    child.once("exit", code => code === 0
      ? resolvePromise(Buffer.concat(chunks).toString("utf8").trim())
      : rejectPromise(new Error(`无法读取 Code OSS HEAD，退出码：${String(code)}`)));
  });
}

const actualCommit = await readGitHead();
if (actualCommit !== pin.commit || manifest.sourceCommit !== pin.commit) {
  throw new Error("Code OSS 源码或 Overlay 清单与固定 Commit 不一致");
}

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
    const merged = { ...base, ...overlay };
    await writeFile(target, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
    continue;
  }

  throw new Error(`不支持的 Overlay 模式：${entry.mode}`);
}

console.log(`Code OSS Overlay 应用成功：${manifest.entries.length} 个文件`);
