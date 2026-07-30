import type { AgentEvent } from "../agent-protocol.js";
import type { EventJournal } from "../agent/event-journal.js";
import type { CheckpointManager, CheckpointRecord } from "../checkpoint/checkpoint-manager.js";
import type { DiffManager, DiffProposal } from "../diff/diff-manager.js";
import { DiffReviewCoordinator } from "../diff/diff-review-coordinator.js";
import type { WorkspaceFileSnapshot } from "../workspace/types.js";
import { WorkspaceRegistry, WorkspaceService } from "../workspace/workspace-service.js";

export interface WorkspaceRuntimeListener {
  (event: AgentEvent): void | Promise<void>;
}

// WorkspaceRuntime 是 IDE 对工作区、Diff 和 Checkpoint 操作的统一入口。
export class WorkspaceRuntime {
  private readonly listeners = new Set<WorkspaceRuntimeListener>();
  private mutationQueue: Promise<void> = Promise.resolve();

  public constructor(
    public readonly workspaces: WorkspaceRegistry,
    private readonly diffs: DiffManager,
    private readonly checkpoints: CheckpointManager,
    private readonly journal: EventJournal,
    private readonly diffReviews: DiffReviewCoordinator = new DiffReviewCoordinator(diffs),
  ) {
    this.diffs.onEvent(event => this.emit(event));
  }

  public onEvent(listener: WorkspaceRuntimeListener): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  public async registerWorkspace(workspaceId: string, rootPath: string): Promise<void> {
    const workspace = await WorkspaceService.create(workspaceId, rootPath);
    this.workspaces.register(workspace);
  }

  public read(workspaceId: string, path: string): Promise<WorkspaceFileSnapshot> {
    return this.workspaces.get(workspaceId).readText(path);
  }

  public listDiffs(workspaceId?: string): readonly DiffProposal[] {
    return this.diffs.list(workspaceId);
  }

  public requireDiff(proposalId: string): DiffProposal {
    const proposal = this.diffs.get(proposalId);
    if (proposal === undefined) {
      throw new Error(`Diff Proposal 不存在：${proposalId}`);
    }
    return proposal;
  }

  public acceptDiff(proposalId: string): Promise<DiffProposal> {
    return this.enqueueMutation(() => this.diffReviews.resolve(proposalId, "accepted"));
  }

  public rejectDiff(proposalId: string): Promise<DiffProposal> {
    return this.enqueueMutation(() => this.diffReviews.resolve(proposalId, "rejected"));
  }

  public listCheckpoints(workspaceId?: string): Promise<readonly CheckpointRecord[]> {
    return this.checkpoints.list(workspaceId);
  }

  public restoreCheckpoint(checkpointId: string): Promise<CheckpointRecord> {
    return this.enqueueMutation(async () => {
      const restored = await this.checkpoints.restore(checkpointId);
      const event: AgentEvent = {
        type: "checkpoint.restored",
        sessionId: restored.sessionId,
        checkpointId: restored.id,
        affectedFiles: restored.files.map(file => file.path),
      };
      await this.journal.append(event);
      await this.emit(event);
      return restored;
    });
  }

  private enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationQueue.then(operation, operation);
    this.mutationQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  private async emit(event: AgentEvent): Promise<void> {
    for (const listener of this.listeners) {
      await listener(event);
    }
  }
}
