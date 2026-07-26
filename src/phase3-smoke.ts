import { IncrementingIdGenerator } from "./agent/id-generator.js";
import { InMemoryEventJournal } from "./agent/event-journal.js";
import { PermissionCoordinator } from "./agent/permission-coordinator.js";
import type { ModelProvider, ModelStreamEvent } from "./model/types.js";
import { AgentRuntime } from "./runtime/agent-runtime.js";
import { InMemorySessionStore } from "./storage/session-store.js";
import { ToolRegistry } from "./tool-runtime.js";

const provider: ModelProvider = {
  id: "phase3-smoke-provider",
  async *stream(): AsyncIterable<ModelStreamEvent> {
    yield { type: "text.delta", delta: "Phase 3 Agent Core ready" };
    yield {
      type: "response.completed",
      finishReason: "stop",
      usage: { inputTokens: 4, outputTokens: 5 },
    };
  },
};

const ids = new IncrementingIdGenerator();
const runtime = new AgentRuntime({
  provider,
  tools: new ToolRegistry(),
  permissions: new PermissionCoordinator(ids),
  journal: new InMemoryEventJournal(),
  sessions: new InMemorySessionStore(),
  idGenerator: ids,
}, {
  systemPrompt: "你是独立 AI IDE 的 Agent Runtime。",
  maxOutputTokensPerTurn: 256,
  limits: { maxTurns: 4, maxToolCalls: 4, maxTotalTokens: 1_000 },
});

const session = await runtime.createSession("phase3-smoke", "default");
const { runId } = await runtime.startSession(session.id, "执行 Smoke Test");
const result = await runtime.waitForRun(runId);
if (result.status !== "completed") {
  throw new Error(`Phase 3 Smoke Test 失败：${result.status}`);
}
console.log("Phase 3 Smoke Test 通过");
