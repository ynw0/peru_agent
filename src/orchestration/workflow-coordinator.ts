import type { AgentEvent } from "../agent-protocol.js";
import type { DiffManager } from "../diff/diff-manager.js";
import type { PlanManager } from "../plan/plan-manager.js";
import type { SubagentScheduler } from "../subagent/scheduler.js";
import type { SubagentTaskRecord } from "../subagent/types.js";
import type { SnapshotWorktreeManager } from "../subagent/worktree-manager.js";
import type { SubagentCommitStore } from "../subagent/commit-store.js";

export class SubagentWorkflowCoordinator {
  private readonly startedGates = new Set<string>();
  private readonly disposables: { dispose(): void }[] = [];

  public constructor(private readonly scheduler: SubagentScheduler, private readonly plans: PlanManager, private readonly diffs: DiffManager, private readonly worktrees: SnapshotWorktreeManager, private readonly commits: SubagentCommitStore) {
    this.disposables.push(scheduler.onEvent(event => this.handle(event)), diffs.onEvent(event => this.handle(event)));
  }

  public dispose(): void { for (const item of this.disposables.splice(0)) item.dispose(); }

  private async handle(event: AgentEvent): Promise<void> {
    if (event.type === "subagent.task.created" && event.role === "implementer") {
      const task = this.scheduler.get(event.taskId);
      if (task.planId !== undefined) await this.plans.markExecuting(task.planId).catch(() => undefined);
    }
    if (event.type === "subagent.task.completed") {
      const task = this.scheduler.get(event.taskId);
      if (task.role === "implementer" && task.status === "completed" && !this.startedGates.has(task.id)) await this.startPipeline(task);
      if (task.role === "reviewer" || task.role === "tester") await this.tryMerge(task);
      if ((task.role === "planner" || task.role === "explorer") && task.planId !== undefined) await this.tryCompletePlan(task.planId);
    }
    if (event.type === "subagent.task.failed" || event.type === "subagent.task.aborted" || event.type === "subagent.task.interrupted") {
      const task = this.scheduler.get(event.taskId);
      if (task.role === "reviewer" || task.role === "tester") await this.markGateInterrupted(task);
    }
    if (event.type === "subagent.task.merged") {
      const task = this.scheduler.get(event.taskId); if (task.planId !== undefined) await this.tryCompletePlan(task.planId);
    }
    if (event.type === "diff.resolved") {
      const task = this.scheduler.list().find(item => item.patchProposalId === event.proposalId);
      if (task !== undefined) {
        if (event.decision === "accepted") await this.scheduler.finalizeMerge(task.id).catch(() => undefined);
        else await this.scheduler.markPatchRejected(task.id, "父工作区 Diff 未接受").catch(() => undefined);
      }
    }
  }

  private async startPipeline(task: SubagentTaskRecord): Promise<void> {
    this.startedGates.add(task.id);
    const policy = task.reviewPolicy;
    const commit = task.outputCommitId === undefined ? undefined : await this.commits.get(task.outputCommitId);
    if (commit === undefined || commit.files.length === 0) { await this.scheduler.markNoChanges(task.id); if (task.planId !== undefined) await this.tryCompletePlan(task.planId); return; }
    if (policy === "none") { await this.scheduler.proposeMerge(task.id, []); return; }
    const gateIds: string[] = [];
    if (policy === "reviewer" || policy === "reviewerAndTester") {
      const reviewer = await this.scheduler.dispatch({ parentSessionId: task.parentSessionId, role: "reviewer", instruction: "审查目标 Implementer 的隔离修改，返回 APPROVED 或 REJECTED。", depth: task.depth + 1, baseWorkspaceId: task.baseWorkspaceId, allowedPaths: task.allowedPaths, writablePaths: [], allowedCapabilities: ["workspace.read"], budget: gateBudget(), reviewPolicy: "none", targetTaskId: task.id, ...(task.planId === undefined ? {} : { planId: task.planId }), ...(task.planStepId === undefined ? {} : { planStepId: task.planStepId }) });
      gateIds.push(reviewer.id);
    }
    if (policy === "reviewerAndTester") {
      const tester = await this.scheduler.dispatch({ parentSessionId: task.parentSessionId, role: "tester", instruction: "在隔离工作区执行必要测试并返回 APPROVED 或 REJECTED。", depth: task.depth + 1, baseWorkspaceId: task.baseWorkspaceId, allowedPaths: task.allowedPaths, writablePaths: [], allowedCapabilities: ["workspace.read", "process.execute"], budget: gateBudget(), reviewPolicy: "none", targetTaskId: task.id });
      gateIds.push(tester.id);
    }
    await this.scheduler.markGating(task.id, gateIds);
    for (const gateId of gateIds) void this.scheduler.start(gateId);
  }

  private async tryMerge(gate: SubagentTaskRecord): Promise<void> {
    const target = this.scheduler.list().find(item => item.gateTaskIds?.includes(gate.id));
    if (target === undefined || target.status !== "gating" || target.gateTaskIds === undefined) return;
    await this.scheduler.recordGateAttempt(target.id, gate);
    const gates = target.gateTaskIds.map(id => this.scheduler.get(id));
    if (gates.some(item => !["completed", "failed", "aborted"].includes(item.status))) return;
    if (gates.some(item => item.status !== "completed" || item.result?.gateReport === undefined)) return;
    const rejected = gates.filter(item => item.result?.gateReport?.verdict === "rejected");
    if (rejected.length > 0) { await this.rejectAndRepair(target, gates); return; }
    await this.scheduler.proposeMerge(target.id, target.gateTaskIds);
  }

  private async markGateInterrupted(gate: SubagentTaskRecord): Promise<void> {
    const target = this.scheduler.list().find(item => item.gateTaskIds?.includes(gate.id));
    if (target === undefined) return;
    await this.scheduler.recordGateAttempt(target.id, gate).catch(() => undefined);
  }

  private async rejectAndRepair(target: SubagentTaskRecord, gates: readonly SubagentTaskRecord[]): Promise<void> {
    await this.scheduler.markPatchRejected(target.id, "门禁拒绝：" + gates.flatMap(item => item.result?.gateReport?.issues ?? []).join("；"));
    if (target.rejectionCount >= 2 || target.outputCommitId === undefined || target.planId === undefined || target.planStepId === undefined) return;
    const reports = gates.map(item => `${item.role}: ${item.result?.gateReport?.summary ?? ""}\n问题：${(item.result?.gateReport?.issues ?? []).join("；")}`).join("\n");
    await this.scheduler.dispatch({
      parentSessionId: target.parentSessionId,
      role: "implementer",
      instruction: `基于上一版本继续修复。门禁意见：\n${reports}`,
      depth: target.depth,
      baseWorkspaceId: target.baseWorkspaceId,
      allowedPaths: target.allowedPaths,
      writablePaths: target.writablePaths,
      allowedCapabilities: target.allowedCapabilities,
      budget: target.budget,
      reviewPolicy: target.reviewPolicy,
      planId: target.planId,
      planStepId: target.planStepId,
      sourceCommitId: target.outputCommitId,
      repairOfTaskId: target.id,
    });
  }

  private async tryCompletePlan(planId: string): Promise<void> {
    const plan = this.plans.get(planId); if (plan === undefined || plan.status !== "executing") return;
    const tasks = this.scheduler.list(plan.sessionId).filter(item => item.planId === planId && item.planStepId !== undefined);
    if (tasks.some(item => item.status === "queued" || item.status === "running" || item.status === "gating" || item.status === "patchProposed")) return;
    const covered = plan.steps.every(step => {
      const linked = tasks.filter(item => item.planStepId === step.id);
      if (linked.length === 0) return false;
      const write = step.capabilities.includes("workspace.write") || step.capabilities.includes("workspace.propose");
      return linked.some(item => write ? (item.status === "merged" || item.status === "noChanges") : item.status === "completed");
    });
    if (covered) await this.plans.markCompleted(planId).catch(() => undefined);
  }

}

function gateBudget() { return { maxTurns: 12, maxToolCalls: 24, maxTotalTokens: 40_000, maxDurationMs: 10 * 60_000 }; }
