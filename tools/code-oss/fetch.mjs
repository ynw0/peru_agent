// 严格获取固定 Code OSS 版本：网络、Git、Tag 或 Commit 任一不匹配都失败。
import { mkdir, readFile, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDirectory, "../..");
const pin = JSON.parse(await readFile(resolve(scriptDirectory, "source-pin.json"), "utf8"));
const target = resolve(projectRoot, "upstream", `code-oss-${pin.tag}`);

function run(command, args, cwd = projectRoot) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { cwd, stdio: "inherit", shell: false });
    child.once("error", rejectPromise);
    child.once("exit", code => {
      if (code === 0) {
        resolvePromise();
      } else {
        rejectPromise(new Error(`${command} 执行失败，退出码：${String(code)}`));
      }
    });
  });
}

async function pathExists(path) {
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

await mkdir(dirname(target), { recursive: true });
if (!await pathExists(target)) {
  await run("git", [
    "clone",
    "--filter=blob:none",
    "--single-branch",
    "--branch",
    pin.tag,
    pin.repository,
    target,
  ]);
}

const output = [];
await new Promise((resolvePromise, rejectPromise) => {
  const child = spawn("git", ["rev-parse", "HEAD"], { cwd: target, shell: false });
  child.stdout.on("data", chunk => output.push(chunk));
  child.stderr.pipe(process.stderr);
  child.once("error", rejectPromise);
  child.once("exit", code => code === 0
    ? resolvePromise()
    : rejectPromise(new Error(`git rev-parse 执行失败，退出码：${String(code)}`)));
});

const actualCommit = Buffer.concat(output).toString("utf8").trim();
if (actualCommit !== pin.commit) {
  throw new Error(`Code OSS Commit 不匹配：期望 ${pin.commit}，实际 ${actualCommit}`);
}

console.log(`Code OSS ${pin.tag} 获取并校验成功：${actualCommit}`);
