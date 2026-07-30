import { join } from "node:path";
import type { AgentRuntime } from "../runtime/agent-runtime.js";
import type { PlanManager } from "../plan/plan-manager.js";
import { PlanReviewCoordinator } from "../plan/plan-review-coordinator.js";
import type { DiffManager } from "../diff/diff-manager.js";
import type { EventJournal } from "../agent/event-journal.js";
import type { IdGenerator } from "../agent/id-generator.js";
import { JsonSubagentTaskStore } from "../subagent/task-store.js";
import { SnapshotWorktreeManager } from "../subagent/worktree-manager.js";
import { SubagentPatchMerger } from "../subagent/patch-merger.js";
import { DeferredAgentRuntimeSubagentExecutor } from "../subagent/executor.js";
import { SubagentScheduler } from "../subagent/scheduler.js";
import type { WorkspaceRegistry } from "../workspace/workspace-service.js";
import { SubagentWorkflowCoordinator } from "./workflow-coordinator.js";
import { GateReportStore } from "./gate-report-store.js";
import { JsonSubagentCommitStore } from "../subagent/commit-store.js";

export class AgentOrchestrationRuntime {
  public readonly planReviews: PlanReviewCoordinator;
  public readonly executor: DeferredAgentRuntimeSubagentExecutor;
  public readonly gateReports: GateReportStore;
  public readonly worktrees: SnapshotWorktreeManager;
  public readonly scheduler: SubagentScheduler;
  public readonly commits: JsonSubagentCommitStore;
  public readonly workflow: SubagentWorkflowCoordinator;

  public constructor(
    plans: PlanManager,
    workspaces: WorkspaceRegistry,
    diffs: DiffManager,
    journal: EventJournal,
    ids: IdGenerator,
    dataDirectory: string,
  ) {
    this.gateReports = new GateReportStore();
    this.executor = new DeferredAgentRuntimeSubagentExecutor(this.gateReports);
    this.commits = new JsonSubagentCommitStore(join(dataDirectory, "subagents", "commits"));
    this.planReviews = new PlanReviewCoordinator(plans);
    this.worktrees = new SnapshotWorktreeManager(workspaces, join(dataDirectory, "subagents", "worktrees"));
    const store = new JsonSubagentTaskStore(join(dataDirectory, "subagents", "tasks.json"));
    const merger = new SubagentPatchMerger(this.worktrees, workspaces, diffs);
    this.scheduler = new SubagentScheduler(this.executor, this.worktrees, merger, diffs, store, journal, ids, {
      maxConcurrent: 3,
      maxConcurrentPerParent: 2,
    }, plans, this.commits);
    this.workflow = new SubagentWorkflowCoordinator(this.scheduler, plans, diffs, this.worktrees, this.commits);
  }

  public bindAgentRuntime(agent: AgentRuntime): void { this.executor.bind(agent); }

  public restore(): Promise<readonly import("../subagent/types.js").SubagentTaskRecord[]> { return this.scheduler.restoreAll(); }

  public async dispose(parentSessionId?: string): Promise<void> {
    this.workflow.dispose();
    if (parentSessionId !== undefined) await this.scheduler.abortParentSession(parentSessionId);
  }
}
