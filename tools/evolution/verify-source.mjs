import { readFile, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const requiredFiles = [
  "src/evolution/gap-detector.ts",
  "src/evolution/forge.ts",
  "src/evolution/static-analyzer.ts",
  "src/evolution/validator.ts",
  "src/evolution/registry.ts",
  "src/evolution/signing.ts",
  "src/evolution/runtime.ts",
  "src/runtime/evolution-ipc-bridge.ts",
];
for (const file of requiredFiles) await stat(resolve(root, file));

const runtime = await readFile(resolve(root, "src/evolution/runtime.ts"), "utf8");
const signing = await readFile(resolve(root, "src/evolution/signing.ts"), "utf8");
const protocol = await readFile(resolve(root, "src/ipc/protocol.ts"), "utf8");
const bridge = await readFile(resolve(root, "src/runtime/evolution-ipc-bridge.ts"), "utf8");
const view = await readFile(resolve(root, "overlays/code-oss/src/vs/workbench/contrib/independentAiIde/browser/independentAiIdeView.ts"), "utf8");
const contribution = await readFile(resolve(root, "overlays/code-oss/src/vs/workbench/contrib/independentAiIde/browser/independentAiIde.contribution.ts"), "utf8");

const violations = [];
if (/import[^\n]+ToolRegistry|new\s+ToolRegistry|tools?\.register\s*\(/.test(runtime)) violations.push("Evolution Runtime 不得直接注册候选 Tool");
if (!runtime.includes("awaitingManualApproval") || !runtime.includes("manualApproval")) violations.push("高权限人工审批门禁缺失");
if (!runtime.includes("digestCandidate(candidate)") || !runtime.includes("candidate.artifact.candidateDigest")) violations.push("晋级前候选 Digest 重验缺失");
if (!signing.includes("ed25519") || !signing.includes("cryptoVerify")) violations.push("Ed25519 独立验签缺失");
if (!signing.includes("decisionSignatureBase64") || !signing.includes("whitelistDecisionPayload")) violations.push("Signed Whitelist 状态决策签名缺失");
if (!runtime.includes("commitCandidateAndWhitelist")) violations.push("候选与 Signed Whitelist 原子提交缺失");
if (/privateKeyPem/.test(protocol) || /privateKeyPem/.test(bridge) || /privateKeyPem/.test(view)) violations.push("签名私钥泄露到 IPC 或 Workbench");
for (const token of ["evolution.candidate.validate", "evolution.candidate.approve", "evolution.candidate.promote", "evolution.candidate.rollback"]) {
  if (!protocol.includes(token) || !bridge.includes(token)) violations.push(`Evolution IPC 缺少：${token}`);
}
for (const kind of ["'agent'", "'tasks'", "'permissions'", "'browser'", "'computer'", "'evolution'"]) {
  if (!view.includes(`case ${kind}:`)) violations.push(`Workbench ViewKind 缺少渲染分支：${kind}`);
}
if (!contribution.includes("Codicon.beaker") || !contribution.includes("evolutionContainer")) violations.push("Candidate Center 容器未注册");
if (/from\s+['"](?:node:fs|node:child_process)['"]|\bfetch\s*\(/.test(view)) violations.push("Candidate Center 不得直接访问文件、进程或网络");

if (violations.length > 0) {
  console.error("Evolution 源码契约检查失败：");
  for (const violation of violations) console.error(`- ${violation}`);
  process.exitCode = 1;
} else {
  console.log("Evolution 源码契约检查通过：候选隔离、人工审批、Digest 重验、签名与 Workbench 边界有效");
}
