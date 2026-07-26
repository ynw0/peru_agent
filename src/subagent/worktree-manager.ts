import { lstat, mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { WorkspaceFileSnapshot } from "../workspace/types.js";
import { WorkspaceRegistry, WorkspaceService } from "../workspace/workspace-service.js";
import { pathInAnyScope } from "./policy.js";
import type { SubagentPatchChange, SubagentTaskRecord, SubagentWorktreeSnapshot } from "./types.js";

export interface SnapshotWorktreeLimits {
  readonly maxFiles: number;
  readonly maxTotalBytes: number;
}

const DEFAULT_LIMITS: SnapshotWorktreeLimits = {
  maxFiles: 5_000,
  maxTotalBytes: 100 * 1024 * 1024,
};

export class SnapshotWorktreeManager {
  private readonly loaded = new Map<string, WorkspaceService>();

  public constructor(
    private readonly workspaces: WorkspaceRegistry,
    private readonly isolationRoot: string,
    private readonly limits: SnapshotWorktreeLimits = DEFAULT_LIMITS,
  ) {
    if (!Number.isInteger(limits.maxFiles) || limits.maxFiles <= 0
      || !Number.isInteger(limits.maxTotalBytes) || limits.maxTotalBytes <= 0) {
      throw new Error("隔离工作树容量限制必须是正整数");
    }
  }

  public async create(
    task: SubagentTaskRecord,
    signal?: AbortSignal,
  ): Promise<SubagentWorktreeSnapshot> {
    const root = join(this.isolationRoot, safeId(task.id));
    await rm(root, { recursive: true, force: true });
    await mkdir(root, { recursive: true });

    const base = this.workspaces.get(task.baseWorkspaceId);
    const workspaceId = `subagent:${task.id}`;
    const isolated = await WorkspaceService.create(workspaceId, root);
    let registered = false;
    try {
      assertNotAborted(signal);
      const basePaths = await base.glob("**/*", Math.min(this.limits.maxFiles + 1, 10_000));
      const scopedPaths = basePaths.filter(path => pathInAnyScope(path, task.allowedPaths));
      if (scopedPaths.length > this.limits.maxFiles
        || (basePaths.length === 10_000 && this.limits.maxFiles >= 10_000)) {
        throw new Error(`隔离工作树文件数超过限制 ${this.limits.maxFiles}`);
      }
      const baseFiles: WorkspaceFileSnapshot[] = [];
      let totalBytes = 0;

      for (const path of scopedPaths) {
        assertNotAborted(signal);
        const snapshot = await base.readText(path);
        totalBytes += snapshot.byteLength;
        if (totalBytes > this.limits.maxTotalBytes) {
          throw new Error(`隔离工作树总大小超过限制 ${this.limits.maxTotalBytes} 字节`);
        }
        baseFiles.push(snapshot);
        await isolated.writeText({ path, content: snapshot.content ?? "", expectedSha256: null });
      }

      assertNotAborted(signal);
      this.workspaces.register(isolated);
      registered = true;
      this.loaded.set(task.id, isolated);
      return {
      id: `worktree:${task.id}`,
      taskId: task.id,
      baseWorkspaceId: task.baseWorkspaceId,
      workspaceId,
      root,
      allowedPaths: [...task.allowedPaths],
      writablePaths: [...task.writablePaths],
      baseFiles,
        createdAt: new Date().toISOString(),
      };
    } catch (error: unknown) {
      if (registered) {
        this.workspaces.unregister(workspaceId);
        this.loaded.delete(task.id);
      }
      await rm(root, { recursive: true, force: true });
      throw error;
    }
  }

  public async restore(snapshot: SubagentWorktreeSnapshot): Promise<void> {
    const expectedRoot = resolve(this.isolationRoot, safeId(snapshot.taskId));
    if (resolve(snapshot.root) !== expectedRoot || snapshot.workspaceId !== `subagent:${snapshot.taskId}`) {
      throw new Error("持久化隔离工作树路径或 Workspace ID 不匹配");
    }
    const status = await lstat(snapshot.root);
    if (!status.isDirectory()) {
      throw new Error(`子 Agent 隔离工作区不是目录：${snapshot.root}`);
    }
    const workspace = await WorkspaceService.create(snapshot.workspaceId, snapshot.root);
    this.workspaces.register(workspace);
    this.loaded.set(snapshot.taskId, workspace);
  }

  public get(taskId: string): WorkspaceService {
    const workspace = this.loaded.get(taskId);
    if (workspace === undefined) {
      throw new Error(`子 Agent 隔离工作区未加载：${taskId}`);
    }
    return workspace;
  }

  public async collectPatch(snapshot: SubagentWorktreeSnapshot): Promise<readonly SubagentPatchChange[]> {
    const isolated = this.get(snapshot.taskId);
    const baseByPath = new Map(snapshot.baseFiles.map(file => [file.path, file]));
    const isolatedPaths = await isolated.glob("**/*", Math.min(this.limits.maxFiles + 1, 10_000));
    if (isolatedPaths.length > this.limits.maxFiles) {
      throw new Error(`隔离工作树文件数超过限制 ${this.limits.maxFiles}`);
    }
    const allPaths = new Set([...baseByPath.keys(), ...isolatedPaths]);
    const changes: SubagentPatchChange[] = [];

    for (const path of [...allPaths].sort()) {
      if (!pathInAnyScope(path, snapshot.allowedPaths)) {
        throw new Error(`隔离工作区出现允许范围外文件：${path}`);
      }
      const before = baseByPath.get(path) ?? missingSnapshot(path);
      const after = await isolated.snapshot(path);
      if (!after.exists && before.exists) {
        throw new Error(`子 Agent Patch 暂不支持删除文件：${path}`);
      }
      if (before.sha256 === after.sha256) {
        continue;
      }
      if (!pathInAnyScope(path, snapshot.writablePaths)) {
        throw new Error(`子 Agent 修改了只读路径：${path}`);
      }
      changes.push({ path, before, afterContent: after.content ?? "" });
    }
    return changes;
  }

  public async cleanup(taskId: string): Promise<void> {
    const workspace = this.loaded.get(taskId);
    if (workspace !== undefined) {
      this.workspaces.unregister(workspace.workspaceId);
      this.loaded.delete(taskId);
      await rm(workspace.root, { recursive: true, force: true });
    }
  }
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) {
    const error = new Error("隔离工作树创建被取消");
    error.name = "AbortError";
    throw error;
  }
}

function missingSnapshot(path: string): WorkspaceFileSnapshot {
  return { path, exists: false, content: null, sha256: null, byteLength: 0 };
}

function safeId(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_");
}
