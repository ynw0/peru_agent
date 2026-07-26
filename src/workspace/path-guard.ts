import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

// Windows 盘符路径和 UNC 路径在非 Windows 系统上也必须显式拒绝。
const WINDOWS_ABSOLUTE_PATH = /^[A-Za-z]:[\\/]/;
const WINDOWS_UNC_PATH = /^(?:\\\\|\/\/)/;

function isMissingPathError(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && (error as { readonly code?: unknown }).code === "ENOENT";
}

function isInsideRoot(root: string, candidate: string): boolean {
  const relation = relative(root, candidate);
  return relation === "" || (!relation.startsWith(`..${sep}`) && relation !== ".." && !isAbsolute(relation));
}

// 规范化模型提供的相对路径，并拒绝绝对路径、空路径和目录穿越。
export function normalizeWorkspacePath(input: string): string {
  const trimmed = input.trim();
  if (trimmed === "") {
    throw new Error("工作区路径不能为空");
  }
  if (trimmed.includes("\0")) {
    throw new Error("工作区路径不能包含空字符");
  }
  if (isAbsolute(trimmed) || WINDOWS_ABSOLUTE_PATH.test(trimmed) || WINDOWS_UNC_PATH.test(trimmed)) {
    throw new Error(`工作区路径必须是相对路径：${input}`);
  }

  const normalized = trimmed.replaceAll("\\", "/");
  const segments = normalized.split("/");
  if (segments.some(segment => segment === "..")) {
    throw new Error(`工作区路径不能包含目录穿越：${input}`);
  }
  if (segments.some(segment => segment === "" || segment === ".")) {
    throw new Error(`工作区路径包含无效目录段：${input}`);
  }
  return segments.join("/");
}

// PathGuard 同时做词法边界检查和现有路径的符号链接检查。
export class WorkspacePathGuard {
  private constructor(
    public readonly root: string,
    private readonly canonicalRoot: string,
  ) {}

  public static async create(root: string): Promise<WorkspacePathGuard> {
    const absoluteRoot = resolve(root);
    const canonicalRoot = await realpath(absoluteRoot);
    return new WorkspacePathGuard(absoluteRoot, canonicalRoot);
  }

  public async resolve(relativePath: string): Promise<{ readonly relativePath: string; readonly absolutePath: string }> {
    const normalized = normalizeWorkspacePath(relativePath);
    const absolutePath = resolve(this.root, ...normalized.split("/"));
    if (!isInsideRoot(this.root, absolutePath)) {
      throw new Error(`路径超出工作区：${relativePath}`);
    }

    await this.assertNoSymlinkEscape(normalized);
    return { relativePath: normalized, absolutePath };
  }

  private async assertNoSymlinkEscape(relativePath: string): Promise<void> {
    let current = this.root;
    for (const segment of relativePath.split("/")) {
      current = resolve(current, segment);
      try {
        const status = await lstat(current);
        if (status.isSymbolicLink()) {
          throw new Error(`工作区路径包含符号链接，拒绝访问：${relativePath}`);
        }
        const canonical = await realpath(current);
        if (!isInsideRoot(this.canonicalRoot, canonical)) {
          throw new Error(`工作区路径解析后越界：${relativePath}`);
        }
      } catch (error: unknown) {
        // 路径后半段尚不存在时，只能继续依赖词法边界；真正写入前仍会再次校验。
        if (isMissingPathError(error)) {
          return;
        }
        throw error;
      }
    }
  }
}
