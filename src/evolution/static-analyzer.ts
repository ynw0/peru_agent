import type { Capability } from "../agent-protocol.js";
import { digestValue, sha256Text } from "./canonical.js";
import type {
  EvolutionCandidateRecord,
  SkillCandidatePayload,
  StaticAnalysisFinding,
  StaticAnalysisReport,
  ToolCandidatePayload,
} from "./types.js";

const FORBIDDEN_SOURCE_PATTERNS: readonly { readonly code: string; readonly pattern: RegExp; readonly message: string }[] = [
  { code: "DYNAMIC_EVAL", pattern: /\b(?:eval|Function)\s*\(/, message: "禁止动态代码执行" },
  { code: "DYNAMIC_IMPORT", pattern: /\bimport\s*\(/, message: "禁止动态 import" },
  { code: "COMMONJS_REQUIRE", pattern: /\brequire\s*\(/, message: "禁止 CommonJS require" },
  { code: "PROCESS_ACCESS", pattern: /\bprocess\s*\./, message: "禁止直接访问 process" },
  { code: "NETWORK_ACCESS", pattern: /\b(?:fetch|XMLHttpRequest|WebSocket)\b/, message: "禁止直接访问网络 API" },
  { code: "RUNTIME_ESCAPE", pattern: /\b(?:Deno|Bun|WebAssembly)\b/, message: "禁止访问其他运行时或 WebAssembly" },
  { code: "TS_SUPPRESSION", pattern: /@ts-(?:ignore|nocheck)/, message: "禁止关闭 TypeScript 检查" },
  { code: "PROTOTYPE_MUTATION", pattern: /\bprototype\s*[.[]/, message: "禁止修改原型链" },
  { code: "GLOBAL_MUTATION", pattern: /\bglobalThis\s*[.[]/, message: "禁止修改全局对象" },
];

const FORBIDDEN_IMPORTS = new Set([
  "node:fs", "node:fs/promises", "node:child_process", "node:net", "node:http", "node:https",
  "node:dgram", "node:tls", "node:worker_threads", "node:vm", "node:module", "node:os",
]);

const ALLOWED_SDK_IMPORT = "@independent-ai-ide/tool-sdk";
const SECURITY_CORE_PATHS = [
  "permission-engine", "sandbox", "signing", "credential", "self-evolution", "evolution/validation",
  "auto-update", "windows-ui-automation-broker", "windows-sandbox-broker",
];

// 静态分析是保守门禁，不是沙箱替代品；任何未知语法或依赖都按失败处理。
export class CandidateStaticAnalyzer {
  public analyze(candidate: EvolutionCandidateRecord): StaticAnalysisReport {
    return candidate.kind === "tool"
      ? this.analyzeTool(candidate.payload as ToolCandidatePayload)
      : this.analyzeSkill(candidate.payload as SkillCandidatePayload);
  }

  private analyzeTool(payload: ToolCandidatePayload): StaticAnalysisReport {
    const findings: StaticAnalysisFinding[] = [];
    const source = `${payload.source}\n${payload.testSource}`;
    const imports = extractImports(source);

    for (const imported of imports) {
      if (imported !== ALLOWED_SDK_IMPORT) {
        findings.push({
          severity: "error",
          code: FORBIDDEN_IMPORTS.has(imported) ? "FORBIDDEN_NODE_IMPORT" : "UNDECLARED_DEPENDENCY",
          message: `候选只能依赖受限 Tool SDK，发现：${imported}`,
        });
      }
    }

    for (const rule of FORBIDDEN_SOURCE_PATTERNS) {
      const match = rule.pattern.exec(source);
      if (match !== null) {
        findings.push({
          severity: "error",
          code: rule.code,
          message: rule.message,
          line: lineNumber(source, match.index),
        });
      }
    }

    for (const protectedPath of SECURITY_CORE_PATHS) {
      if (source.toLocaleLowerCase("en-US").includes(protectedPath)) {
        findings.push({
          severity: "error",
          code: "SECURITY_CORE_REFERENCE",
          message: `候选不得引用或修改安全核心：${protectedPath}`,
        });
      }
    }

    const observed = detectSdkCapabilities(source);
    const declared = [...payload.manifest.capabilities];
    for (const capability of observed) {
      if (!declared.includes(capability)) {
        findings.push({
          severity: "error",
          code: "UNDECLARED_CAPABILITY",
          message: `源码使用了未声明能力：${capability}`,
        });
      }
    }

    if (payload.manifest.riskLevel === "pure-compute") {
      if (observed.length > 0 || imports.length > 0) {
        findings.push({
          severity: "error",
          code: "PURE_COMPUTE_SIDE_EFFECT",
          message: "纯计算 Tool 不得导入 SDK 或访问工作区",
        });
      }
    } else if (payload.manifest.riskLevel === "workspace-read") {
      if (declared.some(capability => capability !== "workspace.read")) {
        findings.push({
          severity: "error",
          code: "READ_TOOL_EXTRA_CAPABILITY",
          message: "严格只读 Tool 只能声明 workspace.read",
        });
      }
      if (observed.some(capability => capability !== "workspace.read")) {
        findings.push({
          severity: "error",
          code: "READ_TOOL_SIDE_EFFECT",
          message: "严格只读 Tool 使用了写入或外部能力",
        });
      }
    }

    if (!/\bdefineTool\s*\(/.test(payload.source)) {
      findings.push({ severity: "error", code: "MISSING_DEFINE_TOOL", message: "候选必须通过 defineTool 声明入口" });
    }
    if (!/\b(?:test|property|fuzz)\s*\(/.test(payload.testSource)) {
      findings.push({ severity: "error", code: "MISSING_TESTS", message: "候选必须包含单元、属性或模糊测试" });
    }

    return {
      passed: findings.every(item => item.severity !== "error"),
      sourceSha256: sha256Text(source),
      declaredCapabilities: declared,
      observedCapabilities: observed,
      findings,
    };
  }

  private analyzeSkill(payload: SkillCandidatePayload): StaticAnalysisReport {
    const findings: StaticAnalysisFinding[] = [];
    const observed = [...new Set(payload.toolManifests.flatMap(manifest => manifest.capabilities))];
    const stepIds = new Set<string>();
    for (const step of payload.steps) {
      if (stepIds.has(step.id)) {
        findings.push({ severity: "error", code: "DUPLICATE_SKILL_STEP", message: `重复 Skill 步骤：${step.id}` });
      }
      stepIds.add(step.id);
      if (SECURITY_CORE_PATHS.some(value => step.instruction.toLocaleLowerCase("en-US").includes(value))) {
        findings.push({ severity: "error", code: "SECURITY_CORE_REFERENCE", message: "Skill 不得要求修改安全核心" });
      }
    }
    if (payload.steps.length === 0) {
      findings.push({ severity: "error", code: "EMPTY_SKILL", message: "Skill 至少包含一个步骤" });
    }
    return {
      passed: findings.every(item => item.severity !== "error"),
      sourceSha256: digestValue(payload),
      declaredCapabilities: observed,
      observedCapabilities: observed,
      findings,
    };
  }
}

function extractImports(source: string): readonly string[] {
  const results: string[] = [];
  const expression = /\b(?:import|export)\s+(?:[^'";]+?\s+from\s+)?["']([^"']+)["']/g;
  for (const match of source.matchAll(expression)) {
    const imported = match[1];
    if (imported !== undefined) results.push(imported);
  }
  return [...new Set(results)].sort();
}

function detectSdkCapabilities(source: string): Capability[] {
  const capabilities = new Set<Capability>();
  if (/\bworkspace\.(?:readText|glob|grep|stat)\s*\(/.test(source)) capabilities.add("workspace.read");
  if (/\bworkspace\.(?:writeText|edit|delete|applyPatch)\s*\(/.test(source)) capabilities.add("workspace.write");
  if (/\bprocess\.(?:execute|spawn|run)\s*\(/.test(source)) capabilities.add("process.execute");
  if (/\bnetwork\.(?:fetch|request)\s*\(/.test(source)) capabilities.add("network.internet");
  if (/\bbrowser\.(?:navigate|click|type)\s*\(/.test(source)) capabilities.add("browser.interact");
  if (/\bcomputer\.(?:click|type|shortcut)\s*\(/.test(source)) capabilities.add("computer.interact");
  return [...capabilities].sort();
}

function lineNumber(source: string, index: number): number {
  return source.slice(0, index).split("\n").length;
}
