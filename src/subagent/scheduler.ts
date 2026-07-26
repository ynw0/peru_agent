import type { AgentEvent } from "../agent-protocol.js";
import type { EventJournal } from "../agent/event-journal.js";
import type { IdGenerator } from "../agent/id-generator.js";
import type { DiffManager } from "../diff/diff-manager.js";
import { validateSubagentTaskRequest } from "./policy.js";
import type { SubagentExecutor } from "./executor.js";
import type { SubagentPatchMerger } from "./patch-merger.js";
import type { SubagentTaskStore } from "./task-store.js";
import type {
  SubagentExecutionResult,
  SubagentTaskRecord,
  SubagentTaskRequest,
} from "./types.js";
import type { SnapshotWorktreeManager } from "./worktree-manager.js";

export interface SubagentSchedulerOptions {
  readonly maxConcurrent: number;
  readonly maxConcurrentPerParent: number;
}

export interface SubagentSchedulerListener {
  (event: AgentEvent): void | Promise<void>;
}

export class SubagentScheduler {
  private readonly tasks = new Map<string, SubagentTaskRecord>();
  private readonly queue: string[] = [];
  private readonly controllers = new Map<string, AbortController>();
  private readonly completions = new Map<string, Promise<SubagentTaskRecord>>();
  private readonly completionResolvers = new Map<string, (task: SubagentTaskRecord) => void>();
  private readonly listeners = new Set<SubagentSchedulerListener>();
  private readonly activeByParent = new Map<string, number>();
  private runningCount = 0;

  public constructor(
    private readonly executor: SubagentExecutor,
    private readonly worktrees: SnapshotWorktreeManager,
    private readonly merger: SubagentPatchMerger,
    private readonly diffs: DiffManager,
    private readonly store: SubagentTaskStore,
    private readonly journal: EventJournal,
    private readonly ids: IdGenerator,
    private readonly options: SubagentSchedulerOptions,
  ) {
    if (!Number.isInteger(options.maxConcurrent) || options.maxConcurrent <= 0
      || !Number.isInteger(options.maxConcurrentPerParent) || options.maxConcurrentPerParent <= 0
      || options.maxConcurrentPerParent > options.maxConcurrent) {
      throw new Error("子 Agent 并发配置无效");
    }
  }

  public onEvent(listener: SubagentSchedulerListener): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  public async dispatch(input: SubagentTaskRequest): Promise<SubagentTaskRecord> {
    const request = validateSubagentTaskRequest(input);
    if (request.parentTaskId !== undefined) {
      const parent = this.requireTask(request.parentTaskId);
      if (request.depth !== parent.depth + 1) {
        throw new Error("子 Agent 深度必须严格等于父任务深度加一");
      }
      if (parent.parentSessionId !== request.parentSessionId) {
        throw new Error("父子任务必须属于同一个父会话");
      }
    }
    if (request.targetTaskId !== undefined) {
      const target = this.requireTask(request.targetTaskId);
      if (target.role !== "implementer") {
        throw new Error("Reviewer/Tester 只能审核 Implementer 任务");
      }
      if (target.status !== "completed" || target.worktree === undefined) {
        throw new Error("Reviewer/Tester 只能审核已完成且保留隔离工作区的 Implementer");
      }
      if (target.parentSessionId !== request.parentSessionId) {
        throw new Error("审核任务与目标任务必须属于同一父会话");
      }
      const invalidReviewScope = request.allowedPaths.find(path =>
        !target.allowedPaths.some(scope => path === scope || path.startsWith(`${scope}/`)));
      if (invalidReviewScope !== undefined) {
        throw new Error(`审核路径超出 Implementer 范围：${invalidReviewScope}`);
      }
    }

    const now = new Date().toISOString();
    const task: SubagentTaskRecord = {
      ...request,
      id: this.ids.next("subagent"),
      status: "queued",
      createdAt: now,
      updatedAt: now,
    };
    this.tasks.set(task.id, task);
    await this.store.save(task);
    await this.publish({
      type: "subagent.task.created",
      sessionId: task.parentSessionId,
      taskId: task.id,
      role: task.role,
      depth: task.depth,
    });
    return structuredClone(task);
  }

  public start(taskId: string): Promise<SubagentTaskRecord> {
    const task = this.requireTask(taskId);
    if (task.status !== "queued") {
      throw new Error(`子 Agent 任务状态不允许启动：${task.status}`);
    }
    const completion = this.ensureCompletion(taskId);
    if (this.queue.includes(taskId) || this.controllers.has(taskId)) {
      return completion;
    }
    this.queue.push(taskId);
    this.pump();
    return completion;
  }

  public wait(taskId: string): Promise<SubagentTaskRecord> {
    const task = this.requireTask(taskId);
    if (isTerminal(task.status) || task.status === "patchProposed") {
      return Promise.resolve(structuredClone(task));
    }
    return this.ensureCompletion(taskId);
  }

  public async abort(taskId: string): Promise<boolean> {
    const task = this.requireTask(taskId);
    if (isTerminal(task.status) || task.status === "patchProposed") {
      return false;
    }

    const controller = this.controllers.get(taskId);
    if (controller !== undefined) {
      controller.abort();
      return true;
    }

    if (task.status === "queued") {
      const queueIndex = this.queue.indexOf(taskId);
      if (queueIndex >= 0) {
        this.queue.splice(queueIndex, 1);
      }
      await this.finishTask(taskId, {
        ...task,
        status: "aborted",
        updatedAt: new Date().toISOString(),
        error: { code: "SUBAGENT_ABORTED", message: "子 Agent 在启动前或排队期间被取消" },
      });
      return true;
    }

    throw new Error(`运行中的子 Agent 缺少取消控制器：${taskId}`);
  }

  public async abortParentSession(parentSessionId: string): Promise<number> {
    const active = [...this.tasks.values()].filter(task =>
      task.parentSessionId === parentSessionId
      && (task.status === "queued" || task.status === "running"));
    let aborted = 0;
    for (const task of active) {
      if (await this.abort(task.id)) {
        aborted += 1;
      }
    }
    return aborted;
  }

  public get(taskId: string): SubagentTaskRecord {
    return structuredClone(this.requireTask(taskId));
  }

  public list(parentSessionId?: string): readonly SubagentTaskRecord[] {
    return [...this.tasks.values()]
      .filter(task => parentSessionId === undefined || task.parentSessionId === parentSessionId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map(task => structuredClone(task));
  }

  public async restoreAll(): Promise<readonly SubagentTaskRecord[]> {
    const stored = await this.store.list();
    for (const storedTask of stored) {
      let task = storedTask;
      if (task.status === "queued" || task.status === "running") {
        task = {
          ...task,
          status: "failed",
          updatedAt: new Date().toISOString(),
          error: {
            code: "SUBAGENT_INTERRUPTED_RECOVERED",
            message: "进程退出时子 Agent 尚未完成，已明确标记失败",
          },
        };
        await this.store.save(task);
      } else if (task.worktree !== undefined && (task.status === "completed" || task.status === "patchProposed")) {
        try {
          await this.worktrees.restore(task.worktree);
        } catch (error: unknown) {
          task = {
            ...task,
            status: "failed",
            updatedAt: new Date().toISOString(),
            error: {
              code: "SUBAGENT_WORKTREE_RECOVERY_FAILED",
              message: error instanceof Error ? error.message : "隔离工作区恢复失败",
            },
          };
          await this.store.save(task);
        }
      }
      this.tasks.set(task.id, task);
    }
    return this.list();
  }

  public async proposeMerge(taskId: string, gateTaskIds: readonly string[]): Promise<SubagentTaskRecord> {
    const task = this.requireTask(taskId);
    if (task.role !== "implementer" || task.status !== "completed") {
      throw new Error("只有已完成 Implementer 可以提出合并");
    }
    const roles = new Set<string>();
    for (const gateId of gateTaskIds) {
      const gate = this.requireTask(gateId);
      if ((gate.role !== "reviewer" && gate.role !== "tester") || gate.targetTaskId !== task.id) {
        throw new Error(`无效 Patch 门禁任务：${gateId}`);
      }
      if (gate.status !== "completed" || gate.result?.verdict !== "approved") {
        throw new Error(`Patch 门禁未批准：${gateId}`);
      }
      roles.add(gate.role);
    }
    if (!roles.has("reviewer") || !roles.has("tester")) {
      throw new Error("Patch 合并必须同时通过 Reviewer 和 Tester");
    }

    const proposal = await this.merger.propose(task);
    const updated: SubagentTaskRecord = {
      ...task,
      status: "patchProposed",
      patchProposalId: proposal.id,
      updatedAt: new Date().toISOString(),
    };
    this.tasks.set(task.id, updated);
    await this.store.save(updated);
    await this.publish({
      type: "subagent.patch.proposed",
      sessionId: task.parentSessionId,
      taskId: task.id,
      proposalId: proposal.id,
      gateTaskIds: [...gateTaskIds],
    });
    return structuredClone(updated);
  }

  public async finalizeMerge(taskId: string): Promise<SubagentTaskRecord> {
    const task = this.requireTask(taskId);
    if (task.status !== "patchProposed" || task.patchProposalId === undefined) {
      throw new Error("子 Agent 任务没有待确认 Patch");
    }
    const proposal = this.diffs.get(task.patchProposalId);
    if (proposal?.status !== "accepted") {
      throw new Error("父工作区 Diff 尚未接受");
    }
    const updated: SubagentTaskRecord = {
      ...omitWorktree(task),
      status: "merged",
      updatedAt: new Date().toISOString(),
    };
    this.tasks.set(task.id, updated);
    await this.store.save(updated);
    await this.worktrees.cleanup(task.id);
    await this.publish({
      type: "subagent.task.merged",
      sessionId: task.parentSessionId,
      taskId: task.id,
      proposalId: task.patchProposalId,
    });
    return structuredClone(updated);
  }

  private pump(): void {
    while (this.runningCount < this.options.maxConcurrent) {
      const index = this.queue.findIndex(taskId => {
        const task = this.requireTask(taskId);
        return this.runningForParent(task.parentSessionId) < this.options.maxConcurrentPerParent;
      });
      if (index < 0) {
        return;
      }
      const [taskId] = this.queue.splice(index, 1);
      if (taskId === undefined) {
        return;
      }
      const selected = this.requireTask(taskId);
      const controller = new AbortController();
      this.controllers.set(taskId, controller);
      this.runningCount += 1;
      this.activeByParent.set(
        selected.parentSessionId,
        (this.activeByParent.get(selected.parentSessionId) ?? 0) + 1,
      );
      void this.run(taskId, controller).finally(() => {
        this.runningCount -= 1;
        const next = (this.activeByParent.get(selected.parentSessionId) ?? 1) - 1;
        if (next <= 0) {
          this.activeByParent.delete(selected.parentSessionId);
        } else {
          this.activeByParent.set(selected.parentSessionId, next);
        }
        this.pump();
      });
    }
  }

  private async run(taskId: string, controller: AbortController): Promise<void> {
    const queued = this.requireTask(taskId);
    const timeout = setTimeout(() => controller.abort(), queued.budget.maxDurationMs);
    try {
      const target = queued.targetTaskId === undefined ? undefined : this.requireTask(queued.targetTaskId);
      const executionTask = target?.worktree === undefined
        ? queued
        : { ...queued, baseWorkspaceId: target.worktree.workspaceId };
      const worktree = await this.worktrees.create(executionTask, controller.signal);
      const running: SubagentTaskRecord = {
        ...queued,
        status: "running",
        worktree,
        updatedAt: new Date().toISOString(),
      };
      this.tasks.set(taskId, running);
      await this.store.save(running);
      await this.publish({
        type: "subagent.task.started",
        sessionId: running.parentSessionId,
        taskId,
        workspaceId: worktree.workspaceId,
      });

      if (controller.signal.aborted) {
        throw new Error("子 Agent 在执行前已被取消");
      }
      const result = await this.executor.execute({ task: running, workspaceId: worktree.workspaceId, signal: controller.signal });
      validateUsage(result, running);
      await this.worktrees.collectPatch(worktree);
      if ((running.role === "reviewer" || running.role === "tester") && result.verdict === undefined) {
        throw new Error(`${running.role} 必须返回明确 Verdict`);
      }
      let completed: SubagentTaskRecord = {
        ...running,
        status: "completed",
        result,
        updatedAt: new Date().toISOString(),
      };
      if (completed.role !== "implementer") {
        await this.worktrees.cleanup(taskId);
        completed = omitWorktree(completed);
      }
      await this.finishTask(taskId, completed);
    } catch (error: unknown) {
      const current = this.requireTask(taskId);
      const aborted = controller.signal.aborted;
      await this.worktrees.cleanup(taskId);
      await this.finishTask(taskId, {
        ...omitWorktree(current),
        status: aborted ? "aborted" : "failed",
        updatedAt: new Date().toISOString(),
        error: {
          code: aborted ? "SUBAGENT_ABORTED" : "SUBAGENT_EXECUTION_FAILED",
          message: aborted ? "子 Agent 被取消或超过运行时间" : errorMessage(error),
        },
      });
    } finally {
      clearTimeout(timeout);
      this.controllers.delete(taskId);
    }
  }

  private async finishTask(taskId: string, task: SubagentTaskRecord): Promise<void> {
    this.tasks.set(taskId, task);
    await this.store.save(task);
    await this.publish(task.status === "completed"
      ? {
        type: "subagent.task.completed",
        sessionId: task.parentSessionId,
        taskId,
        role: task.role,
        ...(task.result?.verdict === undefined ? {} : { verdict: task.result.verdict }),
      }
      : task.status === "aborted"
        ? { type: "subagent.task.aborted", sessionId: task.parentSessionId, taskId }
        : {
          type: "subagent.task.failed",
          sessionId: task.parentSessionId,
          taskId,
          code: task.error?.code ?? "SUBAGENT_FAILED",
          message: task.error?.message ?? "子 Agent 失败",
        });
    this.completionResolvers.get(taskId)?.(structuredClone(task));
    this.completionResolvers.delete(taskId);
  }

  private ensureCompletion(taskId: string): Promise<SubagentTaskRecord> {
    const existing = this.completions.get(taskId);
    if (existing !== undefined) {
      return existing;
    }
    const completion = new Promise<SubagentTaskRecord>(resolve => {
      this.completionResolvers.set(taskId, resolve);
    });
    this.completions.set(taskId, completion);
    return completion.finally(() => this.completions.delete(taskId));
  }

  private runningForParent(parentSessionId: string): number {
    return this.activeByParent.get(parentSessionId) ?? 0;
  }

  private requireTask(taskId: string): SubagentTaskRecord {
    const task = this.tasks.get(taskId);
    if (task === undefined) {
      throw new Error(`子 Agent 任务不存在：${taskId}`);
    }
    return task;
  }

  private async publish(event: AgentEvent): Promise<void> {
    await this.journal.append(event);
    for (const listener of this.listeners) {
      await listener(event);
    }
  }
}

function omitWorktree(task: SubagentTaskRecord): SubagentTaskRecord {
  const { worktree: _worktree, ...withoutWorktree } = task;
  return withoutWorktree;
}

function validateUsage(result: SubagentExecutionResult, task: SubagentTaskRecord): void {
  const totalTokens = result.usage.inputTokens + result.usage.outputTokens;
  if (totalTokens > task.budget.maxTotalTokens) {
    throw new Error(`子 Agent Token 用量 ${totalTokens} 超过预算 ${task.budget.maxTotalTokens}`);
  }
  if (result.usage.turns > task.budget.maxTurns) {
    throw new Error(`子 Agent 轮次 ${result.usage.turns} 超过预算 ${task.budget.maxTurns}`);
  }
  if (result.usage.toolCalls > task.budget.maxToolCalls) {
    throw new Error(`子 Agent ToolCall ${result.usage.toolCalls} 超过预算 ${task.budget.maxToolCalls}`);
  }
}

function isTerminal(status: SubagentTaskRecord["status"]): boolean {
  return status === "completed" || status === "failed" || status === "aborted" || status === "merged";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "未知子 Agent 错误";
}
