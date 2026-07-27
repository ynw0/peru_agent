import {
  createPrivateKey,
  createPublicKey,
  sign as cryptoSign,
  verify as cryptoVerify,
} from "node:crypto";
import { canonicalJson, digestValue } from "./canonical.js";
import type {
  CandidateValidationReport,
  EvolutionCandidateRecord,
  SignedCandidateArtifact,
  SignedWhitelistEntry,
} from "./types.js";

export interface CandidateSigningKey {
  readonly keyId: string;
  readonly privateKeyPem: string;
}

export interface TrustedSigningKey {
  readonly keyId: string;
  readonly publicKeyPem: string;
  readonly enabled: boolean;
}

export class CandidateSigner {
  public constructor(
    private readonly key: CandidateSigningKey,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  public sign(candidate: EvolutionCandidateRecord, validation: CandidateValidationReport): SignedCandidateArtifact {
    if (!validation.complete || validation.candidateId !== candidate.id) {
      throw new Error("只有完整验证且绑定候选 ID 的报告可以签名");
    }
    const candidateDigest = digestCandidate(candidate);
    if (candidateDigest !== validation.candidateDigest) {
      throw new Error("候选内容在验证后发生变化，拒绝签名");
    }
    const validationDigest = digestValue(validation);
    const signedAt = this.now();
    const packageDigest = digestValue({ candidateDigest, validationDigest, signerKeyId: this.key.keyId, signedAt });
    const payload = canonicalJson({ candidateDigest, validationDigest, packageDigest, signerKeyId: this.key.keyId, signedAt });
    const signature = cryptoSign(null, Buffer.from(payload, "utf8"), createPrivateKey(this.key.privateKeyPem));
    return {
      candidateId: candidate.id,
      candidateDigest,
      validationDigest,
      packageDigest,
      signerKeyId: this.key.keyId,
      algorithm: "ed25519",
      signatureBase64: signature.toString("base64"),
      signedAt,
    };
  }

  public signWhitelistEntry(entry: Omit<SignedWhitelistEntry, "decisionSignatureBase64">): SignedWhitelistEntry {
    const payload = whitelistDecisionPayload(entry);
    const signature = cryptoSign(null, Buffer.from(payload, "utf8"), createPrivateKey(this.key.privateKeyPem));
    return { ...entry, decisionSignatureBase64: signature.toString("base64") };
  }
}

export class SignedWhitelistTrustStore {
  private readonly keys = new Map<string, TrustedSigningKey>();

  public constructor(keys: readonly TrustedSigningKey[]) {
    for (const key of keys) {
      if (this.keys.has(key.keyId)) throw new Error(`重复签名 Key ID：${key.keyId}`);
      this.keys.set(key.keyId, { ...key });
    }
  }

  public verifyArtifact(artifact: SignedCandidateArtifact): boolean {
    const key = this.keys.get(artifact.signerKeyId);
    if (key === undefined || !key.enabled || artifact.algorithm !== "ed25519") return false;
    const payload = canonicalJson({
      candidateDigest: artifact.candidateDigest,
      validationDigest: artifact.validationDigest,
      packageDigest: artifact.packageDigest,
      signerKeyId: artifact.signerKeyId,
      signedAt: artifact.signedAt,
    });
    return cryptoVerify(
      null,
      Buffer.from(payload, "utf8"),
      createPublicKey(key.publicKeyPem),
      Buffer.from(artifact.signatureBase64, "base64"),
    );
  }

  public verifyWhitelistEntry(entry: SignedWhitelistEntry): boolean {
    const key = this.keys.get(entry.signerKeyId);
    if (key === undefined || !key.enabled) return false;
    const publicKey = createPublicKey(key.publicKeyPem);
    const artifactPayload = canonicalJson({
      candidateDigest: entry.candidateDigest,
      validationDigest: entry.validationDigest,
      packageDigest: entry.packageDigest,
      signerKeyId: entry.signerKeyId,
      signedAt: entry.signedAt,
    });
    const artifactValid = cryptoVerify(
      null,
      Buffer.from(artifactPayload, "utf8"),
      publicKey,
      Buffer.from(entry.signatureBase64, "base64"),
    );
    if (!artifactValid) return false;
    return cryptoVerify(
      null,
      Buffer.from(whitelistDecisionPayload(entry), "utf8"),
      publicKey,
      Buffer.from(entry.decisionSignatureBase64, "base64"),
    );
  }
}

function whitelistDecisionPayload(entry: Omit<SignedWhitelistEntry, "decisionSignatureBase64"> | SignedWhitelistEntry): string {
  return canonicalJson({
    candidateId: entry.candidateId,
    kind: entry.kind,
    name: entry.name,
    version: entry.version,
    riskLevel: entry.riskLevel,
    capabilities: [...entry.capabilities].sort(),
    candidateDigest: entry.candidateDigest,
    validationDigest: entry.validationDigest,
    packageDigest: entry.packageDigest,
    signerKeyId: entry.signerKeyId,
    signatureBase64: entry.signatureBase64,
    signedAt: entry.signedAt,
    status: entry.status,
    promotionMode: entry.promotionMode,
    activatedAt: entry.activatedAt,
    updatedAt: entry.updatedAt,
  });
}

export function digestCandidate(candidate: EvolutionCandidateRecord): string {
  return digestValue({
    id: candidate.id,
    kind: candidate.kind,
    name: candidate.name,
    version: candidate.version,
    description: candidate.description,
    riskLevel: candidate.riskLevel,
    capabilities: [...candidate.capabilities].sort(),
    payload: candidate.payload,
    sourceGapIds: [...candidate.sourceGapIds].sort(),
  });
}
