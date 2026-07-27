import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(new URL("../..", import.meta.url).pathname);
const requiredFiles = [
  "native/windows-ui-automation-broker/IndependentAiIde.WindowsUiAutomationBroker.csproj",
  "native/windows-ui-automation-broker/Program.cs",
  "native/windows-ui-automation-broker/Protocol/JsonLinesServer.cs",
  "native/windows-ui-automation-broker/Identity/ApplicationIdentityService.cs",
  "native/windows-ui-automation-broker/UiAutomation/UiAutomationService.cs",
  "native/windows-ui-automation-broker/Security/NativeMethods.cs",
  "src/computer-use/runtime.ts",
  "src/computer-use/certification.ts",
  "src/computer-use/computer-tools.ts",
];
for (const file of requiredFiles) await stat(resolve(root, file));

const identity = await readFile(resolve(root, "native/windows-ui-automation-broker/Identity/ApplicationIdentityService.cs"), "utf8");
const automation = await readFile(resolve(root, "native/windows-ui-automation-broker/UiAutomation/UiAutomationService.cs"), "utf8");
const native = await readFile(resolve(root, "native/windows-ui-automation-broker/Security/NativeMethods.cs"), "utf8");
const runtime = await readFile(resolve(root, "src/computer-use/runtime.ts"), "utf8");
const tools = await readFile(resolve(root, "src/computer-use/computer-tools.ts"), "utf8");
const view = await readFile(resolve(root, "overlays/code-oss/src/vs/workbench/contrib/independentAiIde/browser/independentAiIdeView.ts"), "utf8");
const bridge = await readFile(resolve(root, "overlays/code-oss/src/vs/workbench/contrib/independentAiIde/common/independentAiIdeWorkbenchBridge.ts"), "utf8");

const requiredIdentity = [
  "X509Certificate.CreateFromSignedFile",
  "SHA256.HashData",
  "GetWindowThreadProcessId",
  "GetThreadDesktop",
  "OpenProcessToken",
  "FileVersionInfo.GetVersionInfo",
];
const requiredAutomation = [
  "AutomationElement.FromHandle",
  "TreeWalker.RawViewWalker",
  "InvokePattern.Pattern",
  "ValuePattern.Pattern",
  "SelectionItemPattern.Pattern",
  "TogglePattern.Pattern",
  "PrintWindow",
  "IdentityFingerprint(currentIdentity)",
  "var after = Inspect(request.WindowHandle",
  "element.Current.IsPassword",
];
const requiredNative = ["EnumWindows", "GetWindowThreadProcessId", "PrintWindow", "SendInput"];
for (const snippet of requiredIdentity) if (!identity.includes(snippet)) throw new Error(`应用身份源码缺少：${snippet}`);
for (const snippet of requiredAutomation) if (!automation.includes(snippet)) throw new Error(`UI Automation 源码缺少：${snippet}`);
for (const snippet of requiredNative) if (!native.includes(snippet)) throw new Error(`Win32 声明缺少：${snippet}`);

for (const forbidden of ["Process.Start(", "SendKeys.SendWait", "mouse_event(", "keybd_event(", "ShellExecute("]) {
  if (`${identity}\n${automation}\n${native}`.includes(forbidden)) throw new Error(`Computer Use Broker 禁止使用：${forbidden}`);
}

for (const snippet of [
  "未认证应用只允许检查，禁止交互",
  "敏感或安全窗口禁止 Computer Use 交互",
  "输入文本在授权后发生变化",
  "动作后应用不再满足认证清单",
]) {
  if (!runtime.includes(snippet)) throw new Error(`Computer Use Runtime 缺少安全门禁：${snippet}`);
}
if (!tools.includes('capabilities: ["computer.interact"]') || !tools.includes("certifiedComputerApplication: true")) {
  throw new Error("Computer Use 交互 Tool 未绑定 computer.interact 与认证应用证据");
}
for (const forbidden of ["clickComputer(", "typeComputer(", "executeComputer("]) {
  if (`${view}\n${bridge}`.includes(forbidden)) throw new Error(`Workbench 不得暴露直接 Computer Use 交互：${forbidden}`);
}
for (const forbiddenImport of ["node:fs", "node:child_process", "fetch(", "XMLHttpRequest", "WebSocket"]) {
  if (view.includes(forbiddenImport)) throw new Error(`Computer Use View 不得持有系统能力：${forbiddenImport}`);
}

console.log("Computer Use 与 Windows UI Automation Broker 源码契约检查通过");
