import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { IncrementingIdGenerator } from "../src/agent/id-generator.js";
import { InMemoryEventJournal } from "../src/agent/event-journal.js";
import { PermissionCoordinator } from "../src/agent/permission-coordinator.js";
import type { ModelProvider, ModelRequest, ModelStreamEvent } from "../src/model/types.js";
import { PlanManager } from "../src/plan/plan-manager.js";
import { AgentRuntime } from "../src/runtime/agent-runtime.js";
import { AgentRuntimeIpcBridge } from "../src/runtime/ipc-bridge.js";
import { PlanRuntimeIpcBridge } from "../src/runtime/plan-ipc-bridge.js";
import { WorkbenchRuntimeIpcBridge } from "../src/runtime/workbench-ipc-bridge.js";
import { WorkbenchRuntime } from "../src/runtime/workbench-runtime.js";
import { InMemorySessionStore } from "../src/storage/session-store.js";
import { ToolRegistry } from "../src/tool-runtime.js";
import { TypedIpcClient, TypedIpcServer } from "../src/ipc/channel.js";
import { createInMemoryTransportPair } from "../src/ipc/transport.js";
import { isIpcMessage } from "../src/ipc/validation.js";
import {
  EMPTY_WORKBENCH_SNAPSHOT,
  projectWorkbenchSnapshot,
} from "../src/workbench/workbench-state.js";
import { WorkbenchController } from "../src/workbench/workbench-controller.js";

class ScriptedProvider implements ModelProvider {
  public readonly id = "phase6-scripted";
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

function finalResponse(...parts: string[]): readonly ModelStreamEvent[] {
  return [
    ...parts.map(delta => ({ type: "text.delta" as const, delta })),
    {
      type: "response.completed" as const,
      finishReason: "stop" as const,
      usage: { inputTokens: 5, outputTokens: 3 },
    },
  ];
}

function createAgentRuntime(provider: ModelProvider): {
  readonly runtime: AgentRuntime;
  readonly journal: InMemoryEventJournal;
} {
  const ids = new IncrementingIdGenerator();
  const journal = new InMemoryEventJournal();
  return {
    journal,
    runtime: new AgentRuntime({
      provider,
      tools: new ToolRegistry(),
      permissions: new PermissionCoordinator(ids),
      journal,
      sessions: new InMemorySessionStore(),
      idGenerator: ids,
    }, {
      systemPrompt: "你是 Phase 6 测试 Agent。",
      maxOutputTokensPerTurn: 256,
      limits: { maxTurns: 4, maxToolCalls: 4, maxTotalTokens: 1_000 },
    }),
  };
}

function richSnapshot() {
  let snapshot = projectWorkbenchSnapshot(EMPTY_WORKBENCH_SNAPSHOT, {
    type: "session.created",
    sessionId: "session-1",
    workspaceId: "workspace",
  });
  snapshot = projectWorkbenchSnapshot(snapshot, {
    type: "session.started",
    sessionId: "session-1",
    runId: "run-1",
  });
  snapshot = projectWorkbenchSnapshot(snapshot, {
    type: "user.message.added",
    sessionId: "session-1",
    messageId: "user-1",
    content: "修改应用",
  });
  snapshot = projectWorkbenchSnapshot(snapshot, {
    type: "assistant.started",
    sessionId: "session-1",
    messageId: "assistant-1",
    turn: 1,
  });
  snapshot = projectWorkbenchSnapshot(snapshot, {
    type: "assistant.delta",
    sessionId: "session-1",
    messageId: "assistant-1",
    delta: "正在分析",
  });
  snapshot = projectWorkbenchSnapshot(snapshot, {
    type: "assistant.completed",
    sessionId: "session-1",
    messageId: "assistant-1",
  });
  snapshot = projectWorkbenchSnapshot(snapshot, {
    type: "session.usage.updated",
    sessionId: "session-1",
    inputTokens: 10,
    outputTokens: 6,
  });
  return snapshot;
}

test("Workbench Projector 恢复流式 Chat、Token 和 Tool 卡片", () => {
  let snapshot = richSnapshot();
  snapshot = projectWorkbenchSnapshot(snapshot, {
    type: "tool.requested",
    sessionId: "session-1",
    toolCallId: "call-1",
    toolName: "PowerShell",
    description: "运行测试",
    riskLevel: "process",
    capabilities: ["process.execute"],
  });
  snapshot = projectWorkbenchSnapshot(snapshot, {
    type: "tool.inspected",
    sessionId: "session-1",
    toolCallId: "call-1",
    toolName: "PowerShell",
    riskLevel: "process",
    affectedFiles: ["src/app.ts"],
    networkTargets: [],
    commands: ["npm test"],
  });
  snapshot = projectWorkbenchSnapshot(snapshot, {
    type: "tool.started",
    sessionId: "session-1",
    toolName: "PowerShell",
    toolCallId: "call-1",
  });
  snapshot = projectWorkbenchSnapshot(snapshot, {
    type: "tool.progress",
    sessionId: "session-1",
    toolName: "PowerShell",
    toolCallId: "call-1",
    message: "正在运行测试",
  });

  assert.equal(snapshot.chatMessages[1]?.content, "正在分析");
  assert.equal(snapshot.chatMessages[1]?.state, "completed");
  assert.deepEqual(snapshot.usage, { inputTokens: 10, outputTokens: 6 });
  assert.equal(snapshot.tools[0]?.state, "running");
  assert.deepEqual(snapshot.tools[0]?.affectedFiles, ["src/app.ts"]);
  assert.deepEqual(snapshot.tools[0]?.progressMessages, ["正在运行测试"]);
});

test("PlanManager 执行审核状态机并从事件恢复原始时间", async () => {
  const journal = new InMemoryEventJournal();
  const manager = new PlanManager(new IncrementingIdGenerator(), journal);
  const plan = await manager.create({
    sessionId: "session-1",
    title: "实现交互层",
    summary: "接入 Chat、权限和 Diff Review",
    confidence: 93,
    affectedFiles: ["src/ui.ts"],
    steps: [{
      title: "实现 UI",
      description: "创建 Workbench Controller",
      affectedFiles: ["src/ui.ts"],
      capabilities: ["workspace.propose"],
    }],
  });
  const approved = await manager.resolve(plan.id, "approved");
  await manager.markExecuting(plan.id);
  const completed = await manager.markCompleted(plan.id);

  assert.equal(approved.status, "approved");
  assert.equal(completed.status, "completed");
  await assert.rejects(manager.resolve(plan.id, "rejected"));

  const restored = new PlanManager(new IncrementingIdGenerator(), journal);
  const records = restored.restoreFromEvents((await journal.list()).map(entry => entry.event));
  assert.equal(records[0]?.status, "completed");
  assert.equal(records[0]?.createdAt, plan.createdAt);
  assert.equal(records[0]?.updatedAt, completed.updatedAt);
});

test("WorkbenchRuntime 隔离多个会话并可从事件日志恢复", async () => {
  const journal = new InMemoryEventJournal();
  const runtime = new WorkbenchRuntime(journal);
  const events = [
    { type: "session.created", sessionId: "session-a", workspaceId: "workspace" } as const,
    { type: "user.message.added", sessionId: "session-a", messageId: "a-user", content: "A" } as const,
    { type: "session.created", sessionId: "session-b", workspaceId: "workspace" } as const,
    { type: "user.message.added", sessionId: "session-b", messageId: "b-user", content: "B" } as const,
  ];
  for (const event of events) {
    await journal.append(event);
    await runtime.handleEvent(event);
  }

  assert.equal(runtime.getSnapshot("session-a").chatMessages[0]?.content, "A");
  assert.equal(runtime.getSnapshot("session-b").chatMessages[0]?.content, "B");

  const restored = new WorkbenchRuntime(journal);
  await restored.restore("session-a");
  assert.equal(restored.getSnapshot("session-a").chatMessages[0]?.content, "A");
});

test("Agent Runtime IPC 支持会话列表、时间线和新会话 Retry", async () => {
  const { runtime } = createAgentRuntime(new ScriptedProvider([
    finalResponse("第一次"),
    finalResponse("第二次"),
  ]));
  const [clientTransport, serverTransport] = createInMemoryTransportPair();
  const client = new TypedIpcClient(clientTransport);
  const server = new TypedIpcServer(serverTransport);
  const bridge = new AgentRuntimeIpcBridge(runtime, server, "default");
  bridge.start();

  const created = await client.request("session.create", { workspaceId: "workspace" }, { timeoutMs: 1_000 });
  const started = await client.request("session.start", {
    sessionId: created.sessionId,
    input: "执行任务",
  }, { timeoutMs: 1_000 });
  await runtime.waitForRun(started.runId);

  const sessions = await client.request("session.list", { workspaceId: "workspace" }, { timeoutMs: 1_000 });
  const events = await client.request("session.events", { sessionId: created.sessionId }, { timeoutMs: 1_000 });
  const retried = await client.request("session.retry", { sessionId: created.sessionId }, { timeoutMs: 1_000 });
  await runtime.waitForRun(retried.runId);

  assert.equal(sessions.sessions.length, 1);
  assert.ok(events.entries.some(entry => entry.event.type === "user.message.added"));
  assert.ok(retried.sessionId !== created.sessionId);

  bridge.dispose();
  client.dispose();
  server.dispose();
});

test("WorkbenchController 的权限、Plan、Diff 和 Checkpoint 操作全部经过 Typed IPC", async () => {
  const [clientTransport, serverTransport] = createInMemoryTransportPair();
  const client = new TypedIpcClient(clientTransport);
  const server = new TypedIpcServer(serverTransport);
  const calls: string[] = [];
  const snapshot = richSnapshot();

  server.registerHandler("workbench.getSnapshot", () => snapshot);
  server.registerHandler("session.list", () => ({ sessions: [] }));
  server.registerHandler("session.events", () => ({ entries: [] }));
  server.registerHandler("permission.resolve", request => {
    calls.push(`permission:${request.reply}`);
    return { accepted: true };
  });
  server.registerHandler("plan.resolve", request => {
    calls.push(`plan:${request.decision}`);
    return {
      id: request.planId,
      sessionId: "session-1",
      title: "计划",
      summary: "说明",
      confidence: 90,
      affectedFiles: [],
      steps: [{ id: "step", title: "步骤", description: "说明", affectedFiles: [], capabilities: [] }],
      status: request.decision,
      createdAt: "2026-07-26T00:00:00.000Z",
      updatedAt: "2026-07-26T00:00:01.000Z",
    };
  });
  server.registerHandler("diff.accept", request => {
    calls.push("diff:accept");
    return fakeDiff(request.proposalId, "accepted");
  });
  server.registerHandler("diff.reject", request => {
    calls.push("diff:reject");
    return fakeDiff(request.proposalId, "rejected");
  });
  server.registerHandler("checkpoint.restore", request => {
    calls.push("checkpoint:restore");
    return fakeCheckpoint(request.checkpointId);
  });

  const controller = new WorkbenchController(client, 1_000);
  controller.start();
  await controller.refresh("session-1");
  await controller.resolvePermission("permission-1", "once");
  await controller.resolvePlan("plan-1", "approved");
  await controller.acceptDiff("diff-1");
  await controller.rejectDiff("diff-2");
  await controller.restoreCheckpoint("checkpoint-1");

  assert.deepEqual(calls, [
    "permission:once",
    "plan:approved",
    "diff:accept",
    "diff:reject",
    "checkpoint:restore",
  ]);
  controller.dispose();
  client.dispose();
  server.dispose();
});

test("Workbench Runtime 与 Agent 事件连接后可以实时恢复完整 Chat", async () => {
  const { runtime, journal } = createAgentRuntime(new ScriptedProvider([finalResponse("你", "好") ]));
  const workbench = new WorkbenchRuntime(journal);
  runtime.onEvent(async event => { await workbench.handleEvent(event); });
  const snapshots: string[] = [];
  workbench.onSnapshot(snapshot => {
    snapshots.push(snapshot.chatMessages.at(-1)?.content ?? "");
  });

  const session = await runtime.createSession("workspace", "default");
  const started = await runtime.startSession(session.id, "你好");
  await runtime.waitForRun(started.runId);

  const final = workbench.getSnapshot(session.id);
  assert.equal(final.chatMessages[1]?.content, "你好");
  assert.equal(final.sessionStatus, "completed");
  assert.ok(snapshots.includes("你"));
});

test("Plan 与 Workbench IPC Bridge 发布审核状态和 Snapshot", async () => {
  const journal = new InMemoryEventJournal();
  const plans = new PlanManager(new IncrementingIdGenerator(), journal);
  const workbench = new WorkbenchRuntime(journal);
  plans.onEvent(async event => { await workbench.handleEvent(event); });
  const [clientTransport, serverTransport] = createInMemoryTransportPair();
  const client = new TypedIpcClient(clientTransport);
  const server = new TypedIpcServer(serverTransport);
  const planBridge = new PlanRuntimeIpcBridge(plans, server);
  const workbenchBridge = new WorkbenchRuntimeIpcBridge(workbench, server);
  planBridge.start();
  workbenchBridge.start();

  await workbench.handleEvent({ type: "session.created", sessionId: "session-1", workspaceId: "workspace" });
  const plan = await plans.create({
    sessionId: "session-1",
    title: "计划",
    summary: "说明",
    confidence: 94,
    affectedFiles: [],
    steps: [{ title: "步骤", description: "说明" }],
  });
  const approved = await client.request("plan.resolve", {
    planId: plan.id,
    decision: "approved",
  }, { timeoutMs: 1_000 });
  const snapshot = await client.request("workbench.getSnapshot", {
    sessionId: "session-1",
  }, { timeoutMs: 1_000 });

  assert.equal(approved.status, "approved");
  assert.equal(snapshot.plans[0]?.status, "approved");
  planBridge.dispose();
  workbenchBridge.dispose();
  client.dispose();
  server.dispose();
});

test("IPC 边界拒绝缺少风险和影响文件的权限事件", () => {
  assert.equal(isIpcMessage({
    kind: "event",
    method: "agent.event",
    payload: {
      type: "permission.requested",
      sessionId: "session-1",
      requestId: "permission-1",
      capabilities: ["workspace.write"],
    },
  }), false);
});

test("Code OSS 交互视图不直接导入文件系统或进程模块", async () => {
  const view = await readFile(
    "overlays/code-oss/src/vs/workbench/contrib/independentAiIde/browser/independentAiIdeView.ts",
    "utf8",
  );
  const bridge = await readFile(
    "overlays/code-oss/src/vs/workbench/contrib/independentAiIde/common/independentAiIdeWorkbenchBridge.ts",
    "utf8",
  );
  assert.equal(/node:fs|node:child_process|spawn\(|exec\(/.test(view), false);
  assert.equal(/node:fs|node:child_process|spawn\(|exec\(/.test(bridge), false);
  assert.match(view, /resolvePermission/);
  assert.match(view, /acceptDiff/);
  assert.match(view, /sendInput/);
});

function fakeDiff(id: string, status: "accepted" | "rejected") {
  return {
    id,
    sessionId: "session-1",
    workspaceId: "workspace",
    toolCallId: "call-1",
    createdAt: "2026-07-26T00:00:00.000Z",
    status,
    changes: [{
      path: "src/app.ts",
      before: {
        path: "src/app.ts",
        exists: true,
        content: "old",
        sha256: "a".repeat(64),
        byteLength: 3,
      },
      afterContent: "new",
      afterSha256: "b".repeat(64),
      unifiedDiff: "--- a/src/app.ts\n+++ b/src/app.ts",
    }],
  } as const;
}

function fakeCheckpoint(id: string) {
  return {
    id,
    workspaceId: "workspace",
    sessionId: "session-1",
    proposalId: "diff-1",
    createdAt: "2026-07-26T00:00:00.000Z",
    status: "restored" as const,
    files: [{
      path: "src/app.ts",
      before: {
        path: "src/app.ts",
        exists: true,
        content: "old",
        sha256: "a".repeat(64),
        byteLength: 3,
      },
      expectedAfterSha256: "b".repeat(64),
      afterContent: "new",
    }],
  };
}
