import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IncrementingIdGenerator } from "../src/agent/id-generator.js";
import { LOCALIZATION_CATALOGS, UI_MESSAGE_KEYS, localize, validateLocalizationCatalogs } from "../src/localization/catalog.js";
import { InMemoryLocaleStore, LocalizationRuntime } from "../src/localization/runtime.js";
import { IPC_PROTOCOL_VERSION } from "../src/ipc/protocol.js";
import { TypedIpcClient, TypedIpcServer } from "../src/ipc/channel.js";
import { createInMemoryTransportPair } from "../src/ipc/transport.js";
import { isIpcMessage, isResponseResult } from "../src/ipc/validation.js";
import { evaluateReleaseGates, REQUIRED_PRODUCTION_GATES } from "../src/release/gates.js";
import { sha256Bytes, validateReleaseManifest } from "../src/release/manifest.js";
import { ReleaseRuntime } from "../src/release/runtime.js";
import { ReleaseSigner, ReleaseTrustStore } from "../src/release/signing.js";
import { generateSourceSbom } from "../src/release/sbom.js";
import type { ReleaseGateResult, SignedReleaseManifest, UnsignedReleaseManifest } from "../src/release/types.js";
import { AtomicReleaseManager } from "../src/release/update-manager.js";
import { ReleaseIpcBridge } from "../src/runtime/release-ipc-bridge.js";
import { WorkbenchController } from "../src/workbench/workbench-controller.js";
import { WORKBENCH_CONTAINERS } from "../src/workbench/contributions.js";

const NOW = "2026-07-27T20:00:00.000Z";

function keyPair() {
  const pair = generateKeyPairSync("ed25519");
  const privateValue = pair.privateKey.export({ type: "pkcs8", format: "pem" });
  const publicValue = pair.publicKey.export({ type: "spki", format: "pem" });
  return {
    privateKeyPem: typeof privateValue === "string" ? privateValue : Buffer.from(privateValue).toString("utf8"),
    publicKeyPem: typeof publicValue === "string" ? publicValue : Buffer.from(publicValue).toString("utf8"),
  };
}

function createSigning() {
  const pair = keyPair();
  return {
    signer: new ReleaseSigner({ keyId: "release-key-2026", privateKeyPem: pair.privateKeyPem }),
    trust: new ReleaseTrustStore([{ keyId: "release-key-2026", publicKeyPem: pair.publicKeyPem, enabled: true }]),
    disabledTrust: new ReleaseTrustStore([{ keyId: "release-key-2026", publicKeyPem: pair.publicKeyPem, enabled: false }]),
  };
}

async function createBundle(root: string, version: string, signer: ReleaseSigner, body = "console.log('release');\n") {
  const bundle = join(root, `bundle-${version}`);
  await writeFile(join(root, `placeholder-${version}`), "", "utf8");
  const appPath = join(bundle, "app", "main.js");
  await import("node:fs/promises").then(fs => fs.mkdir(join(bundle, "app"), { recursive: true }));
  await writeFile(appPath, body, "utf8");
  const packageJson = JSON.stringify({ name: "independent-ai-ide-core", version, dependencies: { alpha: "1.0.0" }, devDependencies: { beta: "2.0.0" } });
  const sbom = generateSourceSbom(packageJson, NOW);
  const sbomText = `${JSON.stringify(sbom, null, 2)}\n`;
  await writeFile(join(bundle, "sbom.spdx.json"), sbomText, "utf8");
  const bodyBytes = Buffer.from(body, "utf8");
  const manifest: UnsignedReleaseManifest = {
    schemaVersion: 1,
    productId: "independent-ai-ide",
    version,
    channel: "stable",
    platform: "win32",
    architecture: "x64",
    createdAt: NOW,
    sourceCommit: "a".repeat(40),
    codeOssVersion: "1.74.0",
    sbomSha256: sha256Bytes(Buffer.from(sbomText, "utf8")),
    files: [{ path: "app/main.js", sha256: sha256Bytes(bodyBytes), size: bodyBytes.byteLength, executable: false }],
  };
  return { bundle, manifest: signer.sign(manifest) };
}

function passingGates(): readonly ReleaseGateResult[] {
  return REQUIRED_PRODUCTION_GATES.map(gate => ({ gate, passed: true, evidence: `${gate}:sha256:${"b".repeat(64)}`, completedAt: NOW }));
}

test("中英文资源键完全一致，缺失或多余插值参数会明确失败", () => {
  validateLocalizationCatalogs();
  assert.equal(Object.keys(LOCALIZATION_CATALOGS["zh-CN"].messages).length, UI_MESSAGE_KEYS.length);
  assert.equal(Object.keys(LOCALIZATION_CATALOGS["en-US"].messages).length, UI_MESSAGE_KEYS.length);
  assert.equal(localize("en-US", "release.version", { version: "0.13.0" }), "Current version: 0.13.0");
  assert.throws(() => localize("zh-CN", "release.version"));
  assert.throws(() => localize("zh-CN", "action.send", { unexpected: "x" }));
});

test("Release Manifest 使用 Ed25519 签名并拒绝内容、Digest 和禁用 Key 篡改", () => {
  const { signer, trust, disabledTrust } = createSigning();
  const unsigned: UnsignedReleaseManifest = {
    schemaVersion: 1, productId: "independent-ai-ide", version: "0.13.0", channel: "stable",
    platform: "win32", architecture: "x64", createdAt: NOW, sourceCommit: "a".repeat(40), codeOssVersion: "1.74.0",
    sbomSha256: "b".repeat(64), files: [{ path: "app/main.js", sha256: "c".repeat(64), size: 10, executable: false }],
  };
  const signed = signer.sign(unsigned);
  assert.equal(trust.verify(signed), true);
  assert.equal(trust.verify({ ...signed, version: "0.13.1" }), false);
  assert.equal(trust.verify({ ...signed, manifestDigest: "f".repeat(64) }), false);
  assert.equal(disabledTrust.verify(signed), false);
});

test("Release Manifest 拒绝路径穿越、反斜杠、重复路径和保留文件", () => {
  const base: UnsignedReleaseManifest = {
    schemaVersion: 1, productId: "independent-ai-ide", version: "0.13.0", channel: "stable",
    platform: "win32", architecture: "x64", createdAt: NOW, sourceCommit: "a".repeat(40), codeOssVersion: "1.74.0",
    sbomSha256: "b".repeat(64), files: [{ path: "app/main.js", sha256: "c".repeat(64), size: 1, executable: false }],
  };
  assert.throws(() => validateReleaseManifest({ ...base, files: [{ ...base.files[0]!, path: "../evil.exe" }] }));
  assert.throws(() => validateReleaseManifest({ ...base, files: [{ ...base.files[0]!, path: "app\\evil.exe" }] }));
  assert.throws(() => validateReleaseManifest({ ...base, files: [base.files[0]!, base.files[0]!] }));
  assert.throws(() => validateReleaseManifest({ ...base, files: [{ ...base.files[0]!, path: "sbom.spdx.json" }] }));
});

test("SPDX SBOM 生成确定、排序稳定且不包含环境密钥", () => {
  const source = JSON.stringify({ name: "ide", version: "1.0.0", dependencies: { zeta: "1", alpha: "2" }, devDependencies: { typescript: "5" } });
  const first = generateSourceSbom(source, NOW);
  const second = generateSourceSbom(source, NOW);
  assert.deepEqual(first, second);
  assert.deepEqual(first.packages.map(item => item.name), ["alpha", "typescript", "zeta"]);
  assert.equal(JSON.stringify(first).includes("PRIVATE KEY"), false);
});

test("生产发布门禁缺一项即 blocked，全部证据通过才 ready", () => {
  const incomplete = evaluateReleaseGates(passingGates().filter(result => result.gate !== "authenticode"));
  assert.equal(incomplete.ready, false);
  assert.deepEqual(incomplete.blockers, ["authenticode"]);
  const complete = evaluateReleaseGates(passingGates());
  assert.equal(complete.ready, true);
  assert.deepEqual(complete.blockers, []);
});

test("原子 Release Manager 安装新版本、切换状态并可回滚", async () => {
  const root = await mkdtemp(join(tmpdir(), "ai-ide-release-"));
  try {
    const { signer, trust } = createSigning();
    const manager = new AtomicReleaseManager(join(root, "install"), trust, new IncrementingIdGenerator(), () => NOW);
    const first = await createBundle(root, "0.13.0", signer, "first");
    const second = await createBundle(root, "0.13.1", signer, "second");
    assert.equal((await manager.installBundle(first.bundle, first.manifest)).currentVersion, "0.13.0");
    const updated = await manager.installBundle(second.bundle, second.manifest);
    assert.equal(updated.currentVersion, "0.13.1");
    assert.equal(updated.previousVersion, "0.13.0");
    const rolledBack = await manager.rollback();
    assert.equal(rolledBack.currentVersion, "0.13.0");
    assert.equal(rolledBack.previousVersion, "0.13.1");
    assert.equal(await readFile(join(root, "install", "versions", "0.13.1", "app", "main.js"), "utf8"), "second");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("普通更新拒绝同版本和降级，旧版本只能通过显式 rollback 激活", async () => {
  const root = await mkdtemp(join(tmpdir(), "ai-ide-release-version-"));
  try {
    const { signer, trust } = createSigning();
    const manager = new AtomicReleaseManager(join(root, "install"), trust, new IncrementingIdGenerator(), () => NOW);
    const current = await createBundle(root, "0.13.0", signer, "current");
    await manager.installBundle(current.bundle, current.manifest);
    const same = await createBundle(root, "0.13.0", signer, "same");
    const older = await createBundle(root, "0.12.9", signer, "older");
    await assert.rejects(manager.installBundle(same.bundle, same.manifest), error => error instanceof Error && error.message.includes("普通更新必须高于当前版本"));
    await assert.rejects(manager.installBundle(older.bundle, older.manifest), error => error instanceof Error && error.message.includes("普通更新必须高于当前版本"));
    assert.equal((await manager.getState()).currentVersion, "0.13.0");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("文件哈希失败不会改变当前激活版本", async () => {
  const root = await mkdtemp(join(tmpdir(), "ai-ide-release-tamper-"));
  try {
    const { signer, trust } = createSigning();
    const manager = new AtomicReleaseManager(join(root, "install"), trust, new IncrementingIdGenerator(), () => NOW);
    const first = await createBundle(root, "0.13.0", signer, "first");
    await manager.installBundle(first.bundle, first.manifest);
    const second = await createBundle(root, "0.13.1", signer, "second");
    await writeFile(join(second.bundle, "app", "main.js"), "tampered", "utf8");
    await assert.rejects(manager.installBundle(second.bundle, second.manifest));
    assert.equal((await manager.getState()).currentVersion, "0.13.0");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Release Manager 拒绝符号链接形式的 Bundle 根目录", async () => {
  const root = await mkdtemp(join(tmpdir(), "ai-ide-release-root-link-"));
  try {
    const { signer, trust } = createSigning();
    const manager = new AtomicReleaseManager(join(root, "install"), trust, new IncrementingIdGenerator(), () => NOW);
    const release = await createBundle(root, "0.13.0", signer, "first");
    const linkedRoot = join(root, "linked-bundle");
    await symlink(release.bundle, linkedRoot, "dir");
    await assert.rejects(manager.installBundle(linkedRoot, release.manifest), error => error instanceof Error && error.message.includes("Bundle 根目录无效"));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Release Manager 拒绝 Bundle 内符号链接文件", async () => {
  const root = await mkdtemp(join(tmpdir(), "ai-ide-release-link-"));
  try {
    const { signer, trust } = createSigning();
    const manager = new AtomicReleaseManager(join(root, "install"), trust, new IncrementingIdGenerator(), () => NOW);
    const release = await createBundle(root, "0.13.0", signer, "first");
    await rm(join(release.bundle, "app", "main.js"), { force: true });
    await symlink(join(release.bundle, "sbom.spdx.json"), join(release.bundle, "app", "main.js"), "file");
    await assert.rejects(manager.installBundle(release.bundle, release.manifest));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Release Runtime 与 IPC 只暴露状态、语言和 Manifest 验证，不暴露私钥或安装路径", async () => {
  const root = await mkdtemp(join(tmpdir(), "ai-ide-release-ipc-"));
  try {
    const { signer, trust } = createSigning();
    const locale = new LocalizationRuntime(new InMemoryLocaleStore());
    const runtime = new ReleaseRuntime(locale, new AtomicReleaseManager(join(root, "install"), trust, new IncrementingIdGenerator(), () => NOW), trust, {
      productVersion: "0.13.0", channel: "stable", actorId: "system", now: () => NOW, nextId: prefix => `${prefix}-1`,
    });
    runtime.setGateResults(passingGates().filter(item => item.gate !== "code-oss-compile"));
    await runtime.initialize();
    const [clientTransport, serverTransport] = createInMemoryTransportPair();
    const server = new TypedIpcServer(serverTransport);
    const client = new TypedIpcClient(clientTransport);
    const bridge = new ReleaseIpcBridge(runtime, server);
    bridge.start();
    assert.equal((await client.request("release.status", {})).productionReady, false);
    assert.equal((await client.request("release.locale.set", { locale: "en-US" })).locale, "en-US");
    const release = await createBundle(root, "0.13.0", signer);
    assert.equal((await client.request("release.manifest.verify", { manifest: release.manifest })).valid, true);
    assert.equal(JSON.stringify(await client.request("release.audit.list", {})).includes("PRIVATE KEY"), false);
    assert.equal(isIpcMessage({ kind: "request", id: "x", method: "release.status", params: { installPath: "C:/" } }), false);
    bridge.dispose(); client.dispose(); server.dispose();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("IPC Version 8 严格校验 Release 消息与响应", () => {
  assert.equal(IPC_PROTOCOL_VERSION, 8);
  assert.equal(isIpcMessage({ kind: "request", id: "1", method: "release.locale.set", params: { locale: "zh-CN" } }), true);
  assert.equal(isIpcMessage({ kind: "request", id: "1", method: "release.locale.set", params: { locale: "fr-FR" } }), false);
  assert.equal(isResponseResult("release.status", { productVersion: "0.13.0", channel: "stable", locale: "zh-CN", installedVersions: [], productionReady: false, blockers: ["code-oss-compile"] }), true);
});

test("Workbench Release Center 只能通过 Typed IPC 刷新和切换语言", async () => {
  const [clientTransport, serverTransport] = createInMemoryTransportPair();
  const server = new TypedIpcServer(serverTransport);
  const client = new TypedIpcClient(clientTransport);
  server.registerHandler("release.status", () => ({ productVersion: "0.13.0", channel: "stable", locale: "zh-CN", installedVersions: [], productionReady: false, blockers: ["code-oss-compile"] }));
  server.registerHandler("release.locale.set", request => ({ productVersion: "0.13.0", channel: "stable", locale: request.locale, installedVersions: [], productionReady: false, blockers: ["code-oss-compile"] }));
  const controller = new WorkbenchController(client);
  assert.equal((await controller.refreshRelease()).locale, "zh-CN");
  assert.equal((await controller.setLocale("en-US")).locale, "en-US");
  assert.equal(controller.getState().release.locale, "en-US");
  controller.dispose(); client.dispose(); server.dispose();
});

test("Release Center 已注册且 View 不直接访问文件、进程、网络或安装路径", async () => {
  assert.equal(WORKBENCH_CONTAINERS.some(item => item.id === "independentAiIde.release"), true);
  const view = await readFile("overlays/code-oss/src/vs/workbench/contrib/independentAiIde/browser/independentAiIdeView.ts", "utf8");
  assert.equal(view.includes("case 'release':"), true);
  assert.equal(view.includes("renderRelease"), true);
  assert.equal(/from\s+['\"]node:(?:fs|child_process|http|https)['\"]/.test(view), false);
  assert.equal(view.includes("installBundle("), false);
  assert.equal(view.includes("privateKeyPem"), false);
});

test("Windows 安装脚本强制 Authenticode Publisher 与 Thumbprint", async () => {
  const installer = await readFile("packaging/windows/install.ps1", "utf8");
  assert.equal(installer.includes("Get-AuthenticodeSignature"), true);
  assert.equal(installer.includes("ExpectedPublisher"), true);
  assert.equal(installer.includes("ExpectedThumbprint"), true);
  assert.equal(installer.includes("Status -ne 'Valid'"), true);
});


test("Windows 发布构建脚本固定 Node/Yarn、签名 Payload，并拒绝未验证输出", async () => {
  const builder = await readFile("packaging/windows/build-release.ps1", "utf8");
  assert.equal(builder.includes("^v16\\.14\\.\\d+$"), true);
  assert.equal(builder.includes("Yarn Classic 1.x"), true);
  assert.equal(builder.includes("node_modules\\gulp\\bin\\gulp.js"), true);
  assert.equal(builder.includes("vscode-win32-$Architecture-min-ci"), true);
  assert.equal(builder.includes("Get-AuthenticodeSignature"), true);
  assert.equal(builder.includes("CertificateThumbprint"), true);
  assert.equal(builder.includes("--sign"), false);
  assert.equal(builder.includes("Remove-Item -LiteralPath $OutputDirectory"), true);
});
