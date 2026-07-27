import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IncrementingIdGenerator } from "../src/agent/id-generator.js";
import { CapabilityGapDetector } from "../src/evolution/gap-detector.js";
import { SkillForge, ToolForge } from "../src/evolution/forge.js";
import { InMemoryCandidateRegistry, JsonCandidateRegistry, type CandidateRegistry } from "../src/evolution/registry.js";
import { EvolutionRuntime } from "../src/evolution/runtime.js";
import { CandidateSigner, SignedWhitelistTrustStore, digestCandidate } from "../src/evolution/signing.js";
import { CandidateStaticAnalyzer } from "../src/evolution/static-analyzer.js";
import type {
  EvolutionCandidateRecord,
  ReviewerAttestation,
  SandboxEvaluationAttestation,
  SignedWhitelistEntry,
  ToolCandidatePayload,
  ValidationGate,
} from "../src/evolution/types.js";
import {
  CandidateValidationPipeline,
  type CandidateReviewer,
  type CandidateSandboxEvaluator,
} from "../src/evolution/validator.js";
import { TypedIpcClient, TypedIpcServer } from "../src/ipc/channel.js";
import { IPC_PROTOCOL_VERSION } from "../src/ipc/protocol.js";
import { createInMemoryTransportPair } from "../src/ipc/transport.js";
import { isIpcMessage } from "../src/ipc/validation.js";
import { EvolutionIpcBridge } from "../src/runtime/evolution-ipc-bridge.js";
import { WorkbenchController } from "../src/workbench/workbench-controller.js";

const NOW = "2026-07-27T12:00:00.000Z";
const REQUIRED_GATES: readonly ValidationGate[] = [
  "unit-tests", "property-tests", "fuzz-tests", "adversarial-tests",
  "sandbox-dynamic", "capability-consistency", "reproducible-package",
];

class PassingEvaluator implements CandidateSandboxEvaluator {
  public async evaluate(candidate: EvolutionCandidateRecord): Promise<SandboxEvaluationAttestation> {
    const digest = digestCandidate(candidate);
    return {
      evaluatorId: "windows-sandbox-evaluator",
      environmentFingerprint: "sandbox-image-sha256:" + "a".repeat(64),
      isolated: true,
      candidateDigest: digest,
      gates: REQUIRED_GATES.map(gate => ({
        gate,
        passed: true,
        summary: `${gate} passed`,
        evidenceSha256: "b".repeat(64),
        completedAt: NOW,
      })),
    };
  }
}


class FailingAtomicCommitRegistry extends InMemoryCandidateRegistry {
  public override async commitCandidateAndWhitelist(
    _candidate: EvolutionCandidateRecord,
    _entry: SignedWhitelistEntry,
  ): Promise<void> {
    throw new Error("simulated atomic commit failure");
  }
}

class Reviewer implements CandidateReviewer {
  public constructor(public readonly reviewerId: string, private readonly approved = true) {}
  public async review(_candidate: EvolutionCandidateRecord, digest: string): Promise<ReviewerAttestation> {
    return {
      reviewerId: this.reviewerId,
      approved: this.approved,
      summary: this.approved ? "approved" : "rejected",
      reviewedDigest: digest,
      completedAt: NOW,
    };
  }
}

function keys() {
  const pair = generateKeyPairSync("ed25519");
  const privateExport = pair.privateKey.export({ type: "pkcs8", format: "pem" });
  const publicExport = pair.publicKey.export({ type: "spki", format: "pem" });
  return {
    privateKeyPem: typeof privateExport === "string" ? privateExport : Buffer.from(privateExport).toString("utf8"),
    publicKeyPem: typeof publicExport === "string" ? publicExport : Buffer.from(publicExport).toString("utf8"),
  };
}

function payload(riskLevel: "pure-compute" | "workspace-read" | "workspace-write" = "pure-compute"): ToolCandidatePayload {
  const capabilities = riskLevel === "pure-compute" ? [] : riskLevel === "workspace-read" ? ["workspace.read" as const] : ["workspace.write" as const];
  const body = riskLevel === "workspace-read"
    ? `import { defineTool, workspace } from "@independent-ai-ide/tool-sdk";\nexport default defineTool({ execute: () => workspace.readText("README.md") });`
    : riskLevel === "workspace-write"
      ? `import { defineTool, workspace } from "@independent-ai-ide/tool-sdk";\nexport default defineTool({ execute: () => workspace.writeText("x.txt", "x") });`
      : `export default defineTool({ execute: (input: unknown) => input });`;
  return {
    manifest: {
      name: `Candidate${riskLevel.replace(/-/g, "")}`,
      version: "0.1.0-candidate",
      description: "candidate",
      riskLevel,
      capabilities,
      generated: true,
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    source: body,
    testSource: `test("unit", () => {}); property("property", () => {}); fuzz("fuzz", () => {});`,
    sdkVersion: "1.0.0",
  };
}

function createRuntime(registry: CandidateRegistry = new InMemoryCandidateRegistry()) {
  const signingKeys = keys();
  const ids = new IncrementingIdGenerator();
  const pipeline = new CandidateValidationPipeline(
    new CandidateStaticAnalyzer(),
    new PassingEvaluator(),
    [new Reviewer("reviewer-one"), new Reviewer("reviewer-two")],
    () => NOW,
  );
  const signer = new CandidateSigner({ keyId: "release-key-1", privateKeyPem: signingKeys.privateKeyPem }, () => NOW);
  const trust = new SignedWhitelistTrustStore([{ keyId: "release-key-1", publicKeyPem: signingKeys.publicKeyPem, enabled: true }]);
  return new EvolutionRuntime(registry, ids, pipeline, signer, trust, { actorId: "system", now: () => NOW });
}

test("Gap Detector 只在重复证据达到阈值后创建候选 Gap，并清理敏感证据", () => {
  const detector = new CapabilityGapDetector(new IncrementingIdGenerator(), { minimumOccurrences: 2, now: () => NOW });
  detector.observe({ workspaceId: "workspace", sessionId: "s1", outcome: "解析专有格式", missingCapability: "workspace.read", evidence: ["api_key=secret"] });
  assert.equal(detector.listProposals().length, 0);
  detector.observe({ workspaceId: "workspace", sessionId: "s2", outcome: "解析专有格式", missingCapability: "workspace.read", evidence: ["缺少解析工具"] });
  assert.equal(detector.listProposals().length, 1);
  assert.equal(detector.listObservations()[0]?.evidence[0], "[REDACTED_SENSITIVE_EVIDENCE]");
});

test("静态分析拒绝未声明依赖、网络与安全核心引用", async () => {
  const runtime = createRuntime();
  const unsafe = payload();
  const candidate = await runtime.createToolCandidate({
    ...unsafe,
    source: `import fs from "node:fs"; export default defineTool({ execute: () => fetch("https://example.com/permission-engine") });`,
  }, []);
  const report = new CandidateStaticAnalyzer().analyze(candidate);
  assert.equal(report.passed, false);
  assert.ok(report.findings.some(item => item.code === "FORBIDDEN_NODE_IMPORT"));
  assert.ok(report.findings.some(item => item.code === "NETWORK_ACCESS"));
  assert.ok(report.findings.some(item => item.code === "SECURITY_CORE_REFERENCE"));
});

test("纯计算 Tool 完整验证后自动签名晋级", async () => {
  const runtime = createRuntime();
  const candidate = await runtime.createToolCandidate(payload(), ["gap-1"]);
  const promoted = await runtime.validate(candidate.id, new AbortController().signal);
  assert.equal(promoted.status, "promoted");
  assert.equal(promoted.validation?.autoPromotionAllowed, true);
  assert.equal((await runtime.listWhitelist())[0]?.promotionMode, "automatic");
});

test("严格工作区只读 Tool 可以自动晋级，但写入 Tool 永远等待人工审批", async () => {
  const readRuntime = createRuntime();
  const read = await readRuntime.createToolCandidate(payload("workspace-read"), []);
  assert.equal((await readRuntime.validate(read.id, new AbortController().signal)).status, "promoted");

  const writeRuntime = createRuntime();
  const write = await writeRuntime.createToolCandidate(payload("workspace-write"), []);
  const validated = await writeRuntime.validate(write.id, new AbortController().signal);
  assert.equal(validated.status, "awaitingManualApproval");
  await assert.rejects(writeRuntime.promote(write.id));
  await writeRuntime.decideManualApproval(write.id, {
    approverId: "security-admin",
    decision: "approved",
    reason: "已完成线下审查",
  });
  assert.equal((await writeRuntime.promote(write.id)).status, "promoted");
  assert.equal((await writeRuntime.listWhitelist())[0]?.promotionMode, "manual");
});

test("两个 Reviewer 必须独立且绑定相同候选 Digest", () => {
  assert.throws(() => new CandidateValidationPipeline(
    new CandidateStaticAnalyzer(),
    new PassingEvaluator(),
    [new Reviewer("same"), new Reviewer("same")],
  ));
});

test("验证后修改候选内容会导致签名拒绝", async () => {
  const registry = new InMemoryCandidateRegistry();
  const runtime = createRuntime(registry);
  const candidate = await runtime.createToolCandidate(payload("workspace-write"), []);
  const validated = await runtime.validate(candidate.id, new AbortController().signal);
  assert.equal(validated.status, "awaitingManualApproval");
  const modified: EvolutionCandidateRecord = { ...validated, description: "changed" };
  await registry.save(modified);
  await runtime.decideManualApproval(candidate.id, { approverId: "admin", decision: "approved", reason: "approve" });
  await assert.rejects(runtime.promote(candidate.id));
});

test("停用与回滚同步更新签名白名单", async () => {
  const runtime = createRuntime();
  const candidate = await runtime.createToolCandidate(payload(), []);
  await runtime.validate(candidate.id, new AbortController().signal);
  assert.equal((await runtime.disable(candidate.id, "出现回归")).status, "disabled");
  assert.equal((await runtime.listWhitelist())[0]?.status, "disabled");
  assert.equal((await runtime.rollback(candidate.id, "撤回版本")).status, "rolledBack");
  assert.equal((await runtime.listWhitelist())[0]?.status, "rolledBack");
});

test("JSON Candidate Registry 原子持久化并明确拒绝损坏 JSON", async () => {
  const root = await mkdtemp(join(tmpdir(), "ai-ide-evolution-"));
  try {
    const file = join(root, "registry.json");
    const registry = new JsonCandidateRegistry(file);
    const runtime = createRuntime(registry);
    const candidate = await runtime.createToolCandidate(payload(), []);
    assert.equal((await new JsonCandidateRegistry(file).load(candidate.id))?.name, candidate.name);
    await writeFile(file, "{broken", "utf8");
    await assert.rejects(new JsonCandidateRegistry(file).list());
    assert.match(await readFile(file, "utf8"), /broken/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Evolution Typed IPC 只能管理候选状态，不传递签名私钥", async () => {
  const runtime = createRuntime();
  const candidate = await runtime.createToolCandidate(payload(), []);
  const gaps = new CapabilityGapDetector(new IncrementingIdGenerator(), { minimumOccurrences: 2, now: () => NOW });
  const [clientTransport, serverTransport] = createInMemoryTransportPair();
  const server = new TypedIpcServer(serverTransport);
  const client = new TypedIpcClient(clientTransport);
  const bridge = new EvolutionIpcBridge(runtime, gaps, server);
  bridge.start();
  const listed = await client.request("evolution.candidates.list", {});
  assert.equal(listed.candidates[0]?.id, candidate.id);
  const validated = await client.request("evolution.candidate.validate", { candidateId: candidate.id });
  assert.equal(validated.status, "promoted");
  assert.equal(JSON.stringify(validated).includes("PRIVATE KEY"), false);
  bridge.dispose();
  client.dispose();
  server.dispose();
});

test("IPC Version 7 校验 Evolution 请求与响应", async () => {
  assert.ok(IPC_PROTOCOL_VERSION >= 7);
  assert.equal(isIpcMessage({ kind: "request", id: "1", method: "evolution.candidate.promote", params: { candidateId: "c1" } }), true);
  assert.equal(isIpcMessage({ kind: "request", id: "1", method: "evolution.candidate.approve", params: { candidateId: "c1", approverId: "a", decision: "approved", reason: "ok", privateKey: "x" } }), false);
});


test("Tool Forge 只返回未注册候选包，Skill Forge 不扩大引用 Tool 权限", async () => {
  const detector = new CapabilityGapDetector(new IncrementingIdGenerator(), { minimumOccurrences: 2, now: () => NOW });
  detector.observe({ workspaceId: "w", sessionId: "s1", outcome: "读取清单", missingCapability: "workspace.read", evidence: ["missing"] });
  detector.observe({ workspaceId: "w", sessionId: "s2", outcome: "读取清单", missingCapability: "workspace.read", evidence: ["missing"] });
  const gap = detector.listProposals()[0]!;
  const forge = new ToolForge({
    async generate() {
      return {
        source: `import { defineTool, workspace } from "@independent-ai-ide/tool-sdk"; export default defineTool({ execute: () => workspace.readText("README.md") });`,
        testSource: `test("unit", () => {}); property("p", () => {}); fuzz("f", () => {});`,
        sdkVersion: "1.0.0",
      };
    },
  });
  const tool = await forge.forge({
    gap,
    name: "ManifestReader",
    description: "读取清单",
    riskLevel: "workspace-read",
    capabilities: ["workspace.read"],
  }, new AbortController().signal);
  assert.equal(tool.manifest.generated, true);
  assert.deepEqual(tool.manifest.capabilities, ["workspace.read"]);

  const skill = new SkillForge().forge({
    gap,
    name: "ReadManifestSkill",
    version: "0.1.0-candidate",
    description: "读取并解释清单",
    toolManifests: [tool.manifest],
    steps: [{ id: "read", toolName: tool.manifest.name, instruction: "读取清单" }],
  });
  assert.deepEqual(skill.toolManifests[0]?.capabilities, ["workspace.read"]);
});

test("包含写入 Tool 的 Skill 即使全部验证通过也必须等待人工审批", async () => {
  const runtime = createRuntime();
  const write = payload("workspace-write").manifest;
  const skill = await runtime.createSkillCandidate({
    name: "WriteWorkflow",
    version: "0.1.0-candidate",
    description: "写入工作流",
    toolManifests: [write],
    steps: [{ id: "write", toolName: write.name, instruction: "提出写入" }],
  }, []);
  const validated = await runtime.validate(skill.id, new AbortController().signal);
  assert.equal(validated.status, "awaitingManualApproval");
  assert.equal(validated.validation?.autoPromotionAllowed, false);
});

test("签名白名单可以脱离 Candidate Registry 独立验签，并拒绝被篡改条目", async () => {
  const signingKeys = keys();
  const trust = new SignedWhitelistTrustStore([{ keyId: "release-key-1", publicKeyPem: signingKeys.publicKeyPem, enabled: true }]);
  const ids = new IncrementingIdGenerator();
  const runtime = new EvolutionRuntime(
    new InMemoryCandidateRegistry(),
    ids,
    new CandidateValidationPipeline(new CandidateStaticAnalyzer(), new PassingEvaluator(), [new Reviewer("r1"), new Reviewer("r2")], () => NOW),
    new CandidateSigner({ keyId: "release-key-1", privateKeyPem: signingKeys.privateKeyPem }, () => NOW),
    trust,
    { actorId: "system", now: () => NOW },
  );
  const candidate = await runtime.createToolCandidate(payload(), []);
  await runtime.validate(candidate.id, new AbortController().signal);
  const entry = (await runtime.listWhitelist())[0]!;
  assert.equal(trust.verifyWhitelistEntry(entry), true);
  assert.equal(trust.verifyWhitelistEntry({ ...entry, packageDigest: "f".repeat(64) }), false);
  assert.equal(trust.verifyWhitelistEntry({ ...entry, status: "disabled" }), false);
  assert.equal(trust.verifyWhitelistEntry({ ...entry, capabilities: ["workspace.write"] }), false);
});

test("候选与 Signed Whitelist 原子提交失败时不会留下 promoted 候选", async () => {
  const registry = new FailingAtomicCommitRegistry();
  const runtime = createRuntime(registry);
  const candidate = await runtime.createToolCandidate(payload(), []);
  await assert.rejects(
    runtime.validate(candidate.id, new AbortController().signal),
    error => error instanceof Error && /atomic commit failure/.test(error.message),
  );
  assert.equal((await runtime.get(candidate.id))?.status, "validationFailed");
  assert.equal((await registry.listWhitelist()).length, 0);
});

test("Workbench Candidate Center 只通过 Typed IPC 管理验证、审批与回滚", async () => {
  const runtime = createRuntime();
  const candidate = await runtime.createToolCandidate(payload("workspace-write"), []);
  const gaps = new CapabilityGapDetector(new IncrementingIdGenerator(), { minimumOccurrences: 2, now: () => NOW });
  const [clientTransport, serverTransport] = createInMemoryTransportPair();
  const server = new TypedIpcServer(serverTransport);
  const client = new TypedIpcClient(clientTransport);
  const bridge = new EvolutionIpcBridge(runtime, gaps, server);
  bridge.start();
  const controller = new WorkbenchController(client);
  await controller.refreshEvolution();
  assert.equal(controller.getState().evolutionCandidates[0]?.id, candidate.id);
  await controller.validateEvolutionCandidate(candidate.id);
  assert.equal(controller.getState().evolutionCandidates[0]?.status, "awaitingManualApproval");
  await controller.approveEvolutionCandidate(candidate.id, "security-admin", "approved", "人工审批");
  await controller.promoteEvolutionCandidate(candidate.id);
  assert.equal(controller.getState().evolutionWhitelist[0]?.status, "active");
  await controller.rollbackEvolutionCandidate(candidate.id, "发现问题");
  assert.equal(controller.getState().evolutionWhitelist[0]?.status, "rolledBack");
  controller.dispose();
  bridge.dispose();
  client.dispose();
  server.dispose();
});

test("Code OSS 所有注册 ViewKind 都有渲染分支，Candidate Center 不持有执行能力", async () => {
  const view = await readFile("overlays/code-oss/src/vs/workbench/contrib/independentAiIde/browser/independentAiIdeView.ts", "utf8");
  for (const kind of ["agent", "tasks", "permissions", "browser", "computer", "evolution"]) {
    assert.equal(view.includes(`case '${kind}':`), true);
  }
  assert.equal(view.includes("privateKeyPem"), false);
  assert.equal(/from\s+['\"]node:(?:fs|child_process)['\"]/.test(view), false);
  assert.equal(view.includes("fetch("), false);
});
