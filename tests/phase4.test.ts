import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { IncrementingIdGenerator } from "../src/agent/id-generator.js";
import { InMemoryEventJournal } from "../src/agent/event-journal.js";
import { PermissionCoordinator } from "../src/agent/permission-coordinator.js";
import { CheckpointManager, InMemoryCheckpointStore, JsonCheckpointStore } from "../src/checkpoint/checkpoint-manager.js";
import { DiffManager } from "../src/diff/diff-manager.js";
import { InMemoryDiffProposalStore, JsonDiffProposalStore } from "../src/diff/diff-store.js";
import { TypedIpcClient, TypedIpcServer } from "../src/ipc/channel.js";
import { createInMemoryTransportPair } from "../src/ipc/transport.js";
import type { ModelProvider, ModelRequest, ModelStreamEvent } from "../src/model/types.js";
import { AgentRuntime } from "../src/runtime/agent-runtime.js";
import { WorkspaceRuntimeIpcBridge } from "../src/runtime/workspace-ipc-bridge.js";
import { WorkspaceRuntime } from "../src/runtime/workspace-runtime.js";
import { InMemorySessionStore } from "../src/storage/session-store.js";
import { ToolRegistry, type Tool } from "../src/tool-runtime.js";
import { createWorkspaceTools } from "../src/tools/workspace-tools.js";
import { projectWorkbenchSnapshot, EMPTY_WORKBENCH_SNAPSHOT } from "../src/workbench/workbench-state.js";
import { WorkspaceConflictError, WorkspaceRegistry, WorkspaceService } from "../src/workspace/workspace-service.js";

class ScriptedProvider implements ModelProvider {
  public readonly id = "phase4-scripted";
  private index = 0;

  public constructor(private readonly scripts: readonly (readonly ModelStreamEvent[])[]) {}

  public async *stream(_request: ModelRequest, _signal: AbortSignal): AsyncIterable<ModelStreamEvent> {
    const script = this.scripts[this.index++];
    if (script === undefined) {
      throw new Error("没有更多模型脚本");
    }
    for (const event of script) {
      yield event;
    }
  }
}

interface Phase4Fixture {
  readonly directory: string;
  readonly workspace: WorkspaceService;
  readonly workspaces: WorkspaceRegistry;
  readonly journal: InMemoryEventJournal;
  readonly checkpoints: CheckpointManager;
  readonly diffs: DiffManager;
  readonly workspaceRuntime: WorkspaceRuntime;
  readonly tools: readonly Tool<unknown, unknown>[];
}

async function createFixture(label: string): Promise<Phase4Fixture> {
  const directory = `/tmp/independent-ai-ide-phase4-${label}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });
  const ids = new IncrementingIdGenerator();
  const workspaces = new WorkspaceRegistry();
  const workspace = await WorkspaceService.create("workspace", `${directory}/workspace`);
  workspaces.register(workspace);
  const journal = new InMemoryEventJournal();
  const checkpoints = new CheckpointManager(new InMemoryCheckpointStore(), ids, workspaces);
  const diffs = new DiffManager(workspaces, checkpoints, ids, journal, new InMemoryDiffProposalStore());
  const workspaceRuntime = new WorkspaceRuntime(workspaces, diffs, checkpoints, journal);
  const tools = createWorkspaceTools({ workspaces, diffs, checkpoints });
  return { directory, workspace, workspaces, journal, checkpoints, diffs, workspaceRuntime, tools };
}

function toolByName(fixture: Phase4Fixture, name: string): Tool<unknown, unknown> {
  const tool = fixture.tools.find(item => item.manifest.name === name);
  if (tool === undefined) {
    throw new Error(`测试工具不存在：${name}`);
  }
  return tool;
}

async function executeTool(
  fixture: Phase4Fixture,
  name: string,
  input: unknown,
  toolCallId = "tool-call-1",
): Promise<unknown> {
  const tool = toolByName(fixture, name);
  const validated = tool.validate(input);
  return tool.execute(validated, {
    sessionId: "session-1",
    workspaceId: "workspace",
    toolCallId,
    signal: new AbortController().signal,
    reportProgress: async () => undefined,
  });
}

test("工作区路径拒绝目录穿越、绝对路径和 Windows UNC 路径", async () => {
  const fixture = await createFixture("path");
  await assert.rejects(fixture.workspace.snapshot("../outside.txt"));
  await assert.rejects(fixture.workspace.snapshot("/etc/passwd"));
  await assert.rejects(fixture.workspace.snapshot("C:\\Windows\\win.ini"));
  await assert.rejects(fixture.workspace.snapshot("\\\\server\\share\\file.txt"));
  await rm(fixture.directory, { recursive: true, force: true });
});

test("Read、Glob 和 Grep 复用统一 WorkspaceService", async () => {
  const fixture = await createFixture("read-search");
  await writeFile(`${fixture.workspace.root}/root.txt`, "Alpha\nBeta", "utf8");
  await mkdir(`${fixture.workspace.root}/src`, { recursive: true });
  await writeFile(`${fixture.workspace.root}/src/app.ts`, "const alpha = 1;", "utf8");

  const read = await executeTool(fixture, "Read", { path: "root.txt" }) as { content: string };
  const glob = await executeTool(fixture, "Glob", { pattern: "**/*" }) as { paths: string[] };
  const grep = await executeTool(fixture, "Grep", { query: "alpha", pattern: "**/*" }) as {
    matches: { path: string; line: number }[];
  };

  assert.equal(read.content, "Alpha\nBeta");
  assert.deepEqual(glob.paths, ["root.txt", "src/app.ts"]);
  assert.equal(grep.matches.length, 2);
  await rm(fixture.directory, { recursive: true, force: true });
});

test("Write 只提出 Diff，接受后才写入，Checkpoint 可以恢复", async () => {
  const fixture = await createFixture("accept-restore");
  await writeFile(`${fixture.workspace.root}/note.txt`, "before", "utf8");

  const proposal = await executeTool(fixture, "Write", {
    path: "note.txt",
    content: "after",
  }) as { id: string };
  assert.equal(await readFile(`${fixture.workspace.root}/note.txt`, "utf8"), "before");

  const accepted = await fixture.diffs.accept(proposal.id);
  assert.equal(accepted.status, "accepted");
  assert.ok(accepted.checkpointId !== undefined);
  assert.equal(await readFile(`${fixture.workspace.root}/note.txt`, "utf8"), "after");

  await fixture.workspaceRuntime.restoreCheckpoint(accepted.checkpointId ?? "");
  assert.equal(await readFile(`${fixture.workspace.root}/note.txt`, "utf8"), "before");
  await rm(fixture.directory, { recursive: true, force: true });
});

test("新文件接受后可由 Checkpoint 恢复为不存在", async () => {
  const fixture = await createFixture("new-file");
  const proposal = await executeTool(fixture, "Write", {
    path: "new.txt",
    content: "created",
  }) as { id: string };
  const accepted = await fixture.diffs.accept(proposal.id);
  assert.equal((await fixture.workspace.snapshot("new.txt")).exists, true);
  await fixture.workspaceRuntime.restoreCheckpoint(accepted.checkpointId ?? "");
  assert.equal((await fixture.workspace.snapshot("new.txt")).exists, false);
  await rm(fixture.directory, { recursive: true, force: true });
});

test("Diff 接受前发现外部修改会标记 conflict 并拒绝覆盖", async () => {
  const fixture = await createFixture("conflict");
  await writeFile(`${fixture.workspace.root}/conflict.txt`, "base", "utf8");
  const proposal = await executeTool(fixture, "Write", {
    path: "conflict.txt",
    content: "agent-change",
  }) as { id: string };
  await writeFile(`${fixture.workspace.root}/conflict.txt`, "user-change", "utf8");

  await assert.rejects(
    fixture.diffs.accept(proposal.id),
    error => error instanceof WorkspaceConflictError,
  );
  assert.equal(fixture.diffs.get(proposal.id)?.status, "conflict");
  assert.equal(await readFile(`${fixture.workspace.root}/conflict.txt`, "utf8"), "user-change");
  await rm(fixture.directory, { recursive: true, force: true });
});

test("拒绝 Diff 不会修改文件", async () => {
  const fixture = await createFixture("reject");
  await writeFile(`${fixture.workspace.root}/reject.txt`, "before", "utf8");
  const proposal = await executeTool(fixture, "Write", {
    path: "reject.txt",
    content: "after",
  }) as { id: string };
  assert.equal((await fixture.diffs.reject(proposal.id)).status, "rejected");
  assert.equal(await readFile(`${fixture.workspace.root}/reject.txt`, "utf8"), "before");
  await rm(fixture.directory, { recursive: true, force: true });
});

test("Edit 对重复 oldText 要求明确 replaceAll", async () => {
  const fixture = await createFixture("edit");
  await writeFile(`${fixture.workspace.root}/repeat.txt`, "x x", "utf8");
  await assert.rejects(executeTool(fixture, "Edit", {
    path: "repeat.txt",
    oldText: "x",
    newText: "y",
  }));
  const proposal = await executeTool(fixture, "Edit", {
    path: "repeat.txt",
    oldText: "x",
    newText: "y",
    replaceAll: true,
  }) as { id: string };
  await fixture.diffs.accept(proposal.id);
  assert.equal(await readFile(`${fixture.workspace.root}/repeat.txt`, "utf8"), "y y");
  await rm(fixture.directory, { recursive: true, force: true });
});

test("AgentLoop 调用 Write 时只生成 Proposal，不触发普通写权限并且不直接落盘", async () => {
  const fixture = await createFixture("agent-loop");
  await writeFile(`${fixture.workspace.root}/agent.txt`, "before", "utf8");
  const registry = new ToolRegistry();
  for (const tool of fixture.tools) {
    registry.register(tool);
  }
  const ids = new IncrementingIdGenerator();
  const provider = new ScriptedProvider([
    [
      {
        type: "tool-call.delta",
        index: 0,
        id: "write-call",
        name: "Write",
        argumentsDelta: JSON.stringify({ path: "agent.txt", content: "after" }),
      },
      { type: "response.completed", finishReason: "tool_calls", usage: { inputTokens: 5, outputTokens: 3 } },
    ],
    [
      { type: "text.delta", delta: "已提出修改" },
      { type: "response.completed", finishReason: "stop", usage: { inputTokens: 5, outputTokens: 3 } },
    ],
  ]);
  const runtime = new AgentRuntime({
    provider,
    tools: registry,
    permissions: new PermissionCoordinator(ids),
    journal: fixture.journal,
    sessions: new InMemorySessionStore(),
    idGenerator: ids,
  }, {
    systemPrompt: "test",
    maxOutputTokensPerTurn: 128,
    limits: { maxTurns: 3, maxToolCalls: 3, maxTotalTokens: 100 },
  });

  const session = await runtime.createSession("workspace", "default");
  const { runId } = await runtime.startSession(session.id, "修改文件");
  assert.equal((await runtime.waitForRun(runId)).status, "completed");
  assert.equal(await readFile(`${fixture.workspace.root}/agent.txt`, "utf8"), "before");
  assert.equal(fixture.diffs.list("workspace").length, 1);
  await rm(fixture.directory, { recursive: true, force: true });
});

test("Typed IPC 支持注册工作区、接受 Diff 和恢复 Checkpoint", async () => {
  const directory = `/tmp/independent-ai-ide-phase4-ipc-${Date.now()}`;
  await rm(directory, { recursive: true, force: true });
  await mkdir(`${directory}/workspace`, { recursive: true });
  await writeFile(`${directory}/workspace/ipc.txt`, "before", "utf8");
  const ids = new IncrementingIdGenerator();
  const workspaces = new WorkspaceRegistry();
  const journal = new InMemoryEventJournal();
  const checkpoints = new CheckpointManager(new InMemoryCheckpointStore(), ids, workspaces);
  const diffs = new DiffManager(workspaces, checkpoints, ids, journal, new InMemoryDiffProposalStore());
  const workspaceRuntime = new WorkspaceRuntime(workspaces, diffs, checkpoints, journal);
  const [clientTransport, serverTransport] = createInMemoryTransportPair();
  const client = new TypedIpcClient(clientTransport);
  const server = new TypedIpcServer(serverTransport);
  const bridge = new WorkspaceRuntimeIpcBridge(workspaceRuntime, server);
  bridge.start();

  await client.request("workspace.register", {
    workspaceId: "workspace",
    rootPath: `${directory}/workspace`,
  }, { timeoutMs: 1_000 });
  const read = await client.request("workspace.read", {
    workspaceId: "workspace",
    path: "ipc.txt",
  }, { timeoutMs: 1_000 });
  assert.equal(read.content, "before");

  const proposal = await diffs.propose({
    sessionId: "session-ipc",
    workspaceId: "workspace",
    toolCallId: "call-ipc",
    changes: [{ path: "ipc.txt", afterContent: "after" }],
  });
  const accepted = await client.request("diff.accept", { proposalId: proposal.id }, { timeoutMs: 1_000 });
  assert.equal(accepted.status, "accepted");
  await client.request("checkpoint.restore", {
    checkpointId: accepted.checkpointId ?? "",
  }, { timeoutMs: 1_000 });
  assert.equal(await readFile(`${directory}/workspace/ipc.txt`, "utf8"), "before");

  bridge.dispose();
  client.dispose();
  server.dispose();
  await rm(directory, { recursive: true, force: true });
});

test("Diff 和 Checkpoint JSON Store 可以在进程重启后恢复", async () => {
  const directory = `/tmp/independent-ai-ide-phase4-store-${Date.now()}`;
  await rm(directory, { recursive: true, force: true });
  const ids = new IncrementingIdGenerator();
  const workspaces = new WorkspaceRegistry();
  const workspace = await WorkspaceService.create("workspace", `${directory}/workspace`);
  workspaces.register(workspace);
  await writeFile(`${workspace.root}/persist.txt`, "before", "utf8");
  const checkpointStore = new JsonCheckpointStore(`${directory}/checkpoints`);
  const checkpointManager = new CheckpointManager(checkpointStore, ids, workspaces);
  const diffStore = new JsonDiffProposalStore(`${directory}/diffs`);
  const manager = new DiffManager(
    workspaces,
    checkpointManager,
    ids,
    new InMemoryEventJournal(),
    diffStore,
  );
  const proposal = await manager.propose({
    sessionId: "session-store",
    workspaceId: "workspace",
    toolCallId: "call-store",
    changes: [{ path: "persist.txt", afterContent: "after" }],
  });
  await manager.accept(proposal.id);

  const restoredManager = new DiffManager(
    workspaces,
    checkpointManager,
    ids,
    new InMemoryEventJournal(),
    diffStore,
  );
  assert.equal((await restoredManager.restoreAll()).length, 1);
  assert.equal(restoredManager.get(proposal.id)?.status, "accepted");
  assert.equal((await checkpointStore.list("workspace")).length, 1);
  await rm(directory, { recursive: true, force: true });
});

test("Workbench Projector 可以重放 Diff 和 Checkpoint 事件", () => {
  let snapshot = projectWorkbenchSnapshot(EMPTY_WORKBENCH_SNAPSHOT, {
    type: "session.created",
    sessionId: "session-1",
  });
  snapshot = projectWorkbenchSnapshot(snapshot, {
    type: "diff.proposed",
    sessionId: "session-1",
    proposalId: "diff-1",
    affectedFiles: ["a.ts"],
  });
  snapshot = projectWorkbenchSnapshot(snapshot, {
    type: "checkpoint.created",
    sessionId: "session-1",
    checkpointId: "checkpoint-1",
    proposalId: "diff-1",
  });
  snapshot = projectWorkbenchSnapshot(snapshot, {
    type: "diff.resolved",
    sessionId: "session-1",
    proposalId: "diff-1",
    decision: "accepted",
    checkpointId: "checkpoint-1",
  });
  assert.equal(snapshot.diffProposals[0]?.status, "accepted");
  assert.equal(snapshot.checkpoints[0]?.checkpointId, "checkpoint-1");
});


test("工作区拒绝通过符号链接访问根目录外文件", async () => {
  const fixture = await createFixture("symlink");
  await mkdir(`${fixture.directory}/outside`, { recursive: true });
  await writeFile(`${fixture.directory}/outside/secret.txt`, "secret", "utf8");
  await symlink(`${fixture.directory}/outside`, `${fixture.workspace.root}/linked`, "dir");
  await assert.rejects(fixture.workspace.readText("linked/secret.txt"));
  await rm(fixture.directory, { recursive: true, force: true });
});

test("多文件 Diff 任一文件冲突时不会写入其他文件", async () => {
  const fixture = await createFixture("multi-conflict");
  await writeFile(`${fixture.workspace.root}/a.txt`, "a0", "utf8");
  await writeFile(`${fixture.workspace.root}/b.txt`, "b0", "utf8");
  const proposal = await fixture.diffs.propose({
    sessionId: "session-multi",
    workspaceId: "workspace",
    toolCallId: "call-multi",
    changes: [
      { path: "a.txt", afterContent: "a1" },
      { path: "b.txt", afterContent: "b1" },
    ],
  });
  await writeFile(`${fixture.workspace.root}/b.txt`, "user-b", "utf8");
  await assert.rejects(fixture.diffs.accept(proposal.id));
  assert.equal(await readFile(`${fixture.workspace.root}/a.txt`, "utf8"), "a0");
  assert.equal(await readFile(`${fixture.workspace.root}/b.txt`, "utf8"), "user-b");
  await rm(fixture.directory, { recursive: true, force: true });
});

test("Checkpoint 恢复前文件再次变化时拒绝覆盖用户新修改", async () => {
  const fixture = await createFixture("restore-conflict");
  await writeFile(`${fixture.workspace.root}/restore.txt`, "before", "utf8");
  const proposal = await executeTool(fixture, "Write", {
    path: "restore.txt",
    content: "after",
  }) as { id: string };
  const accepted = await fixture.diffs.accept(proposal.id);
  await writeFile(`${fixture.workspace.root}/restore.txt`, "user-after-accept", "utf8");
  await assert.rejects(fixture.workspaceRuntime.restoreCheckpoint(accepted.checkpointId ?? ""));
  assert.equal(await readFile(`${fixture.workspace.root}/restore.txt`, "utf8"), "user-after-accept");
  await rm(fixture.directory, { recursive: true, force: true });
});
