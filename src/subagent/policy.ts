import type { Capability } from "../agent-protocol.js";
import { normalizeWorkspacePath } from "../workspace/path-guard.js";
import { MAX_SUBAGENT_DEPTH } from "./types.js";
import type { SubagentRole, SubagentTaskRequest } from "./types.js";

const ROLE_CAPABILITIES: Readonly<Record<SubagentRole, ReadonlySet<Capability>>> = {
  planner: new Set(["workspace.read"]),
  explorer: new Set(["workspace.read"]),
  implementer: new Set(["workspace.read", "workspace.propose", "workspace.write"]),
  reviewer: new Set(["workspace.read"]),
  tester: new Set(["workspace.read", "process.execute"]),
};

export function normalizeScope(path: string): string {
  return normalizeWorkspacePath(path.replace(/\/$/, ""));
}

export function pathInScope(path: string, scope: string): boolean {
  return path === scope || path.startsWith(`${scope}/`);
}

export function pathInAnyScope(path: string, scopes: readonly string[]): boolean {
  return scopes.some(scope => pathInScope(path, scope));
}

export function validateSubagentTaskRequest(request: SubagentTaskRequest): SubagentTaskRequest {
  if (request.parentSessionId.trim() === "" || request.baseWorkspaceId.trim() === "") {
    throw new Error("父会话和基础工作区 ID 不能为空");
  }
  if (request.instruction.trim() === "") {
    throw new Error("子 Agent 指令不能为空");
  }
  if (!Number.isInteger(request.depth) || request.depth < 1 || request.depth > MAX_SUBAGENT_DEPTH) {
    throw new Error(`子 Agent 深度必须在 1 到 ${MAX_SUBAGENT_DEPTH} 之间`);
  }
  if (request.allowedPaths.length === 0) {
    throw new Error("子 Agent 至少需要一个允许路径");
  }

  const allowedPaths = uniqueNormalized(request.allowedPaths);
  const writablePaths = uniqueNormalized(request.writablePaths);
  const invalidWritable = writablePaths.find(path => !pathInAnyScope(path, allowedPaths));
  if (invalidWritable !== undefined) {
    throw new Error(`可写路径不在允许路径中：${invalidWritable}`);
  }
  if (request.role !== "implementer" && writablePaths.length !== 0) {
    throw new Error(`${request.role} 子 Agent 不允许获得可写路径`);
  }

  const permitted = ROLE_CAPABILITIES[request.role];
  const invalidCapability = request.allowedCapabilities.find(capability => !permitted.has(capability));
  if (invalidCapability !== undefined) {
    throw new Error(`${request.role} 子 Agent 不允许能力：${invalidCapability}`);
  }
  if (request.role === "implementer" && writablePaths.length > 0
    && !request.allowedCapabilities.includes("workspace.write")) {
    throw new Error("Implementer 获得可写路径时必须显式声明 workspace.write");
  }
  if ((request.role === "reviewer" || request.role === "tester") && request.targetTaskId === undefined) {
    throw new Error(`${request.role} 必须绑定目标 Implementer 任务`);
  }
  if (request.role !== "reviewer" && request.role !== "tester" && request.targetTaskId !== undefined) {
    throw new Error(`${request.role} 不允许声明 targetTaskId`);
  }

  validateBudget(request.budget);
  return {
    ...request,
    allowedPaths,
    writablePaths,
    allowedCapabilities: [...new Set(request.allowedCapabilities)],
  };
}

function uniqueNormalized(paths: readonly string[]): readonly string[] {
  const normalized = paths.map(normalizeScope);
  const unique = [...new Set(normalized)];
  unique.sort((left, right) => left.localeCompare(right));
  return unique;
}

function validateBudget(budget: SubagentTaskRequest["budget"]): void {
  for (const [name, value] of Object.entries(budget)) {
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(`${name} 必须是正整数`);
    }
  }
  if (budget.maxDurationMs > 24 * 60 * 60 * 1_000) {
    throw new Error("子 Agent 最大运行时间不能超过 24 小时");
  }
}
