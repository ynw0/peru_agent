// 验证产品身份、Workbench 导入和四个原生视图确实写入 Code OSS 源码。
import { readFile, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDirectory, "../..");
const pin = JSON.parse(await readFile(resolve(scriptDirectory, "source-pin.json"), "utf8"));
const codeOssRoot = resolve(projectRoot, "upstream", `code-oss-${pin.version}`);
const product = JSON.parse(await readFile(resolve(codeOssRoot, "product.json"), "utf8"));
const desktopMain = await readFile(resolve(codeOssRoot, "src/vs/workbench/workbench.desktop.main.ts"), "utf8");
const contributionPath = resolve(codeOssRoot, "src/vs/workbench/contrib/independentAiIde/browser/independentAiIde.contribution.ts");
const contribution = await readFile(contributionPath, "utf8");
const identifiers = await readFile(resolve(codeOssRoot, "src/vs/workbench/contrib/independentAiIde/common/independentAiIde.ts"), "utf8");

const expectedProduct = {
  nameShort: "Independent AI IDE",
  applicationName: "independent-ai-ide",
  dataFolderName: ".independent-ai-ide",
  urlProtocol: "independent-ai-ide",
  win32AppUserModelId: "IndependentAIIde.Desktop",
};
for (const [key, value] of Object.entries(expectedProduct)) {
  if (product[key] !== value) {
    throw new Error(`Code OSS 产品字段未正确覆盖：${key}`);
  }
}
if ("reportIssueUrl" in product || "webviewContentExternalBaseUrlTemplate" in product) {
  throw new Error("Code OSS 产品配置仍包含未批准的 Microsoft 在线服务字段");
}
if (!Array.isArray(product.builtInExtensions) || product.builtInExtensions.length !== 0) {
  throw new Error("Code OSS 内置远程扩展列表必须为空");
}

const importLine = "import 'vs/workbench/contrib/independentAiIde/browser/independentAiIde.contribution';";
if (desktopMain.split(importLine).length - 1 !== 1) {
  throw new Error("Independent AI IDE Workbench contribution 必须且只能导入一次");
}

for (const id of [
  "independentAiIde.agent",
  "independentAiIde.tasks",
  "independentAiIde.permissions",
  "independentAiIde.browser",
]) {
  if (!identifiers.includes(`'${id}'`)) {
    throw new Error(`Workbench contribution 缺少容器定义：${id}`);
  }
}
await stat(contributionPath);
console.log("Code OSS Overlay 应用结果验证通过");
