import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentSessionSnapshot } from "../agent/types.js";

export interface TrashedSessionRecord {
  readonly snapshot: AgentSessionSnapshot;
  readonly deletedAt: string;
}

export interface SessionStore {
  save(snapshot: AgentSessionSnapshot): Promise<void>;
  load(sessionId: string): Promise<AgentSessionSnapshot | undefined>;
  list(): Promise<readonly AgentSessionSnapshot[]>;
  trash(snapshot: AgentSessionSnapshot): Promise<TrashedSessionRecord>;
  listTrash(): Promise<readonly TrashedSessionRecord[]>;
  restoreTrash(sessionId: string): Promise<AgentSessionSnapshot | undefined>;
  deletePermanently(sessionId: string): Promise<boolean>;
  purgeExpired(before: string): Promise<number>;
}

export class InMemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, AgentSessionSnapshot>();
  private readonly trashRecords = new Map<string, TrashedSessionRecord>();

  public async save(snapshot: AgentSessionSnapshot): Promise<void> {
    this.sessions.set(snapshot.id, structuredClone(snapshot));
  }

  public async load(sessionId: string): Promise<AgentSessionSnapshot | undefined> {
    const snapshot = this.sessions.get(sessionId);
    return snapshot === undefined ? undefined : structuredClone(snapshot);
  }

  public async list(): Promise<readonly AgentSessionSnapshot[]> {
    return [...this.sessions.values()].map(snapshot => structuredClone(snapshot));
  }

  public async trash(snapshot: AgentSessionSnapshot): Promise<TrashedSessionRecord> {
    const record = { snapshot: structuredClone(snapshot), deletedAt: new Date().toISOString() };
    this.sessions.delete(snapshot.id);
    this.trashRecords.set(snapshot.id, record);
    return structuredClone(record);
  }
  public async listTrash(): Promise<readonly TrashedSessionRecord[]> { return [...this.trashRecords.values()].map(record => structuredClone(record)); }
  public async restoreTrash(sessionId: string): Promise<AgentSessionSnapshot | undefined> {
    const record = this.trashRecords.get(sessionId);
    if (record === undefined) return undefined;
    this.trashRecords.delete(sessionId);
    this.sessions.set(sessionId, structuredClone(record.snapshot));
    return structuredClone(record.snapshot);
  }
  public async deletePermanently(sessionId: string): Promise<boolean> { return this.trashRecords.delete(sessionId); }
  public async purgeExpired(before: string): Promise<number> {
    let count = 0;
    for (const [id, record] of this.trashRecords) if (record.deletedAt < before) { this.trashRecords.delete(id); count += 1; }
    return count;
  }
}

// JsonSessionStore 先写临时文件再原子 rename，避免进程中断产生半个 JSON 文件。
export class JsonSessionStore implements SessionStore {
  public constructor(private readonly directory: string) {}

  public async save(snapshot: AgentSessionSnapshot): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const filePath = this.getPath(snapshot.id);
    const temporaryPath = `${filePath}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
    await rename(temporaryPath, filePath);
  }

  public async load(sessionId: string): Promise<AgentSessionSnapshot | undefined> {
    try {
      const text = await readFile(this.getPath(sessionId), "utf8");
      return validateSnapshot(JSON.parse(text) as unknown);
    } catch (error: unknown) {
      if (isMissingFileError(error)) {
        return undefined;
      }
      throw error;
    }
  }

  public async list(): Promise<readonly AgentSessionSnapshot[]> {
    let names: readonly string[];
    try {
      names = await readdir(this.directory);
    } catch (error: unknown) {
      if (isMissingFileError(error)) {
        return [];
      }
      throw error;
    }

    const result: AgentSessionSnapshot[] = [];
    for (const name of names.filter(value => value.endsWith(".json")).sort()) {
      const text = await readFile(join(this.directory, name), "utf8");
      result.push(validateSnapshot(JSON.parse(text) as unknown));
    }
    return result;
  }

  public async trash(snapshot: AgentSessionSnapshot): Promise<TrashedSessionRecord> {
    const record: TrashedSessionRecord = { snapshot: structuredClone(snapshot), deletedAt: new Date().toISOString() };
    const trashDirectory = this.getTrashDirectory();
    await mkdir(trashDirectory, { recursive: true });
    const target = join(trashDirectory, `${this.safeId(snapshot.id)}.json`);
    const temporary = `${target}.tmp`;
    await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, "utf8");
    await rename(temporary, target);
    await unlink(this.getPath(snapshot.id)).catch(error => { if (!isMissingFileError(error)) throw error; });
    return structuredClone(record);
  }

  public async listTrash(): Promise<readonly TrashedSessionRecord[]> {
    const directory = this.getTrashDirectory();
    let names: readonly string[];
    try { names = await readdir(directory); } catch (error: unknown) { if (isMissingFileError(error)) return []; throw error; }
    const records: TrashedSessionRecord[] = [];
    for (const name of names.filter(value => value.endsWith(".json")).sort()) {
      const parsed = JSON.parse(await readFile(join(directory, name), "utf8")) as unknown;
      records.push(validateTrashRecord(parsed));
    }
    return records.sort((left, right) => right.deletedAt.localeCompare(left.deletedAt));
  }

  public async restoreTrash(sessionId: string): Promise<AgentSessionSnapshot | undefined> {
    const source = join(this.getTrashDirectory(), `${this.safeId(sessionId)}.json`);
    let record: TrashedSessionRecord;
    try { record = validateTrashRecord(JSON.parse(await readFile(source, "utf8")) as unknown); }
    catch (error: unknown) { if (isMissingFileError(error)) return undefined; throw error; }
    await this.save(record.snapshot);
    await unlink(source);
    return structuredClone(record.snapshot);
  }

  public async deletePermanently(sessionId: string): Promise<boolean> {
    try { await unlink(join(this.getTrashDirectory(), `${this.safeId(sessionId)}.json`)); return true; }
    catch (error: unknown) { if (isMissingFileError(error)) return false; throw error; }
  }

  public async purgeExpired(before: string): Promise<number> {
    const records = await this.listTrash();
    let count = 0;
    for (const record of records) if (record.deletedAt < before && await this.deletePermanently(record.snapshot.id)) count += 1;
    return count;
  }

  private getPath(sessionId: string): string {
    return join(this.directory, `${this.safeId(sessionId)}.json`);
  }
  private safeId(sessionId: string): string { return sessionId.replace(/[^A-Za-z0-9._-]/g, "_"); }
  private getTrashDirectory(): string { return join(this.directory, "trash"); }
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && (error as { code?: unknown }).code === "ENOENT";
}

function validateSnapshot(value: unknown): AgentSessionSnapshot {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("会话文件必须是 JSON 对象");
  }
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string"
    || typeof record.workspaceId !== "string"
    || typeof record.status !== "string"
    || !Array.isArray(record.messages)) {
    throw new Error("会话文件结构无效");
  }
  return value as AgentSessionSnapshot;
}

function validateTrashRecord(value: unknown): TrashedSessionRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("回收 Session 文件必须是对象");
  const record = value as Record<string, unknown>;
  if (typeof record.deletedAt !== "string" || typeof record.snapshot !== "object" || record.snapshot === null) throw new Error("回收 Session 文件结构无效");
  return { deletedAt: record.deletedAt, snapshot: validateSnapshot(record.snapshot) };
}
