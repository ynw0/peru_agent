import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SubagentCommit } from "./types.js";
import { normalizeWorkspacePath } from "../workspace/path-guard.js";

export interface SubagentCommitStore {
  save(commit: SubagentCommit): Promise<SubagentCommit>;
  get(commitId: string): Promise<SubagentCommit | undefined>;
  list(): Promise<readonly SubagentCommit[]>;
  delete(commitId: string): Promise<boolean>;
}

export class JsonSubagentCommitStore implements SubagentCommitStore {
  public constructor(private readonly directory: string) {}

  public async save(commit: SubagentCommit): Promise<SubagentCommit> {
    const canonical = normalizedCommit(commit);
    const expected = commitIdFor(canonical);
    if (commit.id !== expected) throw new Error("Commit ID 与内容哈希不匹配");
    await mkdir(this.directory, { recursive: true });
    const file = join(this.directory, `${commit.id}.json`);
    const temporary = `${file}.${Date.now()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(canonical, null, 2)}\n`, "utf8");
    await rename(temporary, file);
    return structuredClone(canonical);
  }

  public async get(commitId: string): Promise<SubagentCommit | undefined> {
    validateCommitId(commitId);
    try {
      const parsed = JSON.parse(await readFile(join(this.directory, `${commitId}.json`), "utf8")) as SubagentCommit;
      const canonical = normalizedCommit(parsed);
      if (commitIdFor(canonical) !== commitId) throw new Error(`Commit 内容哈希不匹配：${commitId}`);
      return structuredClone(canonical);
    } catch (error: unknown) {
      if (isMissing(error)) return undefined;
      throw error;
    }
  }

  public async list(): Promise<readonly SubagentCommit[]> {
    let names: readonly string[];
    try { names = await readdir(this.directory); } catch (error: unknown) { if (isMissing(error)) return []; throw error; }
    const commits: SubagentCommit[] = [];
    for (const name of names.filter(item => item.endsWith(".json"))) {
      const commit = await this.get(name.slice(0, -5));
      if (commit !== undefined) commits.push(commit);
    }
    return commits.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  public async delete(commitId: string): Promise<boolean> {
    validateCommitId(commitId);
    try { await rm(join(this.directory, `${commitId}.json`), { force: false }); return true; }
    catch (error: unknown) { if (isMissing(error)) return false; throw error; }
  }
}

export class InMemorySubagentCommitStore implements SubagentCommitStore {
  private readonly commits = new Map<string, SubagentCommit>();
  public async save(commit: SubagentCommit): Promise<SubagentCommit> { const canonical = normalizedCommit(commit); if (commitIdFor(canonical) !== commit.id) throw new Error("Commit ID 与内容哈希不匹配"); this.commits.set(commit.id, canonical); return structuredClone(canonical); }
  public async get(commitId: string): Promise<SubagentCommit | undefined> { const value = this.commits.get(commitId); return value === undefined ? undefined : structuredClone(value); }
  public async list(): Promise<readonly SubagentCommit[]> { return [...this.commits.values()].map(value => structuredClone(value)); }
  public async delete(commitId: string): Promise<boolean> { return this.commits.delete(commitId); }
}

export function createSubagentCommit(input: Omit<SubagentCommit, "id">): SubagentCommit {
  const canonical = normalizedCommit(input as SubagentCommit);
  return { ...canonical, id: commitIdFor(canonical) };
}

export function commitIdFor(commit: Omit<SubagentCommit, "id"> | SubagentCommit): string {
  return `commit-${createHash("sha256").update(JSON.stringify(hashPayload(commit as SubagentCommit)), "utf8").digest("hex")}`;
}

function normalizedCommit(commit: SubagentCommit): SubagentCommit {
  return {
    ...commit,
    files: [...commit.files].sort((left, right) => left.path.localeCompare(right.path)).map(file => ({
      path: normalizeWorkspacePath(file.path),
      before: file.before,
      after: file.after,
    })),
  };
}

function hashPayload(commit: SubagentCommit): Omit<SubagentCommit, "id"> {
  const { id: _id, ...withoutId } = normalizedCommit(commit);
  return withoutId;
}

function validateCommitId(value: string): void { if (!/^commit-[a-f0-9]{64}$/.test(value)) throw new Error(`Commit ID 无效：${value}`); }
function isMissing(error: unknown): boolean { return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ENOENT"; }
