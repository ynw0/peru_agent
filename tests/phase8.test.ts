import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { IncrementingIdGenerator } from "../src/agent/id-generator.js";
import { InMemoryEventJournal } from "../src/agent/event-journal.js";
import { CheckpointManager, InMemoryCheckpointStore } from "../src/checkpoint/checkpoint-manager.js";
import { DiffManager } from "../src/diff/diff-manager.js";
import { InMemoryDiffProposalStore } from "../src/diff/diff-store.js";
import { AgentRuntime } from "../src/runtime/agent-runtime.js";
import { PermissionCoordinator } from "../src/agent/permission-coordinator.js";
import { InMemorySessionStore } from "../src/storage/session-store.js";
import { ToolRegistry, type Tool } from "../src/tool-runtime.js";
import type { ModelProvider, ModelRequest, ModelStreamEvent } from "../src/model/types.js";
import { WorkspaceRegistry, WorkspaceService } from "../src/workspace/workspace-service.js";
import { SnapshotWorktreeManager } from "../src/subagent/worktree-manager.js";
import { SubagentPatchMerger } from "../src/subagent/patch-merger.js";
import { SubagentScheduler } from "../src/subagent/scheduler.js";
import { InMemorySubagentTaskStore, JsonSubagentTaskStore } from "../src/subagent/task-store.js";
import type {
  SubagentExecutionContext,
  SubagentExecutor,
} from "../src/subagent/executor.js";
import type {
  SubagentExecutionResult,
  SubagentTaskRecord,
  SubagentTaskRequest,
} from "../src/subagent/types.js";
import { validateSubagentTaskRequest } from "../src/subagent/policy.js";
import { TypedIpcClient, TypedIpcServer } from "../src/ipc/channel.js";
import { createInMemoryTransportPair } from "../src/ipc/transport.js";
import { SubagentRuntimeIpcBridge } from "../src/runtime/subagent-ipc-bridge.js";
import { SubagentController } from "../src/workbench/subagent-controller.js";
import { EMPTY_WORKBENCH_SNAPSHOT, projectWorkbenchSnapshot } from "../src/workbench/workbench-state.js";
import { isResponseResult } from "../src/ipc/validation.js";

let tempIndex = 1;

function tempPath(label: string): string {
  return `/tmp/independent-ai-ide-phase8-${label}-${Date.now()}-${tempIndex++}`;
}

const BUDGET = {
  maxTurns: 8,
  maxToolCalls: 8,
  maxTotalTokens: 1_000,
  maxDurationMs: 5_000,
} as const;

function request(
  role: SubagentTaskRequest["role"],
  overrides: Partial<SubagentTaskRequest> = {},
): SubagentTaskRequest {
  return {
    parentSessionId: "parent-session",
    role,
    instruction: `执行 ${role} 任务`,
    depth: 1,
    baseWorkspaceId: "base",
    allowedPaths: ["src"],
    writablePaths: role === "implementer" ? ["src"] : [],
    allowedCapabilities: role === "implementer"
      ? ["workspace.read", "workspace.write"]
      : role === "tester"
        ? ["workspace.read"]
        : ["workspace.read"],
    budget: BUDGET,
    ...overrides,
  };
}

class ScriptedExecutor implements SubagentExecutor {
  public active = 0;
  public maxActive = 0;

  public constructor(
    private readonly workspaces: WorkspaceRegistry,
    private readonly behavior: (context: SubagentExecutionContext) => Promise<SubagentExecutionResult>,
  ) {}

  public async execute(context: SubagentExecutionContext): Promise<SubagentExecutionResult> {
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    try {
      return await this.behavior(context);
    } finally {
      this.active -= 1;
    }
  }

  public workspace(id: string): WorkspaceService {
    return this.workspaces.get(id);
  }
}

interface Environment {
  readonly root: string;
  readonly base: WorkspaceService;
  readonly workspaces: WorkspaceRegistry;
  readonly diffs: DiffManager;
  readonly scheduler: SubagentScheduler;
  readonly executor: ScriptedExecutor;
  readonly taskStore: InMemorySubagentTaskStore;
}

async function createEnvironment(
  behavior: (context: SubagentExecutionContext, workspaces: WorkspaceRegistry) => Promise<SubagentExecutionResult>,
  options = { maxConcurrent: 3, maxConcurrentPerParent: 2 },
): Promise<Environment> {
  const root = tempPath("env");
  await mkdir(root, { recursive: true });
  const workspaces = new WorkspaceRegistry();
  const base = await WorkspaceService.create("base", `${root}/base`);
  workspaces.register(base);
  await base.writeText({ path: "src/app.ts", content: "export const value = 1;\n", expectedSha256: null });
  await base.writeText({ path: "README.md", content: "outside scope\n", expectedSha256: null });

  const ids = new IncrementingIdGenerator();
  const journal = new InMemoryEventJournal();
  const checkpoints = new CheckpointManager(new InMemoryCheckpointStore(), ids, workspaces);
  const diffs = new DiffManager(workspaces, checkpoints, ids, journal, new InMemoryDiffProposalStore());
  const worktrees = new SnapshotWorktreeManager(workspaces, `${root}/worktrees`);
  const merger = new SubagentPatchMerger(worktrees, workspaces, diffs);
  const taskStore = new InMemorySubagentTaskStore();
  const executor = new ScriptedExecutor(workspaces, context => behavior(context, workspaces));
  const scheduler = new SubagentScheduler(
    executor,
    worktrees,
    merger,
    diffs,
    taskStore,
    journal,
    ids,
    options,
  );
  return { root, base, workspaces, diffs, scheduler, executor, taskStore };
}

function completed(
  overrides: Partial<SubagentExecutionResult> = {},
): SubagentExecutionResult {
  return {
    summary: "done",
    usage: { inputTokens: 10, outputTokens: 5, turns: 1, toolCalls: 0 },
    ...overrides,
  };
}

async function delay(ms: number, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    }, { once: true });
  });
}

test("子 Agent 角色、深度、路径和能力采用硬边界", () => {
  assert.throws(() => validateSubagentTaskRequest(request("planner", {
    writablePaths: ["src"],
  })));
  assert.throws(() => validateSubagentTaskRequest(request("implementer", {
    depth: 3,
  })));
  assert.throws(() => validateSubagentTaskRequest(request("implementer", {
    writablePaths: ["tests"],
  })));
  assert.throws(() => validateSubagentTaskRequest(request("explorer", {
    allowedCapabilities: ["network.internet"],
  })));
});

test("快照式隔离工作树只复制允许路径且不修改父工作区", async () => {
  const env = await createEnvironment(async (context, workspaces) => {
    const workspace = workspaces.get(context.workspaceId);
    const before = await workspace.readText("src/app.ts");
    await workspace.writeText({
      path: "src/app.ts",
      content: "export const value = 2;\n",
      expectedSha256: before.sha256,
    });
    return completed();
  });
  try {
    const task = await env.scheduler.dispatch(request("implementer"));
    const result = await env.scheduler.start(task.id);
    assert.equal(result.status, "completed");
    assert.equal((await env.base.readText("src/app.ts")).content, "export const value = 1;\n");
    assert.equal(await env.workspaces.get(result.worktree?.workspaceId ?? "missing").snapshot("README.md").then(file => file.exists), false);
  } finally {
    await rm(env.root, { recursive: true, force: true });
  }
});

test("只读角色修改隔离工作区会明确失败", async () => {
  const env = await createEnvironment(async (context, workspaces) => {
    const workspace = workspaces.get(context.workspaceId);
    const before = await workspace.readText("src/app.ts");
    await workspace.writeText({ path: "src/app.ts", content: "mutated\n", expectedSha256: before.sha256 });
    return completed();
  });
  try {
    const task = await env.scheduler.dispatch(request("explorer"));
    const result = await env.scheduler.start(task.id);
    assert.equal(result.status, "failed");
    assert.match(result.error?.message ?? "", /只读路径/);
  } finally {
    await rm(env.root, { recursive: true, force: true });
  }
});

test("调度器在异步创建工作区前占用父会话并发槽位", async () => {
  const env = await createEnvironment(async context => {
    await delay(20, context.signal);
    return completed();
  }, { maxConcurrent: 3, maxConcurrentPerParent: 1 });
  try {
    const tasks = await Promise.all([
      env.scheduler.dispatch(request("explorer", { instruction: "one" })),
      env.scheduler.dispatch(request("explorer", { instruction: "two" })),
      env.scheduler.dispatch(request("explorer", { instruction: "three" })),
    ]);
    await Promise.all(tasks.map(task => env.scheduler.start(task.id)));
    assert.equal(env.executor.maxActive, 1);
  } finally {
    await rm(env.root, { recursive: true, force: true });
  }
});

test("父会话取消会同时取消运行和排队中的子任务", async () => {
  const env = await createEnvironment(async context => {
    await delay(10_000, context.signal);
    return completed();
  }, { maxConcurrent: 2, maxConcurrentPerParent: 1 });
  try {
    const first = await env.scheduler.dispatch(request("explorer", { instruction: "first" }));
    const second = await env.scheduler.dispatch(request("explorer", { instruction: "second" }));
    const firstRun = env.scheduler.start(first.id);
    const secondRun = env.scheduler.start(second.id);
    await Promise.resolve();
    assert.equal(await env.scheduler.abortParentSession("parent-session"), 2);
    assert.equal((await firstRun).status, "aborted");
    assert.equal((await secondRun).status, "aborted");
  } finally {
    await rm(env.root, { recursive: true, force: true });
  }
});

test("预算超限会把子任务标记为失败", async () => {
  const env = await createEnvironment(async () => completed({
    usage: { inputTokens: 900, outputTokens: 200, turns: 1, toolCalls: 0 },
  }));
  try {
    const task = await env.scheduler.dispatch(request("explorer"));
    const result = await env.scheduler.start(task.id);
    assert.equal(result.status, "failed");
    assert.match(result.error?.message ?? "", /超过预算/);
  } finally {
    await rm(env.root, { recursive: true, force: true });
  }
});

test("Patch 必须通过 Reviewer 和 Tester，接受 Diff 后才标记 merged", async () => {
  const env = await createEnvironment(async (context, workspaces) => {
    if (context.task.role === "implementer") {
      const workspace = workspaces.get(context.workspaceId);
      const before = await workspace.readText("src/app.ts");
      await workspace.writeText({
        path: "src/app.ts",
        content: "export const value = 2;\n",
        expectedSha256: before.sha256,
      });
      return completed();
    }
    return completed({ verdict: "approved" });
  });
  try {
    const implementer = await env.scheduler.dispatch(request("implementer"));
    const implemented = await env.scheduler.start(implementer.id);
    const reviewer = await env.scheduler.dispatch(request("reviewer", {
      targetTaskId: implemented.id,
      instruction: "review patch",
    }));
    const tester = await env.scheduler.dispatch(request("tester", {
      targetTaskId: implemented.id,
      instruction: "test patch",
    }));
    const reviewed = await env.scheduler.start(reviewer.id);
    const tested = await env.scheduler.start(tester.id);

    await assert.rejects(env.scheduler.proposeMerge(implemented.id, [reviewed.id]));
    const proposedTask = await env.scheduler.proposeMerge(implemented.id, [reviewed.id, tested.id]);
    assert.equal(proposedTask.status, "patchProposed");
    assert.equal((await env.base.readText("src/app.ts")).content, "export const value = 1;\n");

    await env.diffs.accept(proposedTask.patchProposalId ?? "missing");
    const merged = await env.scheduler.finalizeMerge(implemented.id);
    assert.equal(merged.status, "merged");
    assert.equal((await env.base.readText("src/app.ts")).content, "export const value = 2;\n");
  } finally {
    await rm(env.root, { recursive: true, force: true });
  }
});

test("父工作区在子任务后变化时拒绝生成覆盖性 Patch", async () => {
  const env = await createEnvironment(async (context, workspaces) => {
    if (context.task.role === "implementer") {
      const workspace = workspaces.get(context.workspaceId);
      const before = await workspace.readText("src/app.ts");
      await workspace.writeText({ path: "src/app.ts", content: "agent\n", expectedSha256: before.sha256 });
      return completed();
    }
    return completed({ verdict: "approved" });
  });
  try {
    const implementer = await env.scheduler.dispatch(request("implementer"));
    const implemented = await env.scheduler.start(implementer.id);
    const parentBefore = await env.base.readText("src/app.ts");
    await env.base.writeText({ path: "src/app.ts", content: "user\n", expectedSha256: parentBefore.sha256 });
    const reviewer = await env.scheduler.dispatch(request("reviewer", { targetTaskId: implemented.id }));
    const tester = await env.scheduler.dispatch(request("tester", { targetTaskId: implemented.id }));
    const reviewed = await env.scheduler.start(reviewer.id);
    const tested = await env.scheduler.start(tester.id);

    await assert.rejects(
      env.scheduler.proposeMerge(implemented.id, [reviewed.id, tested.id]),
      error => error instanceof Error && error.message.includes("父工作区"),
    );
    assert.equal((await env.base.readText("src/app.ts")).content, "user\n");
  } finally {
    await rm(env.root, { recursive: true, force: true });
  }
});

test("进程重启后 queued/running 子任务不会伪装为仍在运行", async () => {
  const root = tempPath("restore");
  const store = new JsonSubagentTaskStore(`${root}/tasks.json`);
  const now = new Date().toISOString();
  const record: SubagentTaskRecord = {
    ...request("explorer"),
    id: "subagent-running",
    status: "running",
    createdAt: now,
    updatedAt: now,
  };
  await store.save(record);

  const env = await createEnvironment(async () => completed());
  try {
    const ids = new IncrementingIdGenerator();
    const journal = new InMemoryEventJournal();
    const checkpoints = new CheckpointManager(new InMemoryCheckpointStore(), ids, env.workspaces);
    const diffs = new DiffManager(env.workspaces, checkpoints, ids, journal, new InMemoryDiffProposalStore());
    const worktrees = new SnapshotWorktreeManager(env.workspaces, `${root}/worktrees`);
    const scheduler = new SubagentScheduler(
      env.executor,
      worktrees,
      new SubagentPatchMerger(worktrees, env.workspaces, diffs),
      diffs,
      store,
      journal,
      ids,
      { maxConcurrent: 1, maxConcurrentPerParent: 1 },
    );
    const restored = await scheduler.restoreAll();
    assert.equal(restored[0]?.status, "failed");
    assert.equal(restored[0]?.error?.code, "SUBAGENT_INTERRUPTED_RECOVERED");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(env.root, { recursive: true, force: true });
  }
});

class ToolCallProvider implements ModelProvider {
  public readonly id = "subagent-policy-provider";
  private turn = 0;

  public async *stream(_request: ModelRequest, _signal: AbortSignal): AsyncIterable<ModelStreamEvent> {
    this.turn += 1;
    if (this.turn === 1) {
      yield { type: "tool-call.delta", index: 0, id: "call", name: "DangerousWrite", argumentsDelta: "{}" };
      yield { type: "response.completed", finishReason: "tool_calls", usage: { inputTokens: 1, outputTokens: 1 } };
      return;
    }
    yield { type: "text.delta", delta: "done" };
    yield { type: "response.completed", finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1 } };
  }
}

test("AgentLoop 的子任务运行策略同时过滤模型工具列表和执行阶段", async () => {
  let executed = false;
  const tool: Tool<Record<string, never>, { readonly ok: true }> = {
    manifest: {
      name: "DangerousWrite",
      version: "1.0.0",
      description: "write",
      riskLevel: "workspace-write",
      capabilities: ["workspace.write"],
      generated: false,
    },
    validate: () => ({}),
    inspect: () => ({ affectedFiles: ["src/app.ts"], certifiedComputerApplication: false }),
    execute: async () => {
      executed = true;
      return { ok: true };
    },
    serializeOutput: output => JSON.stringify(output),
  };
  const registry = new ToolRegistry();
  registry.register(tool);
  const ids = new IncrementingIdGenerator();
  const runtime = new AgentRuntime({
    provider: new ToolCallProvider(),
    tools: registry,
    permissions: new PermissionCoordinator(ids),
    journal: new InMemoryEventJournal(),
    sessions: new InMemorySessionStore(),
    idGenerator: ids,
  }, {
    systemPrompt: "test",
    maxOutputTokensPerTurn: 32,
    limits: { maxTurns: 3, maxToolCalls: 3, maxTotalTokens: 100 },
  });
  const session = await runtime.createSession("workspace", "fullAccess");
  const run = await runtime.startSession(session.id, "run", {
    allowedCapabilities: ["workspace.read"],
  });
  const result = await runtime.waitForRun(run.runId);
  assert.equal(result.status, "completed");
  assert.equal(executed, false);
  assert.match(result.messages.find(message => message.role === "tool")?.content ?? "", /运行策略拒绝/);
});


test("Subagent Typed IPC 支持派发、启动、查询和事件发布", async () => {
  const env = await createEnvironment(async () => completed());
  const [clientTransport, serverTransport] = createInMemoryTransportPair();
  const client = new TypedIpcClient(clientTransport);
  const server = new TypedIpcServer(serverTransport);
  const bridge = new SubagentRuntimeIpcBridge(env.scheduler, server);
  bridge.start();
  const controller = new SubagentController(client, 1_000);
  const observed: string[] = [];
  const eventDisposable = client.onEvent("agent.event", event => observed.push(event.type));
  try {
    const task = await controller.dispatch(request("explorer"));
    await controller.start(task.id);
    const finished = await env.scheduler.wait(task.id);
    const loaded = await controller.get(task.id);
    const listed = await controller.list("parent-session");

    assert.equal(finished.status, "completed");
    assert.equal(loaded.status, "completed");
    assert.equal(listed.length, 1);
    assert.ok(observed.includes("subagent.task.created"));
    assert.ok(observed.includes("subagent.task.completed"));
  } finally {
    eventDisposable.dispose();
    bridge.dispose();
    client.dispose();
    server.dispose();
    await rm(env.root, { recursive: true, force: true });
  }
});

test("Workbench Projector 可以恢复子 Agent 生命周期和 Patch 状态", () => {
  let snapshot = projectWorkbenchSnapshot(EMPTY_WORKBENCH_SNAPSHOT, {
    type: "session.created",
    sessionId: "parent",
    workspaceId: "workspace",
  });
  snapshot = projectWorkbenchSnapshot(snapshot, {
    type: "subagent.task.created",
    sessionId: "parent",
    taskId: "task-1",
    role: "implementer",
    depth: 1,
  });
  snapshot = projectWorkbenchSnapshot(snapshot, {
    type: "subagent.task.started",
    sessionId: "parent",
    taskId: "task-1",
    workspaceId: "subagent:task-1",
  });
  snapshot = projectWorkbenchSnapshot(snapshot, {
    type: "subagent.task.completed",
    sessionId: "parent",
    taskId: "task-1",
    role: "implementer",
  });
  snapshot = projectWorkbenchSnapshot(snapshot, {
    type: "subagent.patch.proposed",
    sessionId: "parent",
    taskId: "task-1",
    proposalId: "diff-1",
    gateTaskIds: ["review-1", "test-1"],
  });
  snapshot = projectWorkbenchSnapshot(snapshot, {
    type: "subagent.task.merged",
    sessionId: "parent",
    taskId: "task-1",
    proposalId: "diff-1",
  });

  assert.equal(snapshot.subagents.length, 1);
  assert.equal(snapshot.subagents[0]?.status, "merged");
  assert.equal(snapshot.subagents[0]?.proposalId, "diff-1");
});


test("同一 queued 任务重复 start 只执行一次", async () => {
  let executions = 0;
  const env = await createEnvironment(async context => {
    executions += 1;
    await delay(10, context.signal);
    return completed();
  });
  try {
    const task = await env.scheduler.dispatch(request("explorer"));
    const [first, second] = await Promise.all([
      env.scheduler.start(task.id),
      env.scheduler.start(task.id),
    ]);
    assert.equal(first.status, "completed");
    assert.equal(second.status, "completed");
    assert.equal(executions, 1);
  } finally {
    await rm(env.root, { recursive: true, force: true });
  }
});

test("持久化隔离工作树必须绑定配置的隔离根目录", async () => {
  const env = await createEnvironment(async () => completed());
  try {
    const task = await env.scheduler.dispatch(request("implementer"));
    const completedTask = await env.scheduler.start(task.id);
    const worktree = completedTask.worktree;
    if (worktree === undefined) {
      throw new Error("Implementer 未保留隔离工作树");
    }
    const manager = new SnapshotWorktreeManager(env.workspaces, `${env.root}/other-worktrees`);
    await assert.rejects(
      manager.restore(worktree),
      error => error instanceof Error && error.message.includes("路径或 Workspace ID 不匹配"),
    );
  } finally {
    await rm(env.root, { recursive: true, force: true });
  }
});

test("损坏的子 Agent JSON 存储会明确失败", async () => {
  const root = tempPath("corrupt-store");
  await mkdir(root, { recursive: true });
  const file = `${root}/tasks.json`;
  await writeFile(file, "{ invalid", "utf8");
  try {
    await assert.rejects(
      new JsonSubagentTaskStore(file).list(),
      error => error instanceof Error && error.message.includes("JSON 损坏"),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Workbench Snapshot IPC 边界必须包含合法 subagents", () => {
  assert.equal(isResponseResult("workbench.getSnapshot", { ...EMPTY_WORKBENCH_SNAPSHOT }), true);
  const { subagents: _subagents, ...missing } = EMPTY_WORKBENCH_SNAPSHOT;
  assert.equal(isResponseResult("workbench.getSnapshot", missing), false);
  assert.equal(isResponseResult("workbench.getSnapshot", {
    ...EMPTY_WORKBENCH_SNAPSHOT,
    subagents: [{ taskId: "task", role: "implementer", depth: 1, status: "completed" }],
  }), true);
  assert.equal(isResponseResult("workbench.getSnapshot", {
    ...EMPTY_WORKBENCH_SNAPSHOT,
    subagents: [{ taskId: "task", role: "unknown", depth: 1, status: "completed" }],
  }), false);
});


test("尚未 start 的 queued 子任务可以被父会话取消", async () => {
  const env = await createEnvironment(async () => completed());
  try {
    const task = await env.scheduler.dispatch(request("explorer"));
    assert.equal(await env.scheduler.abortParentSession("parent-session"), 1);
    const aborted = env.scheduler.get(task.id);
    assert.equal(aborted.status, "aborted");
    assert.equal(aborted.error?.code, "SUBAGENT_ABORTED");
    assert.equal(env.executor.active, 0);
  } finally {
    await rm(env.root, { recursive: true, force: true });
  }
});
