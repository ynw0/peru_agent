// Phase 9 静态安全契约：网络与浏览器实现不得绕过统一出口和 Typed IPC。
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const root = resolve(scriptDirectory, "../..");

const files = {
  broker: "src/egress/broker.ts",
  transport: "src/egress/node-http-transport.ts",
  browserRuntime: "src/browser/browser-runtime.ts",
  proxyVerifier: "src/browser/proxy-verifier.ts",
  playwright: "src/browser/playwright-driver.ts",
  downloadStore: "src/web/download-store.ts",
  ipc: "src/ipc/protocol.ts",
  overlayView: "overlays/code-oss/src/vs/workbench/contrib/independentAiIde/browser/independentAiIdeView.ts",
  overlayBridge: "overlays/code-oss/src/vs/workbench/contrib/independentAiIde/common/independentAiIdeWorkbenchBridge.ts",
};

const texts = Object.fromEntries(await Promise.all(Object.entries(files).map(async ([key, path]) => [
  key,
  await readFile(resolve(root, path), "utf8"),
])));

requireAll(texts.broker, [
  "normalizeEgressUrl",
  "this.resolver.resolve",
  "assertAddressesAllowed",
  "selectedAddress",
  "consumeLease",
  "REDIRECT_STATUSES",
  "await this.authorize",
], "Egress Broker");
requireAll(texts.transport, [
  "lookup:",
  "request.selectedAddress",
  "request.maxResponseBytes",
  "request.timeoutMs",
  "signal.addEventListener(\"abort\"",
], "固定 IP Transport");
requireAll(texts.browserRuntime, [
  'driver.egressEnforcement !== "broker-proxy"',
  "this.broker.authorize",
  "assertTargetCurrent",
  "acceptActionResult",
  "受控下载服务未配置",
  "proxyVerifier.verify",
], "Browser Runtime");
requireAll(texts.proxyVerifier, [
  "BROWSER_PROXY_PROTOCOL_VERSION",
  'enforcement: "egress-broker"',
  "/.well-known/independent-ai-ide-egress-health",
], "Browser Proxy Verifier");
requireAll(texts.playwright, [
  "proxy: { server: request.proxyServerUrl }",
  'context.route("**/*"',
  "await request.authorizeResource",
  "await route.continue()",
  "acceptDownloads: false",
  "verifyTarget",
], "Playwright Driver");
requireAll(texts.downloadStore, [
  'flag: "wx"',
  "await rename(temporaryPath, finalPath)",
  "assertInside",
  "sanitizeFileName",
], "Download Artifact Store");
requireAll(texts.ipc, [
  'readonly "web.download"',
  'readonly "browser.download"',
], "Typed IPC 网络方法");
const protocolMatch = texts.ipc.match(/IPC_PROTOCOL_VERSION\s*=\s*(\d+)/);
if (protocolMatch === null || Number(protocolMatch[1]) < 5) {
  throw new Error("网络与 Browser Runtime 要求 Typed IPC Version >= 5");
}
requireAll(texts.overlayBridge, [
  "downloadBrowser",
  "navigateBrowser",
  "clickBrowser",
], "Workbench Bridge");

for (const forbidden of [
  /from\s+['"]node:fs/,
  /from\s+['"]node:child_process/,
  /\bfetch\s*\(/,
  /XMLHttpRequest/,
  /WebSocket\s*\(/,
]) {
  if (forbidden.test(texts.overlayView) || forbidden.test(texts.overlayBridge)) {
    throw new Error(`Code OSS Browser View 存在越过 Bridge 的能力：${String(forbidden)}`);
  }
}

const authorizeIndex = texts.playwright.indexOf("await request.authorizeResource");
const continueIndex = texts.playwright.indexOf("await route.continue()", authorizeIndex);
if (authorizeIndex < 0 || continueIndex < authorizeIndex) {
  throw new Error("Playwright Route 必须先完成资源授权，再继续请求");
}

if (/\bfetch\s*\(/.test(texts.playwright) || /page\.request/.test(texts.playwright)) {
  throw new Error("Playwright Driver 不得创建绕过代理的直接网络请求");
}

console.log("Phase 9 网络与浏览器源码安全契约通过");

function requireAll(text, required, label) {
  for (const token of required) {
    if (!text.includes(token)) throw new Error(`${label} 缺少安全契约：${token}`);
  }
}
