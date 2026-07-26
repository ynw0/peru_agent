import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentSessionSnapshot } from "../agent/types.js";

export interface SessionStore {
  save(snapshot: AgentSessionSnapshot): Promise<void>;
  load(sessionId: string): Promise<AgentSessionSnapshot | undefined>;
  list(): Promise<readonly AgentSessionSnapshot[]>;
}

export class InMemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, AgentSessionSnapshot>();

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

  private getPath(sessionId: string): string {
    const safeSessionId = sessionId.replace(/[^A-Za-z0-9._-]/g, "_");
    return join(this.directory, `${safeSessionId}.json`);
  }
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
