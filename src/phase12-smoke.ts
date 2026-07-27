import { generateKeyPairSync } from "node:crypto";
import { validateLocalizationCatalogs, localize } from "./localization/catalog.js";
import { evaluateReleaseGates, REQUIRED_PRODUCTION_GATES } from "./release/gates.js";
import { ReleaseSigner, ReleaseTrustStore } from "./release/signing.js";
import type { UnsignedReleaseManifest } from "./release/types.js";
import { IPC_PROTOCOL_VERSION } from "./ipc/protocol.js";
import { WORKBENCH_CONTAINERS } from "./workbench/contributions.js";

validateLocalizationCatalogs();
if (localize("en-US", "release.title") !== "Release and Updates") throw new Error("Phase 12 英文本地化失败");
const pair = generateKeyPairSync("ed25519");
const privateValue = pair.privateKey.export({ type: "pkcs8", format: "pem" });
const publicValue = pair.publicKey.export({ type: "spki", format: "pem" });
const privateKeyPem = typeof privateValue === "string" ? privateValue : Buffer.from(privateValue).toString("utf8");
const publicKeyPem = typeof publicValue === "string" ? publicValue : Buffer.from(publicValue).toString("utf8");
const unsigned: UnsignedReleaseManifest = {
  schemaVersion: 1, productId: "independent-ai-ide", version: "0.13.0", channel: "stable", platform: "win32", architecture: "x64",
  createdAt: "2026-07-27T20:00:00.000Z", sourceCommit: "a".repeat(40), codeOssVersion: "1.74.0", sbomSha256: "b".repeat(64),
  files: [{ path: "app/main.js", sha256: "c".repeat(64), size: 1, executable: false }],
};
const manifest = new ReleaseSigner({ keyId: "smoke-release", privateKeyPem }).sign(unsigned);
if (!new ReleaseTrustStore([{ keyId: "smoke-release", publicKeyPem, enabled: true }]).verify(manifest)) throw new Error("Phase 12 Release 签名失败");
if (evaluateReleaseGates([]).blockers.length !== REQUIRED_PRODUCTION_GATES.length) throw new Error("Phase 12 发布门禁未严格阻止未验证发布");
if (Number(IPC_PROTOCOL_VERSION) < 8) throw new Error("Phase 12 IPC 协议未升级");
if (!WORKBENCH_CONTAINERS.some(item => item.id === "independentAiIde.release")) throw new Error("Phase 12 Release Center 未注册");
console.log("AI IDE Phase 12 Smoke Test 通过");
