import type { DiffManager, DiffProposal } from "../diff/diff-manager.js";
import type { WorkspaceRegistry } from "../workspace/workspace-service.js";
import type { SnapshotWorktreeManager } from "./worktree-manager.js";
import type { SubagentTaskRecord } from "./types.js";

export class SubagentPatchMerger {
  public constructor(
    private readonly worktrees: SnapshotWorktreeManager,
    private readonly workspaces: WorkspaceRegistry,
    private readonly diffs: DiffManager,
  ) {}

  public async propose(task: SubagentTaskRecord): Promise<DiffProposal> {
    if (task.role !== "implementer" || task.status !== "completed" || task.worktree === undefined) {
      throw new Error("只有已完成的 Implementer 任务可以提出 Patch 合并");
    }
    const changes = await this.worktrees.collectPatch(task.worktree);
    if (changes.length === 0) {
      throw new Error("子 Agent 没有产生可合并修改");
    }

    const base = this.workspaces.get(task.baseWorkspaceId);
    for (const change of changes) {
      const current = await base.snapshot(change.path);
      if (current.sha256 !== change.before.sha256) {
        throw new Error(`父工作区在子 Agent 执行期间发生变化：${change.path}`);
      }
    }

    return this.diffs.propose({
      sessionId: task.parentSessionId,
      workspaceId: task.baseWorkspaceId,
      toolCallId: `subagent:${task.id}`,
      changes: changes.map(change => ({ path: change.path, afterContent: change.afterContent })),
    });
  }
}
