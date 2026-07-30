import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { WorkspacePathGuard, normalizeWorkspacePath } from "./path-guard.js";
import type {
  WorkspaceFileSnapshot,
  WorkspaceSearchMatch,
  WorkspaceWriteRequest,
} from "./types.js";

function isMissingPathError(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && (error as { readonly code?: unknown }).code === "ENOENT";
}

export function sha256Text(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export function sha256Bytes(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

function createGlobRegex(pattern: string): RegExp {
  const normalized = normalizeWorkspacePath(pattern);
  let source = "^";
  for (let index = 0; index < normalized.length; index += 1) {
    const character = normalized[index];
    const next = normalized[index + 1];
    const afterNext = normalized[index + 2];
    if (character === "*" && next === "*" && afterNext === "/") {
      // **/ 可以匹配零层或多层目录，因此根目录文件也能被 **/* 找到。
      source += "(?:.*/)?";
      index += 2;
    } else if (character === "*" && next === "*") {
      source += ".*";
      index += 1;
    } else if (character === "*") {
      source += "[^/]*";
    } else if (character === "?") {
      source += "[^/]";
    } else {
      source += character?.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&") ?? "";
    }
  }
  return new RegExp(`${source}$`);
}


// WorkspaceService 是所有文件工具的唯一文件系统入口。
export class WorkspaceService {
  private mutationQueue: Promise<void> = Promise.resolve();

  private constructor(
    public readonly workspaceId: string,
    public readonly root: string,
    private readonly guard: WorkspacePathGuard,
  ) {}

  public static async create(workspaceId: string, root: string): Promise<WorkspaceService> {
    if (workspaceId.trim() === "") {
      throw new Error("工作区 ID 不能为空");
    }
    await mkdir(root, { recursive: true });
    const guard = await WorkspacePathGuard.create(root);
    return new WorkspaceService(workspaceId, guard.root, guard);
  }

  public async snapshot(path: string): Promise<WorkspaceFileSnapshot> {
    const resolved = await this.guard.resolve(path);
    try {
      const status = await lstat(resolved.absolutePath);
      if (!status.isFile()) {
        throw new Error(`路径不是普通文件：${resolved.relativePath}`);
      }
      const content = await readFile(resolved.absolutePath, "utf8");
      return {
        path: resolved.relativePath,
        exists: true,
        content,
        sha256: sha256Text(content),
        byteLength: new TextEncoder().encode(content).byteLength,
      };
    } catch (error: unknown) {
      if (isMissingPathError(error)) {
        return {
          path: resolved.relativePath,
          exists: false,
          content: null,
          sha256: null,
          byteLength: 0,
        };
      }
      throw error;
    }
  }

  public async readText(path: string): Promise<WorkspaceFileSnapshot> {
    const snapshot = await this.snapshot(path);
    if (!snapshot.exists || snapshot.content === null) {
      throw new Error(`文件不存在：${snapshot.path}`);
    }
    return snapshot;
  }

  public async readBytes(path: string): Promise<WorkspaceFileSnapshot> {
    const resolved = await this.guard.resolve(path);
    try {
      const status = await lstat(resolved.absolutePath);
      if (!status.isFile()) throw new Error(`路径不是普通文件：${resolved.relativePath}`);
      const bytes = await readFile(resolved.absolutePath);
      return {
        path: resolved.relativePath,
        exists: true,
        content: null,
        bytesBase64: bytes.toString("base64"),
        sha256: sha256Bytes(bytes),
        byteLength: bytes.byteLength,
      };
    } catch (error: unknown) {
      if (isMissingPathError(error)) {
        return { path: resolved.relativePath, exists: false, content: null, sha256: null, byteLength: 0 };
      }
      throw error;
    }
  }

  public writeText(request: WorkspaceWriteRequest): Promise<WorkspaceFileSnapshot> {
    return this.enqueueMutation(() => this.writeTextInternal(request));
  }

  public writeBytes(request: { readonly path: string; readonly bytes: Uint8Array; readonly expectedSha256: string | null }): Promise<WorkspaceFileSnapshot> {
    return this.enqueueMutation(async () => {
      const resolved = await this.guard.resolve(request.path);
      const current = await this.readBytes(resolved.relativePath);
      if (current.sha256 !== request.expectedSha256) throw new WorkspaceConflictError(resolved.relativePath, request.expectedSha256, current.sha256);
      await mkdir(dirname(resolved.absolutePath), { recursive: true });
      const temporaryPath = `${resolved.absolutePath}.independent-ai-ide-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`;
      await writeFile(temporaryPath, request.bytes);
      try {
        const latest = await this.readBytes(resolved.relativePath);
        if (latest.sha256 !== request.expectedSha256) throw new WorkspaceConflictError(resolved.relativePath, request.expectedSha256, latest.sha256);
        await rename(temporaryPath, resolved.absolutePath);
      } catch (error: unknown) {
        await rm(temporaryPath, { force: true });
        throw error;
      }
      return this.readBytes(resolved.relativePath);
    });
  }

  private async writeTextInternal(request: WorkspaceWriteRequest): Promise<WorkspaceFileSnapshot> {
    // 执行前重新解析路径和哈希，避免 inspect 与 execute 之间的外部修改被覆盖。
    const resolved = await this.guard.resolve(request.path);
    const current = await this.snapshot(resolved.relativePath);
    if (current.sha256 !== request.expectedSha256) {
      throw new WorkspaceConflictError(
        resolved.relativePath,
        request.expectedSha256,
        current.sha256,
      );
    }

    await mkdir(dirname(resolved.absolutePath), { recursive: true });
    const temporaryPath = `${resolved.absolutePath}.independent-ai-ide-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`;
    await writeFile(temporaryPath, request.content, "utf8");
    try {
      // 写临时文件期间用户仍可能改动目标文件，因此 rename 前再做一次哈希检查。
      const latest = await this.snapshot(resolved.relativePath);
      if (latest.sha256 !== request.expectedSha256) {
        throw new WorkspaceConflictError(
          resolved.relativePath,
          request.expectedSha256,
          latest.sha256,
        );
      }
      await rename(temporaryPath, resolved.absolutePath);
    } catch (error: unknown) {
      await rm(temporaryPath, { force: true });
      throw error;
    }
    return this.readText(resolved.relativePath);
  }


  public deleteFile(path: string, expectedSha256: string): Promise<void> {
    return this.enqueueMutation(async () => {
      const resolved = await this.guard.resolve(path);
      const current = await this.readText(resolved.relativePath);
      if (current.sha256 !== expectedSha256) {
        throw new WorkspaceConflictError(resolved.relativePath, expectedSha256, current.sha256);
      }
      await rm(resolved.absolutePath, { force: false });
    });
  }


  public async glob(pattern: string, maxResults = 200): Promise<readonly string[]> {
    if (!Number.isInteger(maxResults) || maxResults <= 0 || maxResults > 10_000) {
      throw new Error("maxResults 必须是 1~10000 的整数");
    }
    const regex = createGlobRegex(pattern);
    const results: string[] = [];
    await this.walkDirectory("", results, regex, maxResults);
    return results;
  }

  public async grep(
    query: string,
    pattern = "**/*",
    caseSensitive = false,
    maxResults = 200,
  ): Promise<readonly WorkspaceSearchMatch[]> {
    if (query === "") {
      throw new Error("搜索内容不能为空");
    }
    if (!Number.isInteger(maxResults) || maxResults <= 0 || maxResults > 10_000) {
      throw new Error("maxResults 必须是 1~10000 的整数");
    }

    const paths = await this.glob(pattern, 10_000);
    const needle = caseSensitive ? query : query.toLocaleLowerCase();
    const matches: WorkspaceSearchMatch[] = [];
    for (const path of paths) {
      const snapshot = await this.readText(path);
      const lines = snapshot.content?.split(/\r?\n/) ?? [];
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index] ?? "";
        const searchable = caseSensitive ? line : line.toLocaleLowerCase();
        if (searchable.includes(needle)) {
          matches.push({ path, line: index + 1, text: line });
          if (matches.length >= maxResults) {
            return matches;
          }
        }
      }
    }
    return matches;
  }

  private enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationQueue.then(operation, operation);
    this.mutationQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  private async walkDirectory(
    relativeDirectory: string,
    results: string[],
    regex: RegExp,
    maxResults: number,
  ): Promise<void> {
    const directoryPath = relativeDirectory === ""
      ? this.root
      : (await this.guard.resolve(relativeDirectory)).absolutePath;
    const entries = await readdir(directoryPath, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      if (results.length >= maxResults) {
        return;
      }
      const relativePath = relativeDirectory === "" ? entry.name : `${relativeDirectory}/${entry.name}`;
      if (entry.isSymbolicLink()) {
        continue;
      }
      if (entry.isDirectory()) {
        await this.walkDirectory(relativePath, results, regex, maxResults);
      } else if (entry.isFile() && regex.test(relativePath)) {
        results.push(relativePath);
      }
    }
  }
}

// 冲突错误同时记录模型检查时的哈希和执行时看到的真实哈希。
export class WorkspaceConflictError extends Error {
  public readonly code = "WORKSPACE_FILE_CONFLICT";

  public constructor(
    public readonly path: string,
    public readonly expectedSha256: string | null,
    public readonly actualSha256: string | null,
  ) {
    super(`文件在提议后发生变化，拒绝覆盖：${path}`);
    this.name = "WorkspaceConflictError";
  }
}

// WorkspaceRegistry 将会话中的 workspaceId 映射到已经审核的工作区根目录。
export class WorkspaceRegistry {
  private readonly workspaces = new Map<string, WorkspaceService>();

  public register(workspace: WorkspaceService): void {
    if (this.workspaces.has(workspace.workspaceId)) {
      throw new Error(`工作区已注册：${workspace.workspaceId}`);
    }
    this.workspaces.set(workspace.workspaceId, workspace);
  }

  public unregister(workspaceId: string): boolean {
    return this.workspaces.delete(workspaceId);
  }

  public get(workspaceId: string): WorkspaceService {
    const workspace = this.workspaces.get(workspaceId);
    if (workspace === undefined) {
      throw new Error(`工作区未注册：${workspaceId}`);
    }
    return workspace;
  }

  public list(): readonly WorkspaceService[] {
    return [...this.workspaces.values()];
  }
}
