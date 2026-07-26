import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Capability } from "../agent-protocol.js";
import type { WorkspaceFileSnapshot } from "../workspace/types.js";
import { validateSubagentTaskRequest } from "./policy.js";
import type {
  SubagentExecutionResult,
  SubagentRole,
  SubagentTaskRecord,
  SubagentTaskStatus,
  SubagentWorktreeSnapshot,
} from "./types.js";

export interface SubagentTaskStore {
  save(task: SubagentTaskRecord): Promise<void>;
  load(id: string): Promise<SubagentTaskRecord | undefined>;
  list(): Promise<readonly SubagentTaskRecord[]>;
}

export class InMemorySubagentTaskStore implements SubagentTaskStore {
  private readonly tasks = new Map<string, SubagentTaskRecord>();

  public async save(task: SubagentTaskRecord): Promise<void> {
    this.tasks.set(task.id, structuredClone(task));
  }

  public async load(id: string): Promise<SubagentTaskRecord | undefined> {
    const task = this.tasks.get(id);
    return task === undefined ? undefined : structuredClone(task);
  }

  public async list(): Promise<readonly SubagentTaskRecord[]> {
    return [...this.tasks.values()].map(task => structuredClone(task));
  }
}

export class JsonSubagentTaskStore implements SubagentTaskStore {
  private mutationQueue: Promise<void> = Promise.resolve();

  public constructor(private readonly filePath: string) {}

  public save(task: SubagentTaskRecord): Promise<void> {
    return this.enqueue(async () => {
      const tasks = await this.readAll();
      tasks.set(task.id, structuredClone(task));
      await this.writeAll(tasks);
    });
  }

  public async load(id: string): Promise<SubagentTaskRecord | undefined> {
    await this.mutationQueue;
    const task = (await this.readAll()).get(id);
    return task === undefined ? undefined : structuredClone(task);
  }

  public async list(): Promise<readonly SubagentTaskRecord[]> {
    await this.mutationQueue;
    return [...(await this.readAll()).values()].map(task => structuredClone(task));
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationQueue.then(operation, operation);
    this.mutationQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  private async readAll(): Promise<Map<string, SubagentTaskRecord>> {
    let content: string;
    try {
      content = await readFile(this.filePath, "utf8");
    } catch (error: unknown) {
      if (isMissing(error)) {
        return new Map();
      }
      throw error;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch (error: unknown) {
      throw new Error(`子 Agent 任务存储 JSON 损坏：${errorMessage(error)}`);
    }
    if (!Array.isArray(parsed)) {
      throw new Error("子 Agent 任务存储必须是数组");
    }

    const result = new Map<string, SubagentTaskRecord>();
    for (const [index, value] of parsed.entries()) {
      let task: SubagentTaskRecord;
      try {
        task = validateTask(value);
      } catch (error: unknown) {
        throw new Error(`子 Agent 任务存储第 ${index + 1} 项无效：${errorMessage(error)}`);
      }
      if (result.has(task.id)) {
        throw new Error(`子 Agent 任务存储包含重复 ID：${task.id}`);
      }
      result.set(task.id, task);
    }
    return result;
  }

  private async writeAll(tasks: Map<string, SubagentTaskRecord>): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${Date.now()}.tmp`;
    await writeFile(temporary, `${JSON.stringify([...tasks.values()], null, 2)}\n`, "utf8");
    await rename(temporary, this.filePath);
  }
}

function validateTask(value: unknown): SubagentTaskRecord {
  const record = requireRecord(value, "任务");
  const id = requireString(record.id, "id");
  const role = requireRole(record.role);
  const status = requireStatus(record.status);
  const request = validateSubagentTaskRequest({
    parentSessionId: requireString(record.parentSessionId, "parentSessionId"),
    ...(record.parentTaskId === undefined
      ? {}
      : { parentTaskId: requireString(record.parentTaskId, "parentTaskId") }),
    role,
    instruction: requireString(record.instruction, "instruction"),
    depth: requirePositiveInteger(record.depth, "depth"),
    baseWorkspaceId: requireString(record.baseWorkspaceId, "baseWorkspaceId"),
    allowedPaths: requireStringArray(record.allowedPaths, "allowedPaths"),
    writablePaths: requireStringArray(record.writablePaths, "writablePaths"),
    allowedCapabilities: requireStringArray(record.allowedCapabilities, "allowedCapabilities") as Capability[],
    budget: validateBudget(record.budget),
    ...(record.targetTaskId === undefined
      ? {}
      : { targetTaskId: requireString(record.targetTaskId, "targetTaskId") }),
  });
  const worktree = record.worktree === undefined ? undefined : validateWorktree(record.worktree, id);
  const result = record.result === undefined ? undefined : validateResult(record.result);
  const patchProposalId = record.patchProposalId === undefined
    ? undefined
    : requireString(record.patchProposalId, "patchProposalId");
  const error = record.error === undefined ? undefined : validateError(record.error);

  if ((status === "completed" || status === "patchProposed" || status === "merged") && result === undefined) {
    throw new Error(`${status} 任务必须包含执行结果`);
  }
  if ((status === "patchProposed" || status === "merged") && patchProposalId === undefined) {
    throw new Error(`${status} 任务必须包含 Patch Proposal ID`);
  }
  if (role === "implementer" && (status === "completed" || status === "patchProposed")
    && worktree === undefined) {
    throw new Error(`${status} Implementer 必须保留隔离工作树`);
  }
  if (status === "merged" && worktree !== undefined) {
    throw new Error("merged 任务不得保留已清理的隔离工作树引用");
  }
  if ((status === "failed" || status === "aborted") && error === undefined) {
    throw new Error(`${status} 任务必须包含错误原因`);
  }
  if (worktree !== undefined && worktree.baseWorkspaceId !== request.baseWorkspaceId
    && request.targetTaskId === undefined) {
    throw new Error("非审核任务的隔离工作树基础工作区不匹配");
  }

  return {
    ...request,
    id,
    status,
    createdAt: requireString(record.createdAt, "createdAt"),
    updatedAt: requireString(record.updatedAt, "updatedAt"),
    ...(worktree === undefined ? {} : { worktree }),
    ...(result === undefined ? {} : { result }),
    ...(patchProposalId === undefined ? {} : { patchProposalId }),
    ...(error === undefined ? {} : { error }),
  };
}

function validateWorktree(value: unknown, taskId: string): SubagentWorktreeSnapshot {
  const record = requireRecord(value, "worktree");
  const snapshots = Array.isArray(record.baseFiles)
    ? record.baseFiles.map((item, index) => validateFileSnapshot(item, `baseFiles[${index}]`))
    : (() => { throw new Error("baseFiles 必须是数组"); })();
  const snapshot: SubagentWorktreeSnapshot = {
    id: requireString(record.id, "worktree.id"),
    taskId: requireString(record.taskId, "worktree.taskId"),
    baseWorkspaceId: requireString(record.baseWorkspaceId, "worktree.baseWorkspaceId"),
    workspaceId: requireString(record.workspaceId, "worktree.workspaceId"),
    root: requireString(record.root, "worktree.root"),
    allowedPaths: requireStringArray(record.allowedPaths, "worktree.allowedPaths"),
    writablePaths: requireStringArray(record.writablePaths, "worktree.writablePaths"),
    baseFiles: snapshots,
    createdAt: requireString(record.createdAt, "worktree.createdAt"),
  };
  if (snapshot.taskId !== taskId || snapshot.id !== `worktree:${taskId}`
    || snapshot.workspaceId !== `subagent:${taskId}`) {
    throw new Error("worktree 标识与任务 ID 不匹配");
  }
  return snapshot;
}

function validateFileSnapshot(value: unknown, label: string): WorkspaceFileSnapshot {
  const record = requireRecord(value, label);
  const exists = requireBoolean(record.exists, `${label}.exists`);
  const content = record.content === null ? null : requireString(record.content, `${label}.content`, true);
  const sha256 = record.sha256 === null ? null : requireSha256(record.sha256, `${label}.sha256`);
  const byteLength = requireNonNegativeInteger(record.byteLength, `${label}.byteLength`);
  if (exists !== (content !== null && sha256 !== null)) {
    throw new Error(`${label} 的 exists、content 和 sha256 不一致`);
  }
  return {
    path: requireString(record.path, `${label}.path`),
    exists,
    content,
    sha256,
    byteLength,
  };
}

function validateResult(value: unknown): SubagentExecutionResult {
  const record = requireRecord(value, "result");
  const usage = requireRecord(record.usage, "result.usage");
  const verdict = record.verdict;
  if (verdict !== undefined && verdict !== "approved" && verdict !== "rejected") {
    throw new Error("result.verdict 无效");
  }
  return {
    summary: requireString(record.summary, "result.summary", true),
    usage: {
      inputTokens: requireNonNegativeInteger(usage.inputTokens, "result.usage.inputTokens"),
      outputTokens: requireNonNegativeInteger(usage.outputTokens, "result.usage.outputTokens"),
      turns: requireNonNegativeInteger(usage.turns, "result.usage.turns"),
      toolCalls: requireNonNegativeInteger(usage.toolCalls, "result.usage.toolCalls"),
    },
    ...(record.childSessionId === undefined
      ? {}
      : { childSessionId: requireString(record.childSessionId, "result.childSessionId") }),
    ...(verdict === undefined ? {} : { verdict }),
  };
}

function validateBudget(value: unknown): SubagentTaskRecord["budget"] {
  const record = requireRecord(value, "budget");
  return {
    maxTurns: requirePositiveInteger(record.maxTurns, "budget.maxTurns"),
    maxToolCalls: requirePositiveInteger(record.maxToolCalls, "budget.maxToolCalls"),
    maxTotalTokens: requirePositiveInteger(record.maxTotalTokens, "budget.maxTotalTokens"),
    maxDurationMs: requirePositiveInteger(record.maxDurationMs, "budget.maxDurationMs"),
  };
}

function validateError(value: unknown): { readonly code: string; readonly message: string } {
  const record = requireRecord(value, "error");
  return {
    code: requireString(record.code, "error.code"),
    message: requireString(record.message, "error.message"),
  };
}

function requireRole(value: unknown): SubagentRole {
  if (value === "planner" || value === "explorer" || value === "implementer"
    || value === "reviewer" || value === "tester") {
    return value;
  }
  throw new Error("role 无效");
}

function requireStatus(value: unknown): SubagentTaskStatus {
  if (value === "queued" || value === "running" || value === "completed"
    || value === "failed" || value === "aborted" || value === "patchProposed" || value === "merged") {
    return value;
  }
  throw new Error("status 无效");
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} 必须是对象`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, label: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value.trim() === "")) {
    throw new Error(`${label} 必须是${allowEmpty ? "" : "非空"}字符串`);
  }
  return value;
}

function requireStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || !value.every(item => typeof item === "string")) {
    throw new Error(`${label} 必须是字符串数组`);
  }
  return [...value];
}

function requirePositiveInteger(value: unknown, label: string): number {
  if (!Number.isInteger(value) || Number(value) <= 0) {
    throw new Error(`${label} 必须是正整数`);
  }
  return Number(value);
}

function requireNonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isInteger(value) || Number(value) < 0) {
    throw new Error(`${label} 必须是非负整数`);
  }
  return Number(value);
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${label} 必须是布尔值`);
  }
  return value;
}

function requireSha256(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw new Error(`${label} 必须是 SHA-256`);
  }
  return value;
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error
    && (error as { readonly code?: unknown }).code === "ENOENT";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "未知错误";
}
