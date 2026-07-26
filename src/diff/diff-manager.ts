import type { AgentEvent } from "../agent-protocol.js";
import type { EventJournal } from "../agent/event-journal.js";
import type { IdGenerator } from "../agent/id-generator.js";
import type { CheckpointManager } from "../checkpoint/checkpoint-manager.js";
import type { WorkspaceFileSnapshot } from "../workspace/types.js";
import type { DiffProposalStore } from "./diff-store.js";
import {
  WorkspaceConflictError,
  type WorkspaceRegistry,
  sha256Text,
} from "../workspace/workspace-service.js";

export type DiffProposalStatus = "proposed" | "accepted" | "rejected" | "conflict";

export interface ProposedFileChange {
  readonly path: string;
  readonly before: WorkspaceFileSnapshot;
  readonly afterContent: string;
  readonly afterSha256: string;
  readonly unifiedDiff: string;
}

export interface DiffProposal {
  readonly id: string;
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly toolCallId: string;
  readonly createdAt: string;
  readonly status: DiffProposalStatus;
  readonly changes: readonly ProposedFileChange[];
  readonly checkpointId?: string;
  readonly conflictMessage?: string;
}

export interface DiffManagerListener {
  (event: AgentEvent): void | Promise<void>;
}

function buildUnifiedDiff(path: string, before: string, after: string): string {
  if (before === after) {
    return `--- a/${path}\n+++ b/${path}\n`;
  }

  const beforeLines = before.split("\n");
  const afterLines = after.split("\n");
  let prefix = 0;
  while (prefix < beforeLines.length && prefix < afterLines.length
    && beforeLines[prefix] === afterLines[prefix]) {
    prefix += 1;
  }
  let suffix = 0;
  while (suffix < beforeLines.length - prefix && suffix < afterLines.length - prefix
    && beforeLines[beforeLines.length - 1 - suffix] === afterLines[afterLines.length - 1 - suffix]) {
    suffix += 1;
  }

  const removed = beforeLines.slice(prefix, beforeLines.length - suffix);
  const added = afterLines.slice(prefix, afterLines.length - suffix);
  const header = [
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -${prefix + 1},${removed.length} +${prefix + 1},${added.length} @@`,
  ];
  return [
    ...header,
    ...removed.map(line => `-${line}`),
    ...added.map(line => `+${line}`),
  ].join("\n");
}

// DiffManager 保存模型提出的修改；只有 accept() 才会真正写入工作区。
export class DiffManager {
  private readonly proposals = new Map<string, DiffProposal>();
  private readonly listeners = new Set<DiffManagerListener>();
  private mutationQueue: Promise<void> = Promise.resolve();

  public constructor(
    private readonly workspaces: WorkspaceRegistry,
    private readonly checkpoints: CheckpointManager,
    private readonly ids: IdGenerator,
    private readonly journal: EventJournal,
    private readonly store: DiffProposalStore,
  ) {}

  public async restoreAll(): Promise<readonly DiffProposal[]> {
    const stored = await this.store.list();
    for (const proposal of stored) {
      this.proposals.set(proposal.id, structuredClone(proposal));
    }
    return this.list();
  }

  public onEvent(listener: DiffManagerListener): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  public async propose(input: {
    readonly sessionId: string;
    readonly workspaceId: string;
    readonly toolCallId: string;
    readonly changes: readonly { readonly path: string; readonly afterContent: string }[];
  }): Promise<DiffProposal> {
    if (input.changes.length === 0) {
      throw new Error("Diff Proposal 至少包含一个文件修改");
    }
    const workspace = this.workspaces.get(input.workspaceId);
    const seen = new Set<string>();
    const changes: ProposedFileChange[] = [];
    for (const change of input.changes) {
      const before = await workspace.snapshot(change.path);
      if (seen.has(before.path)) {
        throw new Error(`Diff Proposal 包含重复文件：${before.path}`);
      }
      seen.add(before.path);
      const beforeContent = before.content ?? "";
      if (beforeContent === change.afterContent) {
        throw new Error(`修改前后内容相同：${before.path}`);
      }
      changes.push({
        path: before.path,
        before,
        afterContent: change.afterContent,
        afterSha256: sha256Text(change.afterContent),
        unifiedDiff: buildUnifiedDiff(before.path, beforeContent, change.afterContent),
      });
    }

    const proposal: DiffProposal = {
      id: this.ids.next("diff"),
      sessionId: input.sessionId,
      workspaceId: input.workspaceId,
      toolCallId: input.toolCallId,
      createdAt: new Date().toISOString(),
      status: "proposed",
      changes,
    };
    this.proposals.set(proposal.id, proposal);
    await this.store.save(proposal);
    await this.publish({
      type: "diff.proposed",
      sessionId: proposal.sessionId,
      proposalId: proposal.id,
      affectedFiles: changes.map(change => change.path),
    });
    return structuredClone(proposal);
  }

  public get(id: string): DiffProposal | undefined {
    const proposal = this.proposals.get(id);
    return proposal === undefined ? undefined : structuredClone(proposal);
  }

  public list(workspaceId?: string): readonly DiffProposal[] {
    return [...this.proposals.values()]
      .filter(proposal => workspaceId === undefined || proposal.workspaceId === workspaceId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map(proposal => structuredClone(proposal));
  }

  public accept(id: string): Promise<DiffProposal> {
    return this.enqueueMutation(() => this.acceptInternal(id));
  }

  public reject(id: string): Promise<DiffProposal> {
    return this.enqueueMutation(async () => {
      const proposal = this.requireProposed(id);
      const rejected: DiffProposal = { ...proposal, status: "rejected" };
      this.proposals.set(id, rejected);
      await this.store.save(rejected);
      await this.publish({
        type: "diff.resolved",
        sessionId: proposal.sessionId,
        proposalId: id,
        decision: "rejected",
      });
      return structuredClone(rejected);
    });
  }

  private async acceptInternal(id: string): Promise<DiffProposal> {
    const proposal = this.requireProposed(id);
    const workspace = this.workspaces.get(proposal.workspaceId);

    try {
      // 一次性检查全部文件，确认没有外部修改后才创建 Checkpoint 和开始写入。
      for (const change of proposal.changes) {
        const current = await workspace.snapshot(change.path);
        if (current.sha256 !== change.before.sha256) {
          throw new WorkspaceConflictError(change.path, change.before.sha256, current.sha256);
        }
      }

      const checkpoint = await this.checkpoints.create({
        workspaceId: proposal.workspaceId,
        sessionId: proposal.sessionId,
        proposalId: proposal.id,
        files: proposal.changes.map(change => change.before),
      });

      const written: ProposedFileChange[] = [];
      try {
        for (const change of proposal.changes) {
          await workspace.writeText({
            path: change.path,
            content: change.afterContent,
            expectedSha256: change.before.sha256,
          });
          written.push(change);
        }
      } catch (error: unknown) {
        // 多文件提交中途失败时，使用原始快照回滚已经写入的文件，避免留下半次提交。
        for (const change of [...written].reverse()) {
          if (change.before.exists && change.before.content !== null) {
            await workspace.writeText({
              path: change.path,
              content: change.before.content,
              expectedSha256: change.afterSha256,
            });
          } else {
            await workspace.deleteFile(change.path, change.afterSha256);
          }
        }
        throw error;
      }

      await this.checkpoints.finalize(
        checkpoint.id,
        new Map(proposal.changes.map(change => [
          change.path,
          { sha256: change.afterSha256, content: change.afterContent },
        ])),
      );
      const accepted: DiffProposal = {
        ...proposal,
        status: "accepted",
        checkpointId: checkpoint.id,
      };
      this.proposals.set(id, accepted);
      await this.store.save(accepted);
      await this.publish({
        type: "checkpoint.created",
        sessionId: proposal.sessionId,
        checkpointId: checkpoint.id,
        proposalId: proposal.id,
      });
      await this.publish({
        type: "diff.resolved",
        sessionId: proposal.sessionId,
        proposalId: id,
        decision: "accepted",
        checkpointId: checkpoint.id,
      });
      return structuredClone(accepted);
    } catch (error: unknown) {
      if (error instanceof WorkspaceConflictError) {
        const conflict: DiffProposal = {
          ...proposal,
          status: "conflict",
          conflictMessage: error.message,
        };
        this.proposals.set(id, conflict);
        await this.store.save(conflict);
        await this.publish({
          type: "diff.resolved",
          sessionId: proposal.sessionId,
          proposalId: id,
          decision: "conflict",
        });
      }
      throw error;
    }
  }

  private requireProposed(id: string): DiffProposal {
    const proposal = this.proposals.get(id);
    if (proposal === undefined) {
      throw new Error(`Diff Proposal 不存在：${id}`);
    }
    if (proposal.status !== "proposed") {
      throw new Error(`Diff Proposal 状态不允许该操作：${proposal.status}`);
    }
    return proposal;
  }

  private async publish(event: AgentEvent): Promise<void> {
    await this.journal.append(event);
    for (const listener of this.listeners) {
      await listener(event);
    }
  }

  private enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationQueue.then(operation, operation);
    this.mutationQueue = result.then(() => undefined, () => undefined);
    return result;
  }
}
