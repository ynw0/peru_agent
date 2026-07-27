import { lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { sha256Bytes, validateSignedReleaseManifest } from "./manifest.js";
import type { ReleaseState, SignedReleaseManifest } from "./types.js";
import type { ReleaseTrustStore } from "./signing.js";

export interface ReleaseIdGenerator { next(prefix: string): string }

export class AtomicReleaseManager {
  private writeQueue: Promise<void> = Promise.resolve();

  public constructor(
    private readonly rootDirectory: string,
    private readonly trustStore: ReleaseTrustStore,
    private readonly ids: ReleaseIdGenerator,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  public async getState(): Promise<ReleaseState> {
    const statePath = this.statePath();
    try {
      const parsed = JSON.parse(await readFile(statePath, "utf8")) as unknown;
      return validateReleaseState(parsed);
    } catch (error: unknown) {
      if (isMissingFile(error)) return { installedVersions: await this.listInstalledVersions(), updatedAt: this.now() };
      throw error;
    }
  }

  public async installBundle(bundleRoot: string, manifest: SignedReleaseManifest): Promise<ReleaseState> {
    return this.serialize(async () => {
      validateSignedReleaseManifest(manifest);
      if (!this.trustStore.verify(manifest)) throw new Error("发布 Manifest 签名不可信");
      const current = await this.getState();
      if (current.currentVersion !== undefined && compareVersion(manifest.version, current.currentVersion) <= 0) {
        throw new Error(`普通更新必须高于当前版本：current=${current.currentVersion}, requested=${manifest.version}`);
      }
      const requestedBundle = resolve(bundleRoot);
      const bundleStat = await lstat(requestedBundle);
      if (!bundleStat.isDirectory() || bundleStat.isSymbolicLink()) throw new Error("发布 Bundle 根目录无效");
      const absoluteBundle = await realpath(requestedBundle);
      const stagingRoot = join(this.rootDirectory, "staging", `${manifest.version}-${this.ids.next("stage")}`);
      const targetVersionRoot = join(this.rootDirectory, "versions", manifest.version);
      await mkdir(stagingRoot, { recursive: true });
      try {
        for (const file of manifest.files) {
          const source = resolve(absoluteBundle, file.path);
          if (!isWithin(absoluteBundle, source)) throw new Error(`发布文件越界：${file.path}`);
          const bytes = await readVerifiedBundleFile(absoluteBundle, source, `发布文件不是普通文件：${file.path}`);
          if (bytes.byteLength !== file.size || sha256Bytes(bytes) !== file.sha256) throw new Error(`发布文件校验失败：${file.path}`);
          const target = join(stagingRoot, file.path);
          await mkdir(dirname(target), { recursive: true });
          await writeFile(target, bytes, { flag: "wx", mode: file.executable ? 0o700 : 0o600 });
        }
        const sbomPath = resolve(absoluteBundle, "sbom.spdx.json");
        const sbomBytes = await readVerifiedBundleFile(absoluteBundle, sbomPath, "SBOM 文件无效");
        if (sha256Bytes(sbomBytes) !== manifest.sbomSha256) throw new Error("SBOM SHA-256 不匹配");
        await writeFile(join(stagingRoot, "release-manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
        await writeFile(join(stagingRoot, "sbom.spdx.json"), sbomBytes, { flag: "wx", mode: 0o600 });
        await mkdir(join(this.rootDirectory, "versions"), { recursive: true });
        await rename(stagingRoot, targetVersionRoot);
      } catch (error: unknown) {
        await rm(stagingRoot, { recursive: true, force: true });
        throw error;
      }

      const next: ReleaseState = {
        currentVersion: manifest.version,
        ...(current.currentVersion === undefined ? {} : { previousVersion: current.currentVersion }),
        installedVersions: uniqueSorted([...current.installedVersions, manifest.version]),
        updatedAt: this.now(),
      };
      await this.writeState(next);
      return next;
    });
  }

  public async rollback(): Promise<ReleaseState> {
    return this.serialize(async () => {
      const current = await this.getState();
      if (current.currentVersion === undefined || current.previousVersion === undefined) throw new Error("没有可回滚版本");
      const previousRoot = join(this.rootDirectory, "versions", current.previousVersion);
      const stat = await lstat(previousRoot);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("回滚版本目录无效");
      const next: ReleaseState = {
        currentVersion: current.previousVersion,
        previousVersion: current.currentVersion,
        installedVersions: current.installedVersions,
        updatedAt: this.now(),
      };
      await this.writeState(next);
      return next;
    });
  }

  private async writeState(state: ReleaseState): Promise<void> {
    await mkdir(this.rootDirectory, { recursive: true });
    const target = this.statePath();
    const temporary = `${target}.${this.ids.next("state")}.tmp`;
    await writeFile(temporary, JSON.stringify(state, null, 2), "utf8");
    await rename(temporary, target);
  }

  private statePath(): string { return join(this.rootDirectory, "release-state.json"); }

  private async listInstalledVersions(): Promise<readonly string[]> {
    try {
      return (await readdir(join(this.rootDirectory, "versions"))).filter(version => /^\d+\.\d+\.\d+$/.test(version)).sort(compareVersion);
    } catch (error: unknown) {
      if (isMissingFile(error)) return [];
      throw error;
    }
  }

  private async serialize<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.writeQueue;
    let release!: () => void;
    this.writeQueue = new Promise<void>(resolveQueue => { release = resolveQueue; });
    await previous;
    try { return await operation(); } finally { release(); }
  }
}

async function readVerifiedBundleFile(root: string, source: string, invalidMessage: string): Promise<Buffer> {
  const before = await lstat(source);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error(invalidMessage);
  const canonicalBefore = await realpath(source);
  if (!isWithin(root, canonicalBefore)) throw new Error(invalidMessage);
  const bytes = await readFile(source);
  const after = await lstat(source);
  if (!after.isFile() || after.isSymbolicLink()) throw new Error(invalidMessage);
  const canonicalAfter = await realpath(source);
  if (canonicalAfter !== canonicalBefore || !isWithin(root, canonicalAfter)) throw new Error("发布文件在校验期间发生变化");
  return bytes;
}

function validateReleaseState(value: unknown): ReleaseState {
  if (!isRecord(value) || !Array.isArray(value.installedVersions) || !value.installedVersions.every(item => typeof item === "string" && /^\d+\.\d+\.\d+$/.test(item)) || typeof value.updatedAt !== "string") {
    throw new Error("发布状态文件结构无效");
  }
  if (value.currentVersion !== undefined && (typeof value.currentVersion !== "string" || !value.installedVersions.includes(value.currentVersion))) throw new Error("当前版本状态无效");
  if (value.previousVersion !== undefined && (typeof value.previousVersion !== "string" || !value.installedVersions.includes(value.previousVersion))) throw new Error("回滚版本状态无效");
  return {
    ...(value.currentVersion === undefined ? {} : { currentVersion: value.currentVersion }),
    ...(value.previousVersion === undefined ? {} : { previousVersion: value.previousVersion }),
    installedVersions: [...value.installedVersions],
    updatedAt: value.updatedAt,
  };
}

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}
function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function isMissingFile(error: unknown): boolean { return isRecord(error) && error.code === "ENOENT"; }
function uniqueSorted(values: readonly string[]): string[] { return [...new Set(values)].sort(compareVersion); }
function compareVersion(left: string, right: string): number {
  const a = left.split(".").map(Number); const b = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) { const delta = (a[index] ?? 0) - (b[index] ?? 0); if (delta !== 0) return delta; }
  return 0;
}
