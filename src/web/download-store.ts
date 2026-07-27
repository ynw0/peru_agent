import { mkdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve } from "node:path";
import type { IdGenerator } from "../agent/id-generator.js";
import type { WebDownloadArtifact } from "./types.js";

export interface SaveDownloadRequest {
  readonly workspaceId: string;
  readonly sourceUrl: string;
  readonly suggestedFileName: string;
  readonly contentType: string;
  readonly bytes: Uint8Array;
  readonly sha256: string;
}

export interface DownloadArtifactStore {
  save(request: SaveDownloadRequest): Promise<WebDownloadArtifact>;
}

// 下载只能进入产品管理的 Artifact 目录，不能使用网页提供的任意绝对路径。
export class FileSystemDownloadArtifactStore implements DownloadArtifactStore {
  private initializedRoot?: string;

  public constructor(
    private readonly root: string,
    private readonly ids: IdGenerator,
  ) {
    if (root.trim() === "") throw new Error("下载 Artifact 根目录不能为空");
  }

  public async save(request: SaveDownloadRequest): Promise<WebDownloadArtifact> {
    validateWorkspaceId(request.workspaceId);
    validateSha256(request.sha256);
    const root = await this.requireRoot();
    const workspaceRoot = resolve(root, request.workspaceId);
    assertInside(root, workspaceRoot);
    await mkdir(workspaceRoot, { recursive: true });
    const resolvedWorkspaceRoot = await realpath(workspaceRoot);
    assertInside(root, resolvedWorkspaceRoot);

    const artifactId = this.ids.next("download");
    const fileName = sanitizeFileName(request.suggestedFileName);
    const storedFileName = `${sanitizeIdentifier(artifactId)}-${fileName}`;
    const finalPath = resolve(resolvedWorkspaceRoot, storedFileName);
    const temporaryPath = resolve(resolvedWorkspaceRoot, `.${storedFileName}.tmp`);
    assertInside(resolvedWorkspaceRoot, finalPath);
    assertInside(resolvedWorkspaceRoot, temporaryPath);

    try {
      await writeFile(temporaryPath, request.bytes, { flag: "wx", mode: 0o600 });
      await rename(temporaryPath, finalPath);
    } catch (error: unknown) {
      await rm(temporaryPath, { force: true });
      throw error;
    }

    const createdAt = new Date().toISOString();
    return {
      id: artifactId,
      workspaceId: request.workspaceId,
      fileName,
      relativePath: relative(root, finalPath).replaceAll("\\", "/"),
      sourceUrl: request.sourceUrl,
      contentType: request.contentType,
      byteLength: request.bytes.byteLength,
      sha256: request.sha256,
      createdAt,
    };
  }

  private async requireRoot(): Promise<string> {
    if (this.initializedRoot !== undefined) return this.initializedRoot;
    await mkdir(this.root, { recursive: true });
    this.initializedRoot = await realpath(this.root);
    return this.initializedRoot;
  }
}

export function chooseDownloadFileName(url: string, contentDisposition?: string): string {
  const fromHeader = parseContentDispositionFileName(contentDisposition);
  if (fromHeader !== undefined) return sanitizeFileName(fromHeader);
  const urlName = basename(new URL(url).pathname);
  return sanitizeFileName(urlName === "" || urlName === "/" ? "download.bin" : urlName);
}

function parseContentDispositionFileName(value?: string): string | undefined {
  if (value === undefined) return undefined;
  const extended = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(value)?.[1];
  if (extended !== undefined) {
    try {
      return decodeURIComponent(extended.trim().replace(/^"|"$/g, ""));
    } catch {
      throw new Error("Content-Disposition filename* 不是有效 UTF-8 URL 编码");
    }
  }
  const plain = /filename\s*=\s*(?:"([^"]+)"|([^;]+))/i.exec(value);
  return (plain?.[1] ?? plain?.[2])?.trim();
}

function sanitizeFileName(value: string): string {
  const normalized = value.normalize("NFKC").replace(/[\u0000-\u001f\u007f]/g, "_");
  const leaf = basename(normalized.replaceAll("\\", "/"));
  const safe = leaf.replace(/[<>:"/\\|?*]/g, "_").replace(/[. ]+$/g, "").trim();
  if (safe === "" || safe === "." || safe === "..") return "download.bin";
  return safe.slice(0, 180);
}

function sanitizeIdentifier(value: string): string {
  const safe = value.replace(/[^A-Za-z0-9._-]/g, "_");
  if (safe === "") throw new Error("Artifact ID 无效");
  return safe;
}

function validateWorkspaceId(value: string): void {
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(value) || value === "." || value === "..") {
    throw new Error("下载 workspaceId 只能包含字母、数字、点、下划线和连字符");
  }
}

function validateSha256(value: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error("下载 SHA-256 无效");
}

function assertInside(root: string, target: string): void {
  const relation = relative(root, target);
  if (relation === "") return;
  if (isAbsolute(relation) || relation === ".." || relation.startsWith("../") || relation.startsWith("..\\")) {
    throw new Error("下载 Artifact 路径越界");
  }
}
