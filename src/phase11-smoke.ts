import { generateKeyPairSync } from "node:crypto";
import { IncrementingIdGenerator } from "./agent/id-generator.js";
import { InMemoryCandidateRegistry } from "./evolution/registry.js";
import { EvolutionRuntime } from "./evolution/runtime.js";
import { CandidateSigner, SignedWhitelistTrustStore, digestCandidate } from "./evolution/signing.js";
import { CandidateStaticAnalyzer } from "./evolution/static-analyzer.js";
import type { ReviewerAttestation, SandboxEvaluationAttestation, ValidationGate } from "./evolution/types.js";
import { CandidateValidationPipeline } from "./evolution/validator.js";
import { IPC_PROTOCOL_VERSION } from "./ipc/protocol.js";
import { WORKBENCH_CONTAINERS } from "./workbench/contributions.js";

const pair = generateKeyPairSync("ed25519");
const privateExport = pair.privateKey.export({ type: "pkcs8", format: "pem" });
const publicExport = pair.publicKey.export({ type: "spki", format: "pem" });
const privateKeyPem = typeof privateExport === "string" ? privateExport : Buffer.from(privateExport).toString("utf8");
const publicKeyPem = typeof publicExport === "string" ? publicExport : Buffer.from(publicExport).toString("utf8");
const now = () => "2026-07-27T12:00:00.000Z";
const gates: readonly ValidationGate[] = [
  "unit-tests", "property-tests", "fuzz-tests", "adversarial-tests",
  "sandbox-dynamic", "capability-consistency", "reproducible-package",
];
const pipeline = new CandidateValidationPipeline(
  new CandidateStaticAnalyzer(),
  {
    async evaluate(candidate): Promise<SandboxEvaluationAttestation> {
      return {
        evaluatorId: "smoke-sandbox",
        environmentFingerprint: "smoke-isolated",
        isolated: true,
        candidateDigest: digestCandidate(candidate),
        gates: gates.map(gate => ({ gate, passed: true, summary: "ok", evidenceSha256: "a".repeat(64), completedAt: now() })),
      };
    },
  },
  ["reviewer-one", "reviewer-two"].map(reviewerId => ({
    reviewerId,
    async review(_candidate: unknown, digest: string): Promise<ReviewerAttestation> {
      return { reviewerId, approved: true, summary: "approved", reviewedDigest: digest, completedAt: now() };
    },
  })),
  now,
);
const runtime = new EvolutionRuntime(
  new InMemoryCandidateRegistry(),
  new IncrementingIdGenerator(),
  pipeline,
  new CandidateSigner({ keyId: "smoke-key", privateKeyPem }, now),
  new SignedWhitelistTrustStore([{ keyId: "smoke-key", publicKeyPem, enabled: true }]),
  { actorId: "smoke", now },
);
const candidate = await runtime.createToolCandidate({
  manifest: {
    name: "SmokePureTool",
    version: "0.1.0-candidate",
    description: "Smoke",
    riskLevel: "pure-compute",
    capabilities: [],
    generated: true,
  },
  source: "export default defineTool({ execute: (input: unknown) => input });",
  testSource: "test('unit', () => {}); property('p', () => {}); fuzz('f', () => {});",
  sdkVersion: "1.0.0",
}, []);
const result = await runtime.validate(candidate.id, new AbortController().signal);
if (result.status !== "promoted") throw new Error("Phase 11 低风险候选未自动晋级");
if ((await runtime.listWhitelist())[0]?.status !== "active") throw new Error("Phase 11 签名白名单未激活");
if (Number(IPC_PROTOCOL_VERSION) < 7) throw new Error("Phase 11 IPC 协议未升级");
if (!WORKBENCH_CONTAINERS.some(item => item.id === "independentAiIde.evolution")) throw new Error("Phase 11 Candidate Center 未注册");
console.log("AI IDE Phase 11 Smoke Test 通过");
