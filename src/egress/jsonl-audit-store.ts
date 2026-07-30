import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { EgressAuditEntry, EgressAuditStore } from "./types.js";

// 生产 Egress 审计只记录 Broker 已脱敏的 URL，不保存查询参数、凭据或响应正文。
export class JsonlEgressAuditStore implements EgressAuditStore {
  private queue: Promise<void> = Promise.resolve();

  public constructor(private readonly filePath: string) {
    if (filePath.trim() === "") throw new Error("Egress 审计路径不能为空");
  }

  public append(entry: EgressAuditEntry): Promise<void> {
    return this.enqueue(async () => {
      await mkdir(dirname(this.filePath), { recursive: true });
      await appendFile(this.filePath, `${JSON.stringify(entry)}\n`, "utf8");
    });
  }

  public async list(): Promise<readonly EgressAuditEntry[]> {
    await this.queue;
    let content: string;
    try {
      content = await readFile(this.filePath, "utf8");
    } catch (error: unknown) {
      if (isMissing(error)) return [];
      throw error;
    }
    const result: EgressAuditEntry[] = [];
    for (const [index, line] of content.split(/\r?\n/).entries()) {
      if (line.trim() === "") continue;
      let value: unknown;
      try { value = JSON.parse(line); } catch (error: unknown) {
        throw new Error(`Egress 审计第 ${index + 1} 行损坏：${error instanceof Error ? error.message : "JSON 无效"}`);
      }
      if (!isRecord(value) || typeof value.id !== "string" || typeof value.timestamp !== "string") {
        throw new Error(`Egress 审计第 ${index + 1} 行结构无效`);
      }
      result.push(value as unknown as EgressAuditEntry);
    }
    return result.map(entry => structuredClone(entry));
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }
}

function isMissing(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
