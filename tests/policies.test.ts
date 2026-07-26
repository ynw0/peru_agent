import test from "node:test";
import assert from "node:assert/strict";
import { isComputerInteractionAllowed } from "../src/computer-use.js";
import { validateCompletionCapability } from "../src/completion-engine.js";
import { isNetworkTargetAllowed } from "../src/network-policy.js";
import { decidePermission } from "../src/permission-engine.js";
import { canAutoPromoteSkill } from "../src/self-evolution.js";
import { validateSubagentAssignment } from "../src/subagent-runtime.js";
import { canAutoPromoteTool } from "../src/tool-runtime.js";

test("高权限 Tool 不允许自动晋级", () => {
  const decision = canAutoPromoteTool({
    name: "GeneratedProcessTool",
    version: "1.0.0",
    generated: true,
    riskLevel: "process",
    capabilities: ["process.execute"],
  });
  assert.equal(decision.allowed, false);
});

test("严格只读 Tool 可以进入自动晋级流程", () => {
  const decision = canAutoPromoteTool({
    name: "GeneratedReadTool",
    version: "1.0.0",
    generated: true,
    riskLevel: "workspace-read",
    capabilities: ["workspace.read"],
  });
  assert.equal(decision.allowed, true);
});

test("包含高权限 Tool 的 Skill 不允许自动晋级", () => {
  const allowed = canAutoPromoteSkill({
    name: "ModifyAndTest",
    toolManifests: [{
      name: "GeneratedWriteTool",
      version: "1.0.0",
      generated: true,
      riskLevel: "workspace-write",
      capabilities: ["workspace.write"],
    }],
  });
  assert.equal(allowed, false);
});

test("未认证应用不能执行 Computer Use 交互", () => {
  const allowed = isComputerInteractionAllowed(
    { executableName: "unknown.exe", publisher: "Unknown", version: "1.0" },
    [],
  );
  assert.equal(allowed, false);
  assert.equal(decidePermission("fullAccess", "computer.interact", false), "deny");
});

test("认证应用可以进入 Computer Use 权限流程", () => {
  const allowed = isComputerInteractionAllowed(
    { executableName: "notepad.exe", publisher: "Microsoft Corporation", version: "11.1" },
    [{
      id: "notepad",
      executableName: "notepad.exe",
      publisher: "Microsoft Corporation",
      supportedVersionPattern: /^11\./,
      interactive: true,
    }],
  );
  assert.equal(allowed, true);
});

test("offline 模式只允许 Loopback", () => {
  assert.equal(isNetworkTargetAllowed("offline", {
    hostname: "localhost",
    resolvedAddresses: ["127.0.0.1", "::1"],
  }), true);
  assert.equal(isNetworkTargetAllowed("offline", {
    hostname: "example.com",
    resolvedAddresses: ["93.184.216.34"],
  }), false);
});

test("lan 模式拒绝公网地址", () => {
  assert.equal(isNetworkTargetAllowed("lan", {
    hostname: "internal.example",
    resolvedAddresses: ["192.168.1.10"],
  }), true);
  assert.equal(isNetworkTargetAllowed("lan", {
    hostname: "public.example",
    resolvedAddresses: ["8.8.8.8"],
  }), false);
});

test("补全模型必须支持 FIM、流式和取消", () => {
  assert.throws(() => validateCompletionCapability({
    fim: false,
    streaming: true,
    cancellation: true,
    maxPrefixTokens: 4096,
    maxSuffixTokens: 2048,
  }));
});

test("子 Agent 可写路径必须属于允许路径", () => {
  assert.throws(() => validateSubagentAssignment({
    depth: 1,
    allowedPaths: ["src"],
    writablePaths: ["tests"],
    tokenBudget: 1000,
    maxTurns: 10,
  }));
});
