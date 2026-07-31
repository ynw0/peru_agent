import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { IdGenerator } from "../agent/id-generator.js";
import { JsonlEventJournal } from "../agent/event-journal.js";
import { PermissionCoordinator } from "../agent/permission-coordinator.js";
import { CheckpointManager, JsonCheckpointStore } from "../checkpoint/checkpoint-manager.js";
import { DiffManager } from "../diff/diff-manager.js";
import { DiffReviewCoordinator } from "../diff/diff-review-coordinator.js";
import { JsonDiffProposalStore } from "../diff/diff-store.js";
import { PlanManager } from "../plan/plan-manager.js";
import { WorkbenchRuntime } from "./workbench-runtime.js";
import { WorkspaceRuntime } from "./workspace-runtime.js";
import { JsonSessionStore } from "../storage/session-store.js";
import { ToolRegistry } from "../tool-runtime.js";
import { createWorkspaceTools } from "../tools/workspace-tools.js";
import { WorkspaceRegistry } from "../workspace/workspace-service.js";
import { createDocumentTools } from "../tools/document-tools.js";
import { AgentOrchestrationRuntime } from "../orchestration/runtime.js";
import { WorkspaceTargetResolver } from "../workspace/target-resolver.js";

export interface AgentCoreComposition {
  readonly ids: IdGenerator;
  readonly journal: JsonlEventJournal;
  readonly workspaces: WorkspaceRegistry;
  readonly targetResolver: WorkspaceTargetResolver;
  readonly sessions: JsonSessionStore;
  readonly checkpoints: CheckpointManager;
  readonly diffs: DiffManager;
  readonly diffReviews: DiffReviewCoordinator;
  readonly tools: ToolRegistry;
  readonly permissions: PermissionCoordinator;
  readonly workspace: WorkspaceRuntime;
  readonly plans: PlanManager;
  readonly workbench: WorkbenchRuntime;
  readonly orchestration: AgentOrchestrationRuntime;
}

export function createAgentCoreComposition(dataDirectory: string): AgentCoreComposition {
  const ids: IdGenerator = { next: prefix => `${prefix}-${randomUUID()}` };
  const journal = new JsonlEventJournal(join(dataDirectory, "events.jsonl"));
  const workspaces = new WorkspaceRegistry();
  const targetResolver = new WorkspaceTargetResolver(workspaces);
  const sessions = new JsonSessionStore(join(dataDirectory, "sessions"));
  const checkpoints = new CheckpointManager(
    new JsonCheckpointStore(join(dataDirectory, "checkpoints")),
    ids,
    workspaces,
    sessions,
  );
  const diffs = new DiffManager(
    workspaces,
    checkpoints,
    ids,
    journal,
    new JsonDiffProposalStore(join(dataDirectory, "diffs")),
  );
  const diffReviews = new DiffReviewCoordinator(diffs);
  const workspace = new WorkspaceRuntime(workspaces, diffs, checkpoints, journal, diffReviews);
  const workbench = new WorkbenchRuntime(journal);
  const plans = new PlanManager(ids, journal);
  const orchestration = new AgentOrchestrationRuntime(plans, workspaces, diffs, journal, ids, dataDirectory);
  const core: AgentCoreComposition = {
    ids,
    journal,
    workspaces,
    targetResolver,
    sessions,
    checkpoints,
    diffs,
    diffReviews,
    tools: new ToolRegistry(),
    permissions: new PermissionCoordinator(ids, join(dataDirectory, "permissions.json")),
    workspace,
    plans,
    workbench,
    orchestration,
  };
  for (const tool of createWorkspaceTools({
    workspaces,
    targetResolver,
    diffs,
    checkpoints,
    diffReviews,
  })) {
    core.tools.register(tool);
  }
  for (const tool of createDocumentTools({ workspaces, targetResolver, diffs, diffReviews })) core.tools.register(tool);
  return core;
}
