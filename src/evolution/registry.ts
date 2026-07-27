import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { IdGenerator } from "../agent/id-generator.js";
import type {
  EvolutionAuditEntry,
  EvolutionCandidateRecord,
  EvolutionCandidateStatus,
  SignedWhitelistEntry,
} from "./types.js";

export interface CandidateRegistry {
  save(candidate: EvolutionCandidateRecord): Promise<void>;
  load(id: string): Promise<EvolutionCandidateRecord | undefined>;
  list(): Promise<readonly EvolutionCandidateRecord[]>;
  appendAudit(entry: EvolutionAuditEntry): Promise<void>;
  listAudit(): Promise<readonly EvolutionAuditEntry[]>;
  saveWhitelist(entry: SignedWhitelistEntry): Promise<void>;
  commitCandidateAndWhitelist(candidate: EvolutionCandidateRecord, entry: SignedWhitelistEntry): Promise<void>;
  listWhitelist(): Promise<readonly SignedWhitelistEntry[]>;
}

interface RegistryDocument {
  readonly version: 1;
  readonly candidates: readonly EvolutionCandidateRecord[];
  readonly audit: readonly EvolutionAuditEntry[];
  readonly whitelist: readonly SignedWhitelistEntry[];
}

export class InMemoryCandidateRegistry implements CandidateRegistry {
  private readonly candidates = new Map<string, EvolutionCandidateRecord>();
  private readonly audit: EvolutionAuditEntry[] = [];
  private readonly whitelist = new Map<string, SignedWhitelistEntry>();

  public async save(candidate: EvolutionCandidateRecord): Promise<void> {
    validateTransition(this.candidates.get(candidate.id)?.status, candidate.status);
    this.candidates.set(candidate.id, structuredClone(candidate));
  }

  public async load(id: string): Promise<EvolutionCandidateRecord | undefined> {
    const candidate = this.candidates.get(id);
    return candidate === undefined ? undefined : structuredClone(candidate);
  }

  public async list(): Promise<readonly EvolutionCandidateRecord[]> {
    return [...this.candidates.values()].map(item => structuredClone(item));
  }

  public async appendAudit(entry: EvolutionAuditEntry): Promise<void> {
    if (this.audit.some(item => item.id === entry.id)) throw new Error(`重复 Evolution Audit ID：${entry.id}`);
    this.audit.push(structuredClone(entry));
  }

  public async listAudit(): Promise<readonly EvolutionAuditEntry[]> {
    return this.audit.map(item => structuredClone(item));
  }

  public async saveWhitelist(entry: SignedWhitelistEntry): Promise<void> {
    this.whitelist.set(entry.candidateId, structuredClone(entry));
  }

  public async commitCandidateAndWhitelist(candidate: EvolutionCandidateRecord, entry: SignedWhitelistEntry): Promise<void> {
    if (entry.candidateId !== candidate.id) throw new Error("候选与白名单 Candidate ID 不一致");
    validateTransition(this.candidates.get(candidate.id)?.status, candidate.status);
    this.candidates.set(candidate.id, structuredClone(candidate));
    this.whitelist.set(entry.candidateId, structuredClone(entry));
  }

  public async listWhitelist(): Promise<readonly SignedWhitelistEntry[]> {
    return [...this.whitelist.values()].map(item => structuredClone(item));
  }
}

export class JsonCandidateRegistry implements CandidateRegistry {
  private queue: Promise<void> = Promise.resolve();

  public constructor(private readonly filePath: string) {}

  public save(candidate: EvolutionCandidateRecord): Promise<void> {
    return this.enqueue(async () => {
      const document = await this.read();
      const existing = document.candidates.find(item => item.id === candidate.id);
      validateTransition(existing?.status, candidate.status);
      await this.write({
        ...document,
        candidates: [...document.candidates.filter(item => item.id !== candidate.id), structuredClone(candidate)],
      });
    });
  }

  public async load(id: string): Promise<EvolutionCandidateRecord | undefined> {
    await this.queue;
    const candidate = (await this.read()).candidates.find(item => item.id === id);
    return candidate === undefined ? undefined : structuredClone(candidate);
  }

  public async list(): Promise<readonly EvolutionCandidateRecord[]> {
    await this.queue;
    return (await this.read()).candidates.map(item => structuredClone(item));
  }

  public appendAudit(entry: EvolutionAuditEntry): Promise<void> {
    return this.enqueue(async () => {
      const document = await this.read();
      if (document.audit.some(item => item.id === entry.id)) throw new Error(`重复 Evolution Audit ID：${entry.id}`);
      await this.write({ ...document, audit: [...document.audit, structuredClone(entry)] });
    });
  }

  public async listAudit(): Promise<readonly EvolutionAuditEntry[]> {
    await this.queue;
    return (await this.read()).audit.map(item => structuredClone(item));
  }

  public saveWhitelist(entry: SignedWhitelistEntry): Promise<void> {
    return this.enqueue(async () => {
      const document = await this.read();
      await this.write({
        ...document,
        whitelist: [...document.whitelist.filter(item => item.candidateId !== entry.candidateId), structuredClone(entry)],
      });
    });
  }

  public commitCandidateAndWhitelist(candidate: EvolutionCandidateRecord, entry: SignedWhitelistEntry): Promise<void> {
    return this.enqueue(async () => {
      if (entry.candidateId !== candidate.id) throw new Error("候选与白名单 Candidate ID 不一致");
      const document = await this.read();
      const existing = document.candidates.find(item => item.id === candidate.id);
      validateTransition(existing?.status, candidate.status);
      await this.write({
        ...document,
        candidates: [...document.candidates.filter(item => item.id !== candidate.id), structuredClone(candidate)],
        whitelist: [...document.whitelist.filter(item => item.candidateId !== entry.candidateId), structuredClone(entry)],
      });
    });
  }

  public async listWhitelist(): Promise<readonly SignedWhitelistEntry[]> {
    await this.queue;
    return (await this.read()).whitelist.map(item => structuredClone(item));
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  private async read(): Promise<RegistryDocument> {
    let content: string;
    try {
      content = await readFile(this.filePath, "utf8");
    } catch (error: unknown) {
      if (isMissing(error)) return { version: 1, candidates: [], audit: [], whitelist: [] };
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch (error: unknown) {
      throw new Error(`Candidate Registry JSON 损坏：${errorMessage(error)}`);
    }
    return validateDocument(parsed);
  }

  private async write(document: RegistryDocument): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${Date.now()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, "utf8");
    await rename(temporary, this.filePath);
  }
}

export class EvolutionAuditFactory {
  public constructor(
    private readonly ids: IdGenerator,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  public create(input: Omit<EvolutionAuditEntry, "id" | "createdAt">): EvolutionAuditEntry {
    return { ...input, id: this.ids.next("evolution-audit"), createdAt: this.now() };
  }
}

const ALLOWED_TRANSITIONS: Readonly<Record<EvolutionCandidateStatus, readonly EvolutionCandidateStatus[]>> = {
  draft: ["draft", "validating", "disabled"],
  validating: ["validationFailed", "awaitingManualApproval", "promoted"],
  validationFailed: ["validating", "disabled"],
  awaitingManualApproval: ["awaitingManualApproval", "promoted", "validationFailed", "disabled"],
  promoted: ["promoted", "disabled", "rolledBack"],
  disabled: ["disabled", "validating", "rolledBack"],
  rolledBack: ["rolledBack", "validating"],
};

export function validateTransition(previous: EvolutionCandidateStatus | undefined, next: EvolutionCandidateStatus): void {
  if (previous === undefined) {
    if (next !== "draft") throw new Error(`新候选必须从 draft 开始，不能直接进入 ${next}`);
    return;
  }
  if (!ALLOWED_TRANSITIONS[previous].includes(next)) {
    throw new Error(`非法候选状态转换：${previous} → ${next}`);
  }
}

function validateDocument(value: unknown): RegistryDocument {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.candidates)
    || !Array.isArray(value.audit) || !Array.isArray(value.whitelist)) {
    throw new Error("Candidate Registry 文档结构无效");
  }
  const candidates = value.candidates.map((item, index) => validateCandidateShape(item, `candidates[${index}]`));
  const ids = new Set<string>();
  for (const candidate of candidates) {
    if (ids.has(candidate.id)) throw new Error(`Candidate Registry 包含重复候选 ID：${candidate.id}`);
    ids.add(candidate.id);
  }
  return {
    version: 1,
    candidates,
    audit: value.audit.map((item, index) => validateAuditShape(item, `audit[${index}]`)),
    whitelist: value.whitelist.map((item, index) => validateWhitelistShape(item, `whitelist[${index}]`)),
  };
}

// 持久化边界做结构和关键枚举验证；完整业务一致性由 Runtime 在使用前再次验证。
function validateCandidateShape(value: unknown, label: string): EvolutionCandidateRecord {
  if (!isRecord(value) || !isString(value.id) || (value.kind !== "tool" && value.kind !== "skill")
    || !isString(value.name) || !isString(value.version) || !isString(value.description)
    || !isString(value.riskLevel) || !Array.isArray(value.capabilities) || !isRecord(value.payload)
    || !Array.isArray(value.sourceGapIds) || !isStatus(value.status)
    || !isString(value.createdAt) || !isString(value.updatedAt)) {
    throw new Error(`${label} 结构无效`);
  }
  return value as unknown as EvolutionCandidateRecord;
}

function validateAuditShape(value: unknown, label: string): EvolutionAuditEntry {
  if (!isRecord(value) || !isString(value.id) || !isString(value.action)
    || !isString(value.actor) || !isString(value.summary) || !isString(value.createdAt)) {
    throw new Error(`${label} 结构无效`);
  }
  return value as unknown as EvolutionAuditEntry;
}

function validateWhitelistShape(value: unknown, label: string): SignedWhitelistEntry {
  if (!isRecord(value) || !isString(value.candidateId) || !isString(value.candidateDigest)
    || !isString(value.validationDigest) || !isString(value.packageDigest)
    || !isString(value.signerKeyId) || !isString(value.signatureBase64) || !isString(value.signedAt)
    || !isString(value.decisionSignatureBase64)
    || (value.status !== "active" && value.status !== "disabled" && value.status !== "rolledBack")) {
    throw new Error(`${label} 结构无效`);
  }
  return value as unknown as SignedWhitelistEntry;
}

function isStatus(value: unknown): value is EvolutionCandidateStatus {
  return typeof value === "string" && [
    "draft", "validating", "validationFailed", "awaitingManualApproval", "promoted", "disabled", "rolledBack",
  ].includes(value);
}
function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function isString(value: unknown): value is string { return typeof value === "string" && value.trim() !== ""; }
function isMissing(error: unknown): boolean { return isRecord(error) && error.code === "ENOENT"; }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
