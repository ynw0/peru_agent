import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { IdGenerator } from "../agent/id-generator.js";
import type { WorkspaceFileSnapshot } from "../workspace/types.js";
import type { WorkspaceRegistry } from "../workspace/workspace-service.js";
import type { SessionStore } from "../storage/session-store.js";
import type { AgentSessionSnapshot } from "../agent/types.js";

export interface CheckpointFileEntry {
  readonly path: string;
  readonly before: WorkspaceFileSnapshot;
  readonly expectedAfterSha256: string | null;
  readonly afterContent: string | null;
}

export interface CheckpointRecord {
  readonly schemaVersion?: 1;
  readonly id: string;
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly proposalId: string;
  readonly createdAt: string;
  readonly status: "active" | "restored";
  readonly files: readonly CheckpointFileEntry[];
  readonly sessionSnapshot?: AgentSessionSnapshot;
  readonly conversationBranchSessionId?: string;
}

export interface CreateCheckpointInput {
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly proposalId: string;
  readonly files: readonly WorkspaceFileSnapshot[];
}

export interface CheckpointStore {
  save(record: CheckpointRecord): Promise<void>;
  load(id: string): Promise<CheckpointRecord | undefined>;
  list(workspaceId?: string): Promise<readonly CheckpointRecord[]>;
}

export class InMemoryCheckpointStore implements CheckpointStore {
  private readonly records = new Map<string, CheckpointRecord>();

  public async save(record: CheckpointRecord): Promise<void> {
    this.records.set(record.id, structuredClone(record));
  }

  public async load(id: string): Promise<CheckpointRecord | undefined> {
    const record = this.records.get(id);
    return record === undefined ? undefined : structuredClone(record);
  }

  public async list(workspaceId?: string): Promise<readonly CheckpointRecord[]> {
    return [...this.records.values()]
      .filter(record => workspaceId === undefined || record.workspaceId === workspaceId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map(record => structuredClone(record));
  }
}

// JSON Store 使用临时文件加 rename，避免中途退出留下半个 JSON。
export class JsonCheckpointStore implements CheckpointStore {
  public constructor(private readonly directory: string) {}

  public async save(record: CheckpointRecord): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const target = join(this.directory, `${record.id}.json`);
    const temporary = `${target}.${Date.now()}.tmp`;
    await writeFile(temporary, JSON.stringify(record, null, 2), "utf8");
    await rename(temporary, target);
  }

  public async load(id: string): Promise<CheckpointRecord | undefined> {
    try {
      return validateCheckpointRecord(JSON.parse(await readFile(join(this.directory, `${id}.json`), "utf8")) as unknown);
    } catch (error: unknown) {
      if (typeof error === "object" && error !== null && "code" in error
        && (error as { readonly code?: unknown }).code === "ENOENT") {
        return undefined;
      }
      throw error;
    }
  }

  public async list(workspaceId?: string): Promise<readonly CheckpointRecord[]> {
    await mkdir(this.directory, { recursive: true });
    const names = (await readdir(this.directory)).filter(name => name.endsWith(".json")).sort();
    const records: CheckpointRecord[] = [];
    for (const name of names) {
      const record = validateCheckpointRecord(JSON.parse(await readFile(join(this.directory, name), "utf8")) as unknown);
      if (workspaceId === undefined || record.workspaceId === workspaceId) {
        records.push(record);
      }
    }
    return records.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }
}

// CheckpointManager 只处理已经接受的 Diff；它不允许绕过冲突检查覆盖新修改。
export class CheckpointManager {
  public constructor(
    private readonly store: CheckpointStore,
    private readonly ids: IdGenerator,
    private readonly workspaces: WorkspaceRegistry,
    private readonly sessions?: SessionStore,
  ) {}

  public async create(input: CreateCheckpointInput): Promise<CheckpointRecord> {
    if (input.files.length === 0) {
      throw new Error("Checkpoint 至少包含一个文件");
    }
    const uniquePaths = new Set(input.files.map(file => file.path));
    if (uniquePaths.size !== input.files.length) {
      throw new Error("Checkpoint 不能包含重复文件");
    }

    const sessionSnapshot = this.sessions === undefined ? undefined : await this.sessions.load(input.sessionId);
    const record: CheckpointRecord = {
      schemaVersion: 1,
      id: this.ids.next("checkpoint"),
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      proposalId: input.proposalId,
      createdAt: new Date().toISOString(),
      status: "active",
      files: input.files.map(before => ({
        path: before.path,
        before,
        expectedAfterSha256: null,
        afterContent: null,
      })),
      ...(sessionSnapshot === undefined ? {} : { sessionSnapshot }),
    };
    await this.store.save(record);
    return record;
  }

  public async finalize(
    checkpointId: string,
    afterFiles: ReadonlyMap<string, { readonly sha256: string; readonly content: string }>,
  ): Promise<CheckpointRecord> {
    const record = await this.require(checkpointId);
    const finalized: CheckpointRecord = {
      ...record,
      files: record.files.map(file => {
        const after = afterFiles.get(file.path);
        if (after === undefined) {
          throw new Error(`Checkpoint 缺少写入后内容：${file.path}`);
        }
        return { ...file, expectedAfterSha256: after.sha256, afterContent: after.content };
      }),
    };
    await this.store.save(finalized);
    return finalized;
  }

  public async restore(checkpointId: string): Promise<CheckpointRecord> {
    const record = await this.require(checkpointId);
    if (record.status !== "active") {
      throw new Error(`Checkpoint 已恢复，不能重复执行：${checkpointId}`);
    }

    const workspace = this.workspaces.get(record.workspaceId);
    // 恢复前先验证所有文件，任何冲突都会让整个恢复停止，不产生部分写入。
    for (const file of record.files) {
      const current = await workspace.snapshot(file.path);
      if (current.sha256 !== file.expectedAfterSha256) {
        throw new CheckpointConflictError(file.path, file.expectedAfterSha256, current.sha256);
      }
    }

    const restoredFiles: CheckpointFileEntry[] = [];
    try {
      for (const file of record.files) {
        if (file.before.exists && file.before.content !== null) {
          await workspace.writeText({
            path: file.path,
            content: file.before.content,
            expectedSha256: file.expectedAfterSha256,
          });
        } else if (file.expectedAfterSha256 !== null) {
          await workspace.deleteFile(file.path, file.expectedAfterSha256);
        }
        restoredFiles.push(file);
      }
    } catch (error: unknown) {
      // 恢复中途失败时把已经恢复的文件写回修改后内容，保持事务完整。
      for (const file of [...restoredFiles].reverse()) {
        if (file.afterContent === null || file.expectedAfterSha256 === null) {
          throw new Error(`Checkpoint 缺少回滚内容：${file.path}`);
        }
        const current = await workspace.snapshot(file.path);
        await workspace.writeText({
          path: file.path,
          content: file.afterContent,
          expectedSha256: current.sha256,
        });
      }
      throw new Error(
        `Checkpoint 恢复失败且已回滚：${error instanceof Error ? error.message : "未知错误"}`,
      );
    }

    const restored: CheckpointRecord = { ...record, status: "restored" };
    await this.store.save(restored);
    return restored;
  }

  public get(id: string): Promise<CheckpointRecord | undefined> {
    return this.store.load(id);
  }

  public list(workspaceId?: string): Promise<readonly CheckpointRecord[]> {
    return this.store.list(workspaceId);
  }

  /** 将对话分支关系写回 Checkpoint，供重启后的恢复面板显示来源。 */
  public async recordConversationBranch(checkpointId: string, branchSessionId: string): Promise<CheckpointRecord> {
    const record = await this.require(checkpointId);
    const updated: CheckpointRecord = { ...record, conversationBranchSessionId: branchSessionId };
    await this.store.save(updated);
    return updated;
  }

  private async require(id: string): Promise<CheckpointRecord> {
    const record = await this.store.load(id);
    if (record === undefined) {
      throw new Error(`Checkpoint 不存在：${id}`);
    }
    return record;
  }
}

export class CheckpointConflictError extends Error {
  public readonly code = "CHECKPOINT_CONFLICT";

  public constructor(
    public readonly path: string,
    public readonly expectedSha256: string | null,
    public readonly actualSha256: string | null,
  ) {
    super(`Checkpoint 恢复前发现文件已变化：${path}`);
    this.name = "CheckpointConflictError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateCheckpointRecord(value: unknown): CheckpointRecord {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.workspaceId !== "string"
    || typeof value.sessionId !== "string" || typeof value.proposalId !== "string"
    || typeof value.createdAt !== "string" || !["active", "restored"].includes(String(value.status))
    || value.schemaVersion !== 1 || !Array.isArray(value.files)) {
    throw new Error("Checkpoint 文件结构无效或 schemaVersion 不受支持");
  }
  for (const file of value.files) {
    if (!isRecord(file) || typeof file.path !== "string" || !isRecord(file.before)
      || !(file.afterContent === null || typeof file.afterContent === "string")
      || !(file.expectedAfterSha256 === null || typeof file.expectedAfterSha256 === "string")) {
      throw new Error("Checkpoint 文件条目结构无效");
    }
  }
  return value as unknown as CheckpointRecord;
}
