import { createPrivateKey, createPublicKey, sign as cryptoSign, verify as cryptoVerify } from "node:crypto";
import { releaseManifestDigest, signedReleasePayload, stripSignature, validateSignedReleaseManifest } from "./manifest.js";
import type { SignedReleaseManifest, UnsignedReleaseManifest } from "./types.js";

export interface ReleaseSigningKey { readonly keyId: string; readonly privateKeyPem: string }
export interface TrustedReleaseKey { readonly keyId: string; readonly publicKeyPem: string; readonly enabled: boolean }

export class ReleaseSigner {
  public constructor(private readonly key: ReleaseSigningKey) {}

  public sign(manifest: UnsignedReleaseManifest): SignedReleaseManifest {
    const manifestDigest = releaseManifestDigest(manifest);
    const unsignedSignature = { ...manifest, manifestDigest, signerKeyId: this.key.keyId, algorithm: "ed25519" as const };
    const signature = cryptoSign(null, Buffer.from(signedReleasePayload(unsignedSignature), "utf8"), createPrivateKey(this.key.privateKeyPem));
    return { ...unsignedSignature, signatureBase64: signature.toString("base64") };
  }
}

export class ReleaseTrustStore {
  private readonly keys = new Map<string, TrustedReleaseKey>();
  public constructor(keys: readonly TrustedReleaseKey[]) {
    for (const key of keys) {
      if (this.keys.has(key.keyId)) throw new Error(`重复 Release Key ID：${key.keyId}`);
      this.keys.set(key.keyId, { ...key });
    }
  }

  public verify(manifest: SignedReleaseManifest): boolean {
    try { validateSignedReleaseManifest(manifest); } catch { return false; }
    const key = this.keys.get(manifest.signerKeyId);
    if (key === undefined || !key.enabled) return false;
    if (releaseManifestDigest(stripSignature(manifest)) !== manifest.manifestDigest) return false;
    return cryptoVerify(
      null,
      Buffer.from(signedReleasePayload(manifest), "utf8"),
      createPublicKey(key.publicKeyPem),
      Buffer.from(manifest.signatureBase64, "base64"),
    );
  }
}
