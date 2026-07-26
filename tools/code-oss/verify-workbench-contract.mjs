// 在完整编译前检查 Overlay 使用的 Code OSS 内部模块、图标和关键 Registry API。
import { readFile, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDirectory, "../..");
const pin = JSON.parse(await readFile(resolve(scriptDirectory, "source-pin.json"), "utf8"));
const codeOssRoot = resolve(projectRoot, "upstream", `code-oss-${pin.version}`);
const overlayRoot = resolve(projectRoot, "overlays/code-oss/src");
const contributionPath = resolve(
  overlayRoot,
  "vs/workbench/contrib/independentAiIde/browser/independentAiIde.contribution.ts",
);
const viewPath = resolve(
  overlayRoot,
  "vs/workbench/contrib/independentAiIde/browser/independentAiIdeView.ts",
);
const contribution = await readFile(contributionPath, "utf8");
const view = await readFile(viewPath, "utf8");
const sourceTexts = [contribution, view];

async function internalModuleExists(moduleId) {
  const base = resolve(codeOssRoot, "src", moduleId);
  for (const suffix of [".ts", ".tsx", "/index.ts"]) {
    try {
      await stat(`${base}${suffix}`);
      return true;
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) {
        throw error;
      }
    }
  }
  return false;
}

for (const text of sourceTexts) {
  const imports = [...text.matchAll(/from\s+'(vs\/[^']+)'/g)].map(match => match[1]);
  for (const moduleId of imports) {
    if (!await internalModuleExists(moduleId)) {
      throw new Error(`Overlay 引用了 Code OSS 1.74.0 中不存在的模块：${moduleId}`);
    }
  }
}

const codiconsSource = await readFile(resolve(codeOssRoot, "src/vs/base/common/codicons.ts"), "utf8");
const iconNames = [...contribution.matchAll(/Codicon\.([A-Za-z0-9_]+)/g)].map(match => match[1]);
for (const iconName of iconNames) {
  if (!codiconsSource.includes(`static readonly ${iconName} `)) {
    throw new Error(`Overlay 使用了 Code OSS 1.74.0 中不存在的 Codicon：${iconName}`);
  }
}

const viewsSource = await readFile(resolve(codeOssRoot, "src/vs/workbench/common/views.ts"), "utf8");
for (const requiredApi of [
  "registerViewContainer(viewContainerDescriptor",
  "registerViews(views: IViewDescriptor[]",
  "ViewContainerLocation",
]) {
  if (!viewsSource.includes(requiredApi)) {
    throw new Error(`Code OSS 1.74.0 缺少 Overlay 需要的 Workbench API：${requiredApi}`);
  }
}

const viewPaneSource = await readFile(
  resolve(codeOssRoot, "src/vs/workbench/browser/parts/views/viewPane.ts"),
  "utf8",
);
if (!viewPaneSource.includes("export abstract class ViewPane") || !viewPaneSource.includes("renderBody(container: HTMLElement)")) {
  throw new Error("Code OSS 1.74.0 ViewPane API 与 Overlay 预期不一致");
}

console.log(`Code OSS ${pin.version} Workbench API 契约检查通过`);
