import { validateSubagentTaskRequest } from "./subagent/policy.js";

validateSubagentTaskRequest({
  parentSessionId: "smoke-parent",
  role: "implementer",
  instruction: "验证子 Agent 策略",
  depth: 1,
  baseWorkspaceId: "workspace",
  allowedPaths: ["src"],
  writablePaths: ["src"],
  allowedCapabilities: ["workspace.read", "workspace.write"],
  budget: {
    maxTurns: 4,
    maxToolCalls: 4,
    maxTotalTokens: 1_000,
    maxDurationMs: 60_000,
  },
});

console.log("AI IDE Phase 8 Smoke Test 通过");
