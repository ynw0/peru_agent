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
import type { PlanManager } from "../plan/plan-manager.js";
import type { SubagentCommitStore } from "./commit-store.js";
import { createSubagentCommit } from "./commit-store.js";
import { sha256Text } from "../workspace/workspace-service.js";

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
  private readonly stableCompletions = new Map<string, Promise<SubagentTaskRecord>>();
  private readonly stableResolvers = new Map<string, (task: SubagentTaskRecord) => void>();
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
    private readonly plans?: PlanManager,
    private readonly commits?: SubagentCommitStore,
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
    if (request.role === "implementer") {
      if (this.plans === undefined) {
        // 纯调度器单元测试/嵌入场景可不启用 Plan；TUI 组合根始终传入 PlanManager 并执行绑定校验。
      } else if (request.planId === undefined || request.planStepId === undefined) throw new Error("Implementer 必须绑定当前会话的 Plan 步骤");
      if (this.plans !== undefined && request.planId !== undefined && request.planStepId !== undefined) {
      const plan = this.plans.get(request.planId);
      const step = plan?.steps.find(item => item.id === request.planStepId);
      if (plan === undefined || step === undefined || plan.sessionId !== request.parentSessionId) throw new Error("Implementer 的 Plan 或步骤不存在，或不属于当前会话");
      if (plan.status !== "approved" && plan.status !== "executing") throw new Error("Plan 尚未通过审核");
      if (step.affectedFiles.length > 0 && request.allowedPaths.some(path => !step.affectedFiles.some(scope => path === scope || path.startsWith(`${scope}/`)))) throw new Error("Implementer 路径超出 Plan 步骤范围");
      if (request.allowedCapabilities.some(capability => !step.capabilities.includes(capability))) throw new Error("Implementer 能力超出 Plan 步骤范围");
      }
    }
    if (request.parentTaskId !== undefined) {
      const parent = this.requireTask(request.parentTaskId);
      if (request.depth !== parent.depth + 1) {
        throw new Error("子 Agent 深度必须严格等于父任务深度加一");
      }
      if (parent.parentSessionId !== request.parentSessionId) {
        throw new Error("父子任务必须属于同一个父会话");
      }
    }
    if (request.repairOfTaskId !== undefined) {
      const source = this.requireTask(request.repairOfTaskId);
      if (source.role !== "implementer" || source.outputCommitId === undefined || source.planId !== request.planId || source.planStepId !== request.planStepId) throw new Error("Repair Task 必须绑定同一 Implementer Commit 和 Plan Step");
      if (source.rejectionCount >= 2) throw new Error("同一 Plan Step 的门禁拒绝次数已达到上限");
    }
    if (request.targetTaskId !== undefined) {
      const target = this.requireTask(request.targetTaskId);
      if (target.role !== "implementer") {
        throw new Error("Reviewer/Tester 只能审核 Implementer 任务");
      }
      if ((target.status !== "completed" && target.status !== "gating") || target.worktree === undefined) {
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
      attemptId: this.ids.next("attempt"),
      rejectionCount: request.repairOfTaskId === undefined ? 0 : this.requireTask(request.repairOfTaskId).rejectionCount + 1,
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
      ...(task.planId === undefined ? {} : { planId: task.planId }),
      ...(task.planStepId === undefined ? {} : { planStepId: task.planStepId }),
      attemptId: task.attemptId,
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
    return this.waitStable(taskId);
  }

  /** 等待编排稳定边界；Implementer 不会在 parent Diff 接受前继续阻塞。 */
  public waitStable(taskId: string): Promise<SubagentTaskRecord> {
    const task = this.requireTask(taskId);
    if (isStableBoundary(task, this.commits !== undefined)) return Promise.resolve(structuredClone(task));
    const existing = this.stableCompletions.get(taskId);
    if (existing !== undefined) return existing;
    const completion = new Promise<SubagentTaskRecord>(resolve => this.stableResolvers.set(taskId, resolve))
      .finally(() => this.stableCompletions.delete(taskId));
    this.stableCompletions.set(taskId, completion);
    return completion;
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
        const interruptedStatus: "interrupted" | "gateInterrupted" = task.role === "reviewer" || task.role === "tester" ? "gateInterrupted" : "interrupted";
        const interruptionError = {
          code: interruptedStatus === "gateInterrupted" ? "SUBAGENT_GATE_INTERRUPTED" : "SUBAGENT_INTERRUPTED_RECOVERED",
          message: interruptedStatus === "gateInterrupted" ? "进程退出时门禁尚未完成，等待人工重新运行" : "进程退出时子 Agent 尚未完成，未自动重跑",
        };
        task = {
          ...task,
          status: interruptedStatus,
          updatedAt: new Date().toISOString(),
          stableReason: interruptedStatus,
          error: interruptionError,
        };
        if (task.worktree !== undefined) {
          try {
            await this.worktrees.restore(task.worktree);
            await this.worktrees.cleanup(task.id);
            task = omitWorktree(task);
          } catch {
            // 恢复进程不重新执行任务；隔离目录清理失败由持久化错误保留，避免覆盖中断原因。
          }
        }
        await this.store.save(task);
        await this.publish({
          type: "subagent.task.interrupted",
          sessionId: task.parentSessionId,
          taskId: task.id,
          status: interruptedStatus,
          code: interruptionError.code,
          message: interruptionError.message,
        });
      } else if (task.worktree !== undefined && (task.status === "completed" || task.status === "gating" || task.status === "patchProposed")) {
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
    if (task.role !== "implementer" || (task.status !== "completed" && task.status !== "gating")) {
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
    const policy = task.reviewPolicy;
    if (policy === "reviewer" && !roles.has("reviewer")) throw new Error("Patch 缺少 Reviewer 门禁");
    if (policy === "reviewerAndTester" && (!roles.has("reviewer") || !roles.has("tester"))) throw new Error("Patch 必须同时通过 Reviewer 和 Tester");

    const immutableCommit = task.outputCommitId === undefined ? undefined : await this.commits?.get(task.outputCommitId);
    if (task.outputCommitId !== undefined && immutableCommit === undefined) throw new Error(`Commit 不存在：${task.outputCommitId}`);
    const proposal = await this.merger.propose(task, immutableCommit);
    const updated: SubagentTaskRecord = {
      ...task,
      status: "patchProposed",
      stableReason: "patchProposed",
      patchProposalId: proposal.id,
      updatedAt: new Date().toISOString(),
    };
    this.tasks.set(task.id, updated);
    await this.store.save(updated);
    this.resolveStable(updated);
    await this.publish({
      type: "subagent.patch.proposed",
      sessionId: task.parentSessionId,
      taskId: task.id,
      proposalId: proposal.id,
      gateTaskIds: [...gateTaskIds],
    });
    return structuredClone(updated);
  }

  public async markNoChanges(taskId: string): Promise<SubagentTaskRecord> {
    const task = this.requireTask(taskId);
    if (task.role !== "implementer" || task.status !== "completed") throw new Error("只有已完成 Implementer 可以标记无变化");
    const updated = { ...omitWorktree(task), status: "noChanges" as const, stableReason: "noChanges" as const, updatedAt: new Date().toISOString() };
    this.tasks.set(taskId, updated); await this.store.save(updated); await this.worktrees.cleanup(taskId);
    await this.publish({ type: "subagent.task.status", sessionId: task.parentSessionId, taskId, status: "noChanges" });
    this.resolveStable(updated);
    return structuredClone(updated);
  }

  public async markGating(taskId: string, gateTaskIds: readonly string[]): Promise<SubagentTaskRecord> {
    const task = this.requireTask(taskId);
    const { stableReason: _stableReason, ...withoutStableReason } = task;
    const updated = { ...withoutStableReason, status: "gating" as const, gateTaskIds: [...gateTaskIds], updatedAt: new Date().toISOString() } as SubagentTaskRecord;
    this.tasks.set(taskId, updated); await this.store.save(updated);
    await this.publish({ type: "subagent.task.status", sessionId: task.parentSessionId, taskId, status: "gating", gateTaskIds: [...gateTaskIds] });
    return structuredClone(updated);
  }

  public async markPatchRejected(taskId: string, message: string): Promise<SubagentTaskRecord> {
    const task = this.requireTask(taskId);
    const updated = { ...omitWorktree(task), status: "patchRejected" as const, stableReason: "patchRejected" as const, updatedAt: new Date().toISOString(), error: { code: "SUBAGENT_PATCH_REJECTED", message } };
    this.tasks.set(taskId, updated); await this.store.save(updated); await this.worktrees.cleanup(taskId);
    await this.publish({ type: "subagent.task.status", sessionId: task.parentSessionId, taskId, status: "patchRejected", message });
    this.resolveStable(updated);
    return structuredClone(updated);
  }

  public async recordGateAttempt(targetTaskId: string, gate: SubagentTaskRecord): Promise<SubagentTaskRecord> {
    const target = this.requireTask(targetTaskId);
    if (gate.role !== "reviewer" && gate.role !== "tester") throw new Error("只有 Reviewer/Tester 可以记录门禁 Attempt");
    const report = gate.result?.gateReport;
    const attempt = {
      taskId: gate.id,
      role: gate.role,
      status: report === undefined
        ? (gate.status === "gateInterrupted" ? "interrupted" as const : "failed" as const)
        : report.verdict === "rejected" ? "rejected" as const : "completed" as const,
      ...(report === undefined ? {} : { report }),
      updatedAt: gate.updatedAt,
    };
    const updated = { ...target, gateAttempts: [...(target.gateAttempts ?? []).filter(item => item.taskId !== gate.id), attempt], updatedAt: new Date().toISOString() };
    this.tasks.set(targetTaskId, updated); await this.store.save(updated);
    await this.publish({
      type: "subagent.gate.attempt",
      sessionId: target.parentSessionId,
      taskId: gate.id,
      targetTaskId,
      role: gate.role,
      status: report === undefined ? (gate.status === "gateInterrupted" ? "interrupted" : "failed") : attempt.status === "completed" ? "approved" : "rejected",
      ...(report?.summary === undefined ? {} : { summary: report.summary }),
    });
    return structuredClone(updated);
  }

  public async retryGateAttempt(taskId: string): Promise<SubagentTaskRecord> {
    const task = this.requireTask(taskId);
    if ((task.role !== "reviewer" && task.role !== "tester") || (task.status !== "failed" && task.status !== "aborted" && task.status !== "gateInterrupted")) throw new Error("当前任务不是可重试的门禁 Attempt");
    const target = task.targetTaskId === undefined ? undefined : this.requireTask(task.targetTaskId);
    if (target === undefined || (target.status !== "completed" && target.status !== "gating") || target.worktree === undefined) throw new Error("目标 Implementer 版本不可用");
    const replacement = await this.dispatch({
      parentSessionId: task.parentSessionId,
      role: task.role,
      instruction: task.instruction,
      depth: task.depth,
      baseWorkspaceId: task.baseWorkspaceId,
      allowedPaths: task.allowedPaths,
      writablePaths: task.writablePaths,
      allowedCapabilities: task.allowedCapabilities,
      budget: task.budget,
      reviewPolicy: task.reviewPolicy,
      targetTaskId: target.id,
      ...(task.planId === undefined ? {} : { planId: task.planId }),
      ...(task.planStepId === undefined ? {} : { planStepId: task.planStepId }),
    });
    const updatedTarget = {
      ...target,
      gateTaskIds: (target.gateTaskIds ?? []).map(id => id === task.id ? replacement.id : id),
      updatedAt: new Date().toISOString(),
    };
    this.tasks.set(target.id, updatedTarget);
    await this.store.save(updatedTarget);
    void this.start(replacement.id);
    return structuredClone(replacement);
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
      stableReason: "merged",
      updatedAt: new Date().toISOString(),
    };
    this.tasks.set(task.id, updated);
    await this.store.save(updated);
    await this.worktrees.cleanup(task.id);
    this.resolveStable(updated);
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
      const sourceCommit = queued.sourceCommitId === undefined ? undefined : await this.commits?.get(queued.sourceCommitId);
      if (queued.sourceCommitId !== undefined && sourceCommit === undefined) throw new Error(`Repair Commit 不存在：${queued.sourceCommitId}`);
      const worktree = await this.worktrees.create(executionTask, controller.signal, sourceCommit);
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
      const changes = await this.worktrees.collectPatch(worktree);
      if ((running.role === "reviewer" || running.role === "tester") && result.verdict === undefined) {
        throw new Error(`${running.role} 必须返回明确 Verdict`);
      }
      let completed: SubagentTaskRecord = {
        ...running,
        status: "completed",
        stableReason: "completed",
        result,
        updatedAt: new Date().toISOString(),
      };
      if (running.role === "implementer" && this.commits !== undefined) {
        const commit = createSubagentCommit({
          taskId: running.id,
          parentSessionId: running.parentSessionId,
          baseWorkspaceId: running.baseWorkspaceId,
          ...(running.planId === undefined ? {} : { planId: running.planId }),
          ...(running.planStepId === undefined ? {} : { planStepId: running.planStepId }),
          files: changes.map(change => ({
            path: change.path,
            before: change.before,
            after: {
              ...change.before,
              exists: true,
              content: change.afterContent,
              sha256: sha256Text(change.afterContent),
              byteLength: Buffer.byteLength(change.afterContent, "utf8"),
            },
          })),
          createdAt: new Date().toISOString(),
        });
        await this.commits.save(commit);
        completed = { ...completed, outputCommitId: commit.id };
      }
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
        stableReason: aborted ? "aborted" : "failed",
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
        ...(task.outputCommitId === undefined ? {} : { outputCommitId: task.outputCommitId }),
        ...(task.stableReason === undefined ? {} : { stableReason: task.stableReason }),
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
    if (task.role !== "implementer" || this.commits === undefined || task.status !== "completed") this.resolveStable(task);
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

  private resolveStable(task: SubagentTaskRecord): void {
    this.stableResolvers.get(task.id)?.(structuredClone(task));
    this.stableResolvers.delete(task.id);
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

function isStableBoundary(task: SubagentTaskRecord, orchestrationEnabled: boolean): boolean {
  if (task.role !== "implementer") return ["completed", "failed", "aborted", "interrupted", "gateInterrupted"].includes(task.status);
  if (!orchestrationEnabled && task.status === "completed") return true;
  return ["noChanges", "patchProposed", "patchRejected", "failed", "interrupted", "aborted"].includes(task.status);
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
  return status === "completed" || status === "failed" || status === "aborted" || status === "merged" || status === "noChanges" || status === "patchRejected" || status === "interrupted" || status === "gateInterrupted";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "未知子 Agent 错误";
}
