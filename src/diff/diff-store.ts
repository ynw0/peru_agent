import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DiffProposal } from "./diff-manager.js";

export interface DiffProposalStore {
  save(proposal: DiffProposal): Promise<void>;
  load(id: string): Promise<DiffProposal | undefined>;
  list(): Promise<readonly DiffProposal[]>;
}

export class InMemoryDiffProposalStore implements DiffProposalStore {
  private readonly proposals = new Map<string, DiffProposal>();

  public async save(proposal: DiffProposal): Promise<void> {
    this.proposals.set(proposal.id, structuredClone(proposal));
  }

  public async load(id: string): Promise<DiffProposal | undefined> {
    const proposal = this.proposals.get(id);
    return proposal === undefined ? undefined : structuredClone(proposal);
  }

  public async list(): Promise<readonly DiffProposal[]> {
    return [...this.proposals.values()]
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map(proposal => structuredClone(proposal));
  }
}

export class JsonDiffProposalStore implements DiffProposalStore {
  public constructor(private readonly directory: string) {}

  public async save(proposal: DiffProposal): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const target = join(this.directory, `${proposal.id}.json`);
    const temporary = `${target}.${Date.now()}.tmp`;
    await writeFile(temporary, JSON.stringify(proposal, null, 2), "utf8");
    await rename(temporary, target);
  }

  public async load(id: string): Promise<DiffProposal | undefined> {
    try {
      return validateDiffProposal(JSON.parse(await readFile(join(this.directory, `${id}.json`), "utf8")) as unknown);
    } catch (error: unknown) {
      if (typeof error === "object" && error !== null && "code" in error
        && (error as { readonly code?: unknown }).code === "ENOENT") {
        return undefined;
      }
      throw error;
    }
  }

  public async list(): Promise<readonly DiffProposal[]> {
    await mkdir(this.directory, { recursive: true });
    const names = (await readdir(this.directory)).filter(name => name.endsWith(".json")).sort();
    const proposals: DiffProposal[] = [];
    for (const name of names) {
      proposals.push(validateDiffProposal(JSON.parse(await readFile(join(this.directory, name), "utf8")) as unknown));
    }
    return proposals.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateDiffProposal(value: unknown): DiffProposal {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.sessionId !== "string"
    || typeof value.workspaceId !== "string" || typeof value.toolCallId !== "string"
    || typeof value.createdAt !== "string" || !Array.isArray(value.changes)
    || !["proposed", "accepted", "rejected", "conflict"].includes(String(value.status))) {
    throw new Error("Diff Proposal 文件结构无效");
  }
  for (const change of value.changes) {
    if (!isRecord(change) || typeof change.path !== "string" || typeof change.afterContent !== "string"
      || typeof change.afterSha256 !== "string" || typeof change.unifiedDiff !== "string"
      || !isRecord(change.before)) {
      throw new Error("Diff Proposal 文件修改结构无效");
    }
  }
  return value as unknown as DiffProposal;
}
