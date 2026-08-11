import test from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { IncrementingIdGenerator } from "../src/agent/id-generator.js";
import { AgentSession } from "../src/agent/session.js";
import { InMemoryEventJournal, JsonlEventJournal } from "../src/agent/event-journal.js";
import { PermissionCoordinator } from "../src/agent/permission-coordinator.js";
import { evaluatePermission } from "../src/permission-rules.js";
import type { ModelProvider, ModelRequest, ModelStreamEvent } from "../src/model/types.js";
import { OpenAICompatibleProvider } from "../src/model/openai-compatible-provider.js";
import { AgentRuntime } from "../src/runtime/agent-runtime.js";
import { AgentRuntimeIpcBridge } from "../src/runtime/ipc-bridge.js";
import { InMemorySessionStore, JsonSessionStore } from "../src/storage/session-store.js";
import { ToolRegistry, noToolPermissions, toolPermission, type Tool } from "../src/tool-runtime.js";
import { TypedIpcClient, TypedIpcServer } from "../src/ipc/channel.js";
import { createInMemoryTransportPair } from "../src/ipc/transport.js";

class ScriptedProvider implements ModelProvider {
  public readonly id = "scripted";
  private index = 0;

  public constructor(private readonly scripts: readonly (readonly ModelStreamEvent[])[]) {}

  public async *stream(_request: ModelRequest, _signal: AbortSignal): AsyncIterable<ModelStreamEvent> {
    const script = this.scripts[this.index++];
    if (script === undefined) {
      throw new Error("ScriptedProvider 没有更多响应");
    }
    for (const event of script) {
      yield event;
    }
  }
}

class WaitingProvider implements ModelProvider {
  public readonly id = "waiting";

  public async *stream(_request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelStreamEvent> {
    await new Promise<void>((resolve, reject) => {
      if (signal.aborted) {
        reject(new Error("aborted"));
        return;
      }
      signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
    yield { type: "text.delta", delta: "不会到达" };
  }
}

interface AddInput {
  readonly a: number;
  readonly b: number;
}

const addTool: Tool<AddInput, { readonly sum: number }> = {
  manifest: {
    name: "Add",
    version: "1.0.0",
    description: "计算两个数字之和",
    inputSchema: {
      type: "object",
      properties: {
        a: { type: "number" },
        b: { type: "number" },
      },
      required: ["a", "b"],
      additionalProperties: false,
    },
    riskLevel: "pure-compute",
    capabilities: [],
    generated: false,
  },
  validate(value: unknown): AddInput {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error("参数必须是对象");
    }
    const record = value as Record<string, unknown>;
    if (typeof record.a !== "number" || typeof record.b !== "number") {
      throw new Error("a 和 b 必须是数字");
    }
    return { a: record.a, b: record.b };
  },
  inspect: () => ({ affectedFiles: [], certifiedComputerApplication: false }),
  permissions: noToolPermissions,
  execute: async input => ({ sum: input.a + input.b }),
  serializeOutput: output => JSON.stringify(output),
};

function createWriteTool(onExecute: () => void): Tool<{ readonly content: string }, { readonly saved: true }> {
  return {
    manifest: {
      name: "WriteNote",
      version: "1.0.0",
      description: "写入一条测试笔记",
      inputSchema: {
        type: "object",
        properties: { content: { type: "string" } },
        required: ["content"],
        additionalProperties: false,
      },
      riskLevel: "workspace-write",
      capabilities: ["workspace.write"],
      generated: false,
    },
    validate(value: unknown) {
      if (typeof value !== "object" || value === null || Array.isArray(value)
        || typeof (value as Record<string, unknown>).content !== "string") {
        throw new Error("content 必须是字符串");
      }
      return { content: (value as { content: string }).content };
    },
    inspect: () => ({ affectedFiles: ["notes.txt"], certifiedComputerApplication: false }),
    permissions: input => toolPermission("edit", ["notes.txt"], { contentLength: input.content.length }),
    execute: async (_input, context) => {
      onExecute();
      await context.reportProgress("正在写入测试笔记");
      return { saved: true as const };
    },
    serializeOutput: output => JSON.stringify(output),
  };
}

function createRuntime(
  provider: ModelProvider,
  tools: readonly Tool<unknown, unknown>[] = [],
  options?: { readonly maxTurns?: number; readonly maxToolCalls?: number; readonly maxTotalTokens?: number },
): {
  readonly runtime: AgentRuntime;
  readonly journal: InMemoryEventJournal;
  readonly permissions: PermissionCoordinator;
} {
  const ids = new IncrementingIdGenerator();
  const registry = new ToolRegistry();
  for (const tool of tools) {
    registry.register(tool);
  }
  const journal = new InMemoryEventJournal();
  const permissions = new PermissionCoordinator(ids);
  return {
    journal,
    permissions,
    runtime: new AgentRuntime({
      provider,
      tools: registry,
      permissions,
      journal,
      sessions: new InMemorySessionStore(),
      idGenerator: ids,
    }, {
      systemPrompt: "你是独立 AI IDE 的测试 Agent。",
      maxOutputTokensPerTurn: 512,
      limits: {
        maxTurns: options?.maxTurns ?? 8,
        maxToolCalls: options?.maxToolCalls ?? 8,
        maxTotalTokens: options?.maxTotalTokens ?? 10_000,
      },
    }),
  };
}

function finalResponse(text: string, inputTokens = 5, outputTokens = 3): readonly ModelStreamEvent[] {
  return [
    { type: "text.delta", delta: text },
    {
      type: "response.completed",
      finishReason: "stop",
      usage: { inputTokens, outputTokens },
    },
  ];
}

function toolResponse(name: string, argumentsText: string): readonly ModelStreamEvent[] {
  return [
    { type: "tool-call.delta", index: 0, id: "call-1", name, argumentsDelta: argumentsText },
    {
      type: "response.completed",
      finishReason: "tool_calls",
      usage: { inputTokens: 8, outputTokens: 4 },
    },
  ];
}

test("AgentLoop 可以完成无工具的流式回答", async () => {
  const { runtime, journal } = createRuntime(new ScriptedProvider([finalResponse("你好") ]));
  const session = await runtime.createSession("workspace", "default");
  const { runId } = await runtime.startSession(session.id, "你好");
  const result = await runtime.waitForRun(runId);

  assert.equal(result.status, "completed");
  assert.equal(result.messages.length, 2);
  assert.equal(result.messages[1]?.role, "assistant");
  assert.equal(result.usage.inputTokens, 5);
  assert.ok((await journal.list(session.id)).some(entry => entry.event.type === "assistant.delta"));
});

test("AgentLoop 可以拼装 ToolCall、执行工具并把结果送回模型", async () => {
  const provider = new ScriptedProvider([
    [
      { type: "tool-call.delta", index: 0, id: "call-1", name: "Add", argumentsDelta: "{\"a\":2," },
      { type: "tool-call.delta", index: 0, argumentsDelta: "\"b\":3}" },
      { type: "response.completed", finishReason: "tool_calls", usage: { inputTokens: 8, outputTokens: 4 } },
    ],
    finalResponse("结果是 5"),
  ]);
  const { runtime } = createRuntime(provider, [addTool as Tool<unknown, unknown>]);
  const session = await runtime.createSession("workspace", "default");
  const { runId } = await runtime.startSession(session.id, "计算 2+3");
  const result = await runtime.waitForRun(runId);

  assert.equal(result.status, "completed");
  assert.equal(result.messages[2]?.role, "tool");
  assert.equal(result.messages[2]?.content, "{\"sum\":5}");
  assert.equal(result.messages[3]?.role, "assistant");
});

test("default 权限模式会等待用户明确批准写入工具", async () => {
  let executed = false;
  const provider = new ScriptedProvider([
    toolResponse("WriteNote", "{\"content\":\"hello\"}"),
    finalResponse("已写入"),
  ]);
  const writeTool = createWriteTool(() => { executed = true; });
  const { runtime } = createRuntime(provider, [writeTool as Tool<unknown, unknown>]);
  const observedEvents: string[] = [];
  runtime.onEvent(event => {
    observedEvents.push(event.type);
    if (event.type === "permission.requested") {
      assert.equal(runtime.resolvePermission(event.requestId, "once"), true);
    }
  });

  const session = await runtime.createSession("workspace", "default");
  const { runId } = await runtime.startSession(session.id, "写笔记");
  const result = await runtime.waitForRun(runId);

  assert.equal(result.status, "completed");
  assert.equal(executed, true);
  assert.ok(observedEvents.indexOf("tool.inspected") < observedEvents.indexOf("permission.requested"));
});

test("autoReview 会明确拒绝无法证明安全的写入工具", async () => {
  let executed = false;
  const provider = new ScriptedProvider([
    toolResponse("WriteNote", "{\"content\":\"hello\"}"),
    finalResponse("写入被拒绝"),
  ]);
  const writeTool = createWriteTool(() => { executed = true; });
  const { runtime } = createRuntime(provider, [writeTool as Tool<unknown, unknown>]);
  const session = await runtime.createSession("workspace", "autoReview");
  const { runId } = await runtime.startSession(session.id, "写笔记");
  const result = await runtime.waitForRun(runId);

  assert.equal(result.status, "completed");
  assert.equal(executed, false);
  const toolMessage = result.messages[2];
  assert.equal(toolMessage?.role, "tool");
  if (toolMessage?.role !== "tool") {
    throw new Error("预期第三条消息是 Tool Result");
  }
  assert.equal(toolMessage.isError, true);
});

test("Token 预算超限会明确失败", async () => {
  const { runtime } = createRuntime(
    new ScriptedProvider([finalResponse("过长", 50, 50)]),
    [],
    { maxTotalTokens: 10 },
  );
  const session = await runtime.createSession("workspace", "default");
  const { runId } = await runtime.startSession(session.id, "测试预算");
  const result = await runtime.waitForRun(runId);

  assert.equal(result.status, "failed");
  assert.equal(result.lastError?.code, "TOKEN_BUDGET_EXCEEDED");
});

test("达到最大轮次会明确失败", async () => {
  const provider = new ScriptedProvider([
    toolResponse("Add", "{\"a\":1,\"b\":1}"),
    toolResponse("Add", "{\"a\":2,\"b\":2}"),
  ]);
  const { runtime } = createRuntime(
    provider,
    [addTool as Tool<unknown, unknown>],
    { maxTurns: 2 },
  );
  const session = await runtime.createSession("workspace", "default");
  const { runId } = await runtime.startSession(session.id, "一直调用工具");
  const result = await runtime.waitForRun(runId);

  assert.equal(result.status, "failed");
  assert.equal(result.lastError?.code, "MAX_TURNS_EXCEEDED");
});

test("运行可以通过 AbortController 终止", async () => {
  const { runtime } = createRuntime(new WaitingProvider());
  const session = await runtime.createSession("workspace", "default");
  const { runId } = await runtime.startSession(session.id, "等待");
  assert.equal(runtime.abortSession(session.id), true);
  const result = await runtime.waitForRun(runId);
  assert.equal(result.status, "aborted");
});

test("OpenAICompatibleProvider 可以解析 Chat Completions SSE 工具调用", async () => {
  let requestedUrl = "";
  let requestedBody: Record<string, unknown> | undefined;
  const sse = [
    `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call-1", function: { name: "Add", arguments: "{\"a\":1" } }] }, finish_reason: null }] })}`,
    `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ",\"b\":2}" } }] }, finish_reason: "tool_calls" }] })}`,
    `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 7, completion_tokens: 3 } })}`,
    "data: [DONE]",
    "",
  ].join("\n\n");

  const provider = new OpenAICompatibleProvider({
    baseUrl: "http://localhost:1234/v1",
    chatCompletionsPath: "/chat/completions",
    apiKeyReference: "credential/local-model",
    model: "test-model",
  }, {
    credentialResolver: { resolve: async () => "test-key-reference-value" },
    fetchImplementation: async (input, init) => {
      requestedUrl = String(input);
      requestedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(sse));
          controller.close();
        },
      });
      return new Response(stream, { status: 200 });
    },
  });

  const events: ModelStreamEvent[] = [];
  for await (const event of provider.stream({
    systemPrompt: "test",
    messages: [],
    tools: [],
    maxOutputTokens: 128,
  }, new AbortController().signal)) {
    events.push(event);
  }

  assert.equal(requestedUrl, "http://localhost:1234/v1/chat/completions");
  assert.equal(requestedBody?.stream, true);
  assert.equal(events.filter(event => event.type === "tool-call.delta").length, 2);
  assert.equal(events.at(-1)?.type, "response.completed");
});

test("会话和事件可以写入 JSON 文件后恢复", async () => {
  const directory = `/tmp/independent-ai-ide-phase3-${Date.now()}`;
  await rm(directory, { recursive: true, force: true });
  const store = new JsonSessionStore(`${directory}/sessions`);
  const journal = new JsonlEventJournal(`${directory}/events.jsonl`);
  const { runtime: baseRuntime } = createRuntime(new ScriptedProvider([finalResponse("保存") ]));
  const snapshot = await baseRuntime.createSession("workspace", "default");
  await store.save(snapshot);
  await journal.append({ type: "session.created", sessionId: snapshot.id, workspaceId: "workspace" });

  assert.equal((await store.load(snapshot.id))?.id, snapshot.id);
  assert.equal((await journal.list(snapshot.id)).length, 1);
  await rm(directory, { recursive: true, force: true });
});

test("Typed IPC 可以创建、启动并读取 Agent 会话", async () => {
  const { runtime } = createRuntime(new ScriptedProvider([finalResponse("IPC 完成") ]));
  const [clientTransport, serverTransport] = createInMemoryTransportPair();
  const server = new TypedIpcServer(serverTransport);
  const client = new TypedIpcClient(clientTransport);
  const bridge = new AgentRuntimeIpcBridge(runtime, server, "default");
  bridge.start();

  const created = await client.request("session.create", { workspaceId: "workspace" }, { timeoutMs: 1_000 });
  const started = await client.request("session.start", {
    sessionId: created.sessionId,
    input: "通过 IPC 运行",
  }, { timeoutMs: 1_000 });
  await runtime.waitForRun(started.runId);
  const snapshot = await client.request("session.get", {
    sessionId: created.sessionId,
  }, { timeoutMs: 1_000 });

  assert.equal(snapshot.status, "completed");
  bridge.dispose();
  client.dispose();
  server.dispose();
});


test("JSONL 事件日志并发写入仍保持唯一递增序号", async () => {
  const directory = `/tmp/independent-ai-ide-journal-${Date.now()}`;
  await rm(directory, { recursive: true, force: true });
  const journal = new JsonlEventJournal(`${directory}/events.jsonl`);
  await Promise.all(Array.from({ length: 40 }, (_, index) =>
    journal.append({ type: "session.created", sessionId: `session-${index}` })));
  const entries = await journal.list();
  assert.deepEqual(entries.map(entry => entry.sequence), Array.from({ length: 40 }, (_, index) => index + 1));
  await rm(directory, { recursive: true, force: true });
});

test("恢复时会把失去执行进程的 running 会话标记为失败", async () => {
  const store = new InMemorySessionStore();
  const interrupted = new AgentSession("session-interrupted", "workspace", "default");
  interrupted.start("run-lost");
  await store.save(interrupted.snapshot());

  const ids = new IncrementingIdGenerator();
  const runtime = new AgentRuntime({
    provider: new ScriptedProvider([]),
    tools: new ToolRegistry(),
    permissions: new PermissionCoordinator(ids),
    journal: new InMemoryEventJournal(),
    sessions: store,
    idGenerator: ids,
  }, {
    systemPrompt: "test",
    maxOutputTokensPerTurn: 64,
    limits: { maxTurns: 2, maxToolCalls: 2, maxTotalTokens: 100 },
  });

  const restored = await runtime.restoreAll();
  assert.equal(restored[0]?.status, "failed");
  assert.equal(restored[0]?.lastError?.code, "INTERRUPTED_RUN_RECOVERED");
});

test("OpenCode permission 规则使用最后匹配且默认 ask", () => {
  const rules = [
    { permission: "bash", pattern: "*", action: "ask" as const },
    { permission: "bash", pattern: "git *", action: "allow" as const },
    { permission: "bash", pattern: "git push *", action: "deny" as const },
  ];
  assert.equal(evaluatePermission("bash", "git status", rules).action, "allow");
  assert.equal(evaluatePermission("bash", "git", rules).action, "allow");
  assert.equal(evaluatePermission("bash", "git push origin main", rules).action, "deny");
  assert.equal(evaluatePermission("read", "src\\agent\\session.ts", [{ permission: "read", pattern: "src/agent/*", action: "allow" }]).action, "allow");
  assert.equal(evaluatePermission("webfetch", "https://example.com", rules).action, "ask");
});

test("OpenCode always 会自动放行同会话中匹配的 pending 权限", async () => {
  const coordinator = new PermissionCoordinator(new IncrementingIdGenerator());
  const session = new AgentSession("permission-session", "workspace", "default");
  session.start("run");
  const events: import("../src/agent-protocol.js").AgentEvent[] = [];
  const emit = async (event: import("../src/agent-protocol.js").AgentEvent): Promise<void> => { events.push(event); };
  const manifest = { name: "Bash", version: "1.0.0", riskLevel: "process" as const, capabilities: [] as const, generated: false };
  const inspection = { affectedFiles: [] as const, certifiedComputerApplication: false };
  const signal = new AbortController().signal;
  const first = coordinator.authorize(session, "tool-1", manifest, inspection, [{ permission: "bash", patterns: ["git status"], always: ["git *"], metadata: {} }], emit, signal);
  const second = coordinator.authorize(session, "tool-2", manifest, inspection, [{ permission: "bash", patterns: ["git diff"], always: ["git *"], metadata: {} }], emit, signal);
  await waitFor(() => events.filter(event => event.type === "permission.requested").length === 2);
  const request = events.find(event => event.type === "permission.requested");
  assert.equal(request?.type, "permission.requested");
  if (request?.type !== "permission.requested") throw new Error("permission request missing");
  assert.equal(coordinator.reply(request.requestId, "always"), true);
  assert.deepEqual(await Promise.all([first, second]), ["allow", "allow"]);
  const resolved = events.filter(event => event.type === "permission.resolved");
  assert.equal(resolved.length, 2);
  assert.equal(resolved.every(event => event.type === "permission.resolved" && event.reply === "always"), true);
});

test("OpenCode reject 会拒绝同会话全部 pending 权限", async () => {
  const coordinator = new PermissionCoordinator(new IncrementingIdGenerator());
  const session = new AgentSession("reject-session", "workspace", "default");
  session.start("run");
  const events: import("../src/agent-protocol.js").AgentEvent[] = [];
  const emit = async (event: import("../src/agent-protocol.js").AgentEvent): Promise<void> => { events.push(event); };
  const manifest = { name: "Bash", version: "1.0.0", riskLevel: "process" as const, capabilities: [] as const, generated: false };
  const inspection = { affectedFiles: [] as const, certifiedComputerApplication: false };
  const signal = new AbortController().signal;
  const first = coordinator.authorize(session, "tool-r1", manifest, inspection, [{ permission: "bash", patterns: ["npm test"], always: ["npm *"], metadata: {} }], emit, signal);
  const second = coordinator.authorize(session, "tool-r2", manifest, inspection, [{ permission: "bash", patterns: ["npm run build"], always: ["npm *"], metadata: {} }], emit, signal);
  await waitFor(() => events.filter(event => event.type === "permission.requested").length === 2);
  const request = events.find(event => event.type === "permission.requested");
  if (request?.type !== "permission.requested") throw new Error("permission request missing");
  assert.equal(coordinator.reply(request.requestId, "reject"), true);
  assert.deepEqual(await Promise.all([first, second]), ["deny", "deny"]);
  const resolved = events.filter(event => event.type === "permission.resolved");
  assert.equal(resolved.length, 2);
  assert.equal(resolved.every(event => event.type === "permission.resolved" && event.reply === "reject"), true);
});


test("OpenCode always 规则只绑定当前 Session，不能泄漏到其他会话", async () => {
  const coordinator = new PermissionCoordinator(new IncrementingIdGenerator());
  const firstSession = new AgentSession("permission-scope-1", "workspace", "default");
  const secondSession = new AgentSession("permission-scope-2", "workspace", "default");
  firstSession.start("run-1");
  secondSession.start("run-2");
  const events: import("../src/agent-protocol.js").AgentEvent[] = [];
  const emit = async (event: import("../src/agent-protocol.js").AgentEvent): Promise<void> => { events.push(event); };
  const manifest = { name: "bash", version: "1.0.0", riskLevel: "process" as const, capabilities: [] as const, generated: false };
  const inspection = { affectedFiles: [] as const, certifiedComputerApplication: false };
  const signal = new AbortController().signal;

  const first = coordinator.authorize(firstSession, "tool-scope-1", manifest, inspection, [{ permission: "bash", patterns: ["git status"], always: ["git *"], metadata: {} }], emit, signal);
  await waitFor(() => events.some(event => event.type === "permission.requested" && event.sessionId === firstSession.id));
  const firstRequest = events.find(event => event.type === "permission.requested" && event.sessionId === firstSession.id);
  if (firstRequest?.type !== "permission.requested") throw new Error("first permission request missing");
  coordinator.reply(firstRequest.requestId, "always");
  assert.equal(await first, "allow");

  const second = coordinator.authorize(secondSession, "tool-scope-2", manifest, inspection, [{ permission: "bash", patterns: ["git status"], always: ["git *"], metadata: {} }], emit, signal);
  await waitFor(() => events.some(event => event.type === "permission.requested" && event.sessionId === secondSession.id));
  const secondRequest = events.find(event => event.type === "permission.requested" && event.sessionId === secondSession.id);
  if (secondRequest?.type !== "permission.requested") throw new Error("second permission request missing");
  coordinator.reply(secondRequest.requestId, "once");
  assert.equal(await second, "allow");
});

test("OpenCode always 规则随 Session snapshot 持久化并在恢复后继续生效", async () => {
  const ids = new IncrementingIdGenerator();
  const coordinator = new PermissionCoordinator(ids);
  const session = new AgentSession("permission-persist", "workspace", "default");
  session.start("run-1");
  const events: import("../src/agent-protocol.js").AgentEvent[] = [];
  const emit = async (event: import("../src/agent-protocol.js").AgentEvent): Promise<void> => { events.push(event); };
  const manifest = { name: "bash", version: "1.0.0", riskLevel: "process" as const, capabilities: [] as const, generated: false };
  const inspection = { affectedFiles: [] as const, certifiedComputerApplication: false };
  const signal = new AbortController().signal;

  const first = coordinator.authorize(session, "tool-persist-1", manifest, inspection, [{ permission: "bash", patterns: ["git status"], always: ["git *"], metadata: {} }], emit, signal);
  await waitFor(() => events.some(event => event.type === "permission.requested"));
  const request = events.find(event => event.type === "permission.requested");
  if (request?.type !== "permission.requested") throw new Error("permission request missing");
  coordinator.reply(request.requestId, "always");
  assert.equal(await first, "allow");

  session.complete();
  const restored = AgentSession.restore(session.snapshot());
  restored.start("run-2");
  const restoredEvents: import("../src/agent-protocol.js").AgentEvent[] = [];
  const result = await new PermissionCoordinator(new IncrementingIdGenerator()).authorize(
    restored,
    "tool-persist-2",
    manifest,
    inspection,
    [{ permission: "bash", patterns: ["git diff"], always: ["git *"], metadata: {} }],
    async event => { restoredEvents.push(event); },
    new AbortController().signal,
  );
  assert.equal(result, "allow");
  assert.equal(restoredEvents.some(event => event.type === "permission.requested"), false);
});

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  throw new Error("等待测试条件超时");
}
