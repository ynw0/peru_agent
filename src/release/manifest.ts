import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { canonicalJson, digestValue } from "../evolution/canonical.js";
import type { ReleaseFileEntry, SignedReleaseManifest, UnsignedReleaseManifest } from "./types.js";

export function validateReleaseManifest(manifest: UnsignedReleaseManifest): void {
  if (manifest.schemaVersion !== 1 || manifest.productId !== "independent-ai-ide") throw new Error("发布 Manifest 产品身份无效");
  if (!/^\d+\.\d+\.\d+$/.test(manifest.version)) throw new Error("发布版本必须是稳定 SemVer");
  if (manifest.channel !== "stable" && manifest.channel !== "preview") throw new Error("发布通道无效");
  if (!/^[0-9a-f]{40}$/.test(manifest.sourceCommit)) throw new Error("发布源 Commit 必须是 40 位小写 SHA-1");
  if (!isSha256(manifest.sbomSha256)) throw new Error("SBOM SHA-256 无效");
  if (Number.isNaN(Date.parse(manifest.createdAt))) throw new Error("发布时间无效");
  if (manifest.files.length === 0) throw new Error("发布包不能为空");
  const paths = new Set<string>();
  for (const file of manifest.files) {
    validateReleaseFile(file);
    if (paths.has(file.path)) throw new Error(`发布文件路径重复：${file.path}`);
    paths.add(file.path);
  }
}

export function releaseManifestDigest(manifest: UnsignedReleaseManifest): string {
  validateReleaseManifest(manifest);
  return digestValue(manifest);
}

export function validateSignedReleaseManifest(manifest: SignedReleaseManifest): void {
  validateReleaseManifest(manifest);
  if (!isSha256(manifest.manifestDigest) || manifest.manifestDigest !== releaseManifestDigest(stripSignature(manifest))) {
    throw new Error("发布 Manifest Digest 不匹配");
  }
  if (manifest.signerKeyId.trim() === "" || manifest.algorithm !== "ed25519" || manifest.signatureBase64.trim() === "") {
    throw new Error("发布签名字段无效");
  }
}

export function stripSignature(manifest: SignedReleaseManifest): UnsignedReleaseManifest {
  const { manifestDigest: _digest, signerKeyId: _key, algorithm: _algorithm, signatureBase64: _signature, ...unsigned } = manifest;
  return unsigned;
}

export function sha256Bytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function signedReleasePayload(manifest: Omit<SignedReleaseManifest, "signatureBase64"> | SignedReleaseManifest): string {
  return canonicalJson({
    manifestDigest: manifest.manifestDigest,
    signerKeyId: manifest.signerKeyId,
    algorithm: manifest.algorithm,
  });
}

function validateReleaseFile(file: ReleaseFileEntry): void {
  if (file.path.trim() === "" || isAbsolute(file.path) || file.path.includes("\\") || file.path.split("/").some(part => part === "" || part === "." || part === "..")) {
    throw new Error(`发布文件路径越界：${file.path}`);
  }
  if (file.path === "release-manifest.json" || file.path === "sbom.spdx.json") throw new Error(`发布文件使用保留路径：${file.path}`);
  if (!isSha256(file.sha256)) throw new Error(`发布文件 SHA-256 无效：${file.path}`);
  if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > 2 * 1024 * 1024 * 1024) throw new Error(`发布文件大小无效：${file.path}`);
}

function isSha256(value: string): boolean { return /^[0-9a-f]{64}$/.test(value); }
