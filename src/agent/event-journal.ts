import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AgentEvent } from "../agent-protocol.js";

export interface JournalEntry {
  readonly sequence: number;
  readonly recordedAt: string;
  readonly event: AgentEvent;
}

export interface EventJournal {
  append(event: AgentEvent): Promise<JournalEntry>;
  list(sessionId?: string): Promise<readonly JournalEntry[]>;
}

export class InMemoryEventJournal implements EventJournal {
  private readonly entries: JournalEntry[] = [];

  public async append(event: AgentEvent): Promise<JournalEntry> {
    const entry = {
      sequence: this.entries.length + 1,
      recordedAt: new Date().toISOString(),
      event,
    };
    this.entries.push(entry);
    return entry;
  }

  public async list(sessionId?: string): Promise<readonly JournalEntry[]> {
    return this.entries
      .filter(entry => sessionId === undefined || entry.event.sessionId === sessionId)
      .map(entry => ({ ...entry, event: { ...entry.event } }));
  }
}

// JsonlEventJournal 使用单一写队列，确保多个并发会话不会获得重复 sequence。
export class JsonlEventJournal implements EventJournal {
  private nextSequence = 1;
  private initialized = false;
  private operationQueue: Promise<void> = Promise.resolve();

  public constructor(private readonly filePath: string) {}

  public append(event: AgentEvent): Promise<JournalEntry> {
    return this.enqueue(async () => {
      await this.initialize();
      const entry = {
        sequence: this.nextSequence++,
        recordedAt: new Date().toISOString(),
        event,
      };
      await mkdir(dirname(this.filePath), { recursive: true });
      await appendFile(this.filePath, `${JSON.stringify(entry)}\n`, "utf8");
      return entry;
    });
  }

  public async list(sessionId?: string): Promise<readonly JournalEntry[]> {
    await this.operationQueue;
    await this.initialize();
    const entries = await this.readExistingEntries();
    return entries.filter(entry => sessionId === undefined || entry.event.sessionId === sessionId);
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationQueue.then(operation, operation);
    this.operationQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  private async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }
    const entries = await this.readExistingEntries();
    this.nextSequence = (entries.at(-1)?.sequence ?? 0) + 1;
    this.initialized = true;
  }

  private async readExistingEntries(): Promise<readonly JournalEntry[]> {
    let content: string;
    try {
      content = await readFile(this.filePath, "utf8");
    } catch (error: unknown) {
      if (isMissingFileError(error)) {
        return [];
      }
      throw error;
    }

    const result: JournalEntry[] = [];
    for (const [lineIndex, line] of content.split(/\r?\n/).entries()) {
      if (line.trim() === "") {
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (error: unknown) {
        const reason = error instanceof Error ? error.message : "未知 JSON 错误";
        throw new Error(`事件日志第 ${lineIndex + 1} 行损坏：${reason}`);
      }
      result.push(validateJournalEntry(parsed));
    }
    return result;
  }
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && (error as { code?: unknown }).code === "ENOENT";
}

function validateJournalEntry(value: unknown): JournalEntry {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("事件日志条目必须是对象");
  }
  const record = value as Record<string, unknown>;
  if (!Number.isInteger(record.sequence) || Number(record.sequence) <= 0
    || typeof record.recordedAt !== "string"
    || typeof record.event !== "object" || record.event === null) {
    throw new Error("事件日志条目结构无效");
  }
  return value as JournalEntry;
}

export function getWorkspaceJournalPath(dataDirectory: string, workspaceId: string): string {
  const safeWorkspaceId = workspaceId.replace(/[^A-Za-z0-9._-]/g, "_");
  return join(dataDirectory, "journals", `${safeWorkspaceId}.jsonl`);
}
