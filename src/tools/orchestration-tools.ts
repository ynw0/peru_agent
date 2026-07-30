import type { Tool } from "../tool-runtime.js";
import type { Capability } from "../agent-protocol.js";
import type { PlanManager } from "../plan/plan-manager.js";
import type { PlanReviewCoordinator } from "../plan/plan-review-coordinator.js";
import type { SubagentRole, SubagentReviewPolicy, SubagentTaskRecord } from "../subagent/types.js";
import { SubagentScheduler } from "../subagent/scheduler.js";
import { GateReportStore } from "../orchestration/gate-report-store.js";

const READ_TOOLS = ["Read", "Glob", "Grep"] as const;
const ROLE_CAPS: Readonly<Record<SubagentRole, readonly Capability[]>> = {
  planner: ["workspace.read"], explorer: ["workspace.read"], reviewer: ["workspace.read"],
  tester: ["workspace.read", "process.execute"],
  implementer: ["workspace.read", "workspace.propose", "workspace.write"],
};

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("参数必须是对象");
  return value as Record<string, unknown>;
}
function stringValue(r: Record<string, unknown>, key: string): string { const v = r[key]; if (typeof v !== "string" || v.trim() === "") throw new Error(`${key} 必须是非空字符串`); return v; }
function stringArray(r: Record<string, unknown>, key: string, fallback: readonly string[] = []): string[] { const v = r[key] ?? fallback; if (!Array.isArray(v) || !v.every(item => typeof item === "string")) throw new Error(`${key} 必须是字符串数组`); return [...v]; }
function role(value: unknown): SubagentRole { if (value === "planner" || value === "explorer" || value === "implementer" || value === "reviewer" || value === "tester") return value; throw new Error("role 无效"); }

export function createOrchestrationTools(input: { plans: PlanManager; planReviews: PlanReviewCoordinator; scheduler: SubagentScheduler; gateReports: GateReportStore; sessionId: string | (() => string); workspaceId: string }): readonly Tool<unknown, unknown>[] {
  const sessionId = (): string => typeof input.sessionId === "function" ? input.sessionId() : input.sessionId;
  const planCreate: Tool<unknown, unknown> = {
    manifest: { name: "PlanCreate", version: "1.0.0", description: "创建并等待用户审核一个实施计划", riskLevel: "pure-compute", capabilities: [], generated: false },
    validate: value => value,
    inspect: () => ({ affectedFiles: [], certifiedComputerApplication: false }),
    execute: async (value, context) => {
      const r = record(value);
      const rawSteps = r.steps;
      if (!Array.isArray(rawSteps) || rawSteps.length === 0) throw new Error("steps 必须是非空数组");
      const plan = await input.plans.create({ sessionId: sessionId(), title: stringValue(r, "title"), summary: stringValue(r, "summary"), confidence: typeof r.confidence === "number" ? r.confidence : 80, affectedFiles: stringArray(r, "affectedFiles"), steps: rawSteps.map(item => { const s = record(item); return { title: stringValue(s, "title"), description: stringValue(s, "description"), affectedFiles: stringArray(s, "affectedFiles"), capabilities: stringArray(s, "capabilities") as Capability[] }; }) });
      const resolved = await input.planReviews.awaitResolution(plan.id, sessionId(), context.signal);
      return { planId: resolved.id, status: resolved.status, title: resolved.title, steps: resolved.steps.length };
    },
    serializeOutput: output => JSON.stringify(output),
  };
  const planList: Tool<unknown, unknown> = {
    manifest: { name: "PlanList", version: "1.0.0", description: "列出当前会话 Plan", riskLevel: "pure-compute", capabilities: [], generated: false },
    validate: value => value,
    inspect: () => ({ affectedFiles: [], certifiedComputerApplication: false }),
    execute: async () => input.plans.list(sessionId()), serializeOutput: output => JSON.stringify(output),
  };
  const dispatch: Tool<unknown, unknown> = {
    manifest: { name: "SubagentDispatch", version: "1.0.0", description: "派发隔离子 Agent 任务", riskLevel: "pure-compute", capabilities: [], generated: false },
    validate: value => value,
    inspect: () => ({ affectedFiles: [], certifiedComputerApplication: false }),
    execute: async (value) => {
      const r = record(value); const selectedRole = role(r.role); const paths = stringArray(r, "allowedPaths", ["."]); const writable = stringArray(r, "writablePaths");
      const reviewPolicy = r.reviewPolicy;
      if (reviewPolicy !== "none" && reviewPolicy !== "reviewer" && reviewPolicy !== "reviewerAndTester") throw new Error("reviewPolicy 必须是 none、reviewer 或 reviewerAndTester");
      const task = await input.scheduler.dispatch({ parentSessionId: sessionId(), role: selectedRole, instruction: stringValue(r, "instruction"), depth: typeof r.depth === "number" ? r.depth : 1, baseWorkspaceId: input.workspaceId, allowedPaths: paths, writablePaths: writable, allowedCapabilities: ROLE_CAPS[selectedRole], budget: selectedRole === "implementer" ? { maxTurns: 24, maxToolCalls: 48, maxTotalTokens: 80_000, maxDurationMs: 20 * 60_000 } : { maxTurns: 12, maxToolCalls: 24, maxTotalTokens: 40_000, maxDurationMs: 10 * 60_000 }, reviewPolicy, ...(r.planId === undefined ? {} : { planId: stringValue(r, "planId") }), ...(r.planStepId === undefined ? {} : { planStepId: stringValue(r, "planStepId") }), ...(r.parentTaskId === undefined ? {} : { parentTaskId: stringValue(r, "parentTaskId") }) });
      if (selectedRole !== "implementer" || r.foreground === true) void input.scheduler.start(task.id);
      if (r.foreground === true) return input.scheduler.waitStable(task.id);
      return task;
    }, serializeOutput: output => JSON.stringify(output),
  };
  const list: Tool<unknown, unknown> = {
    manifest: { name: "SubagentList", version: "1.0.0", description: "列出子 Agent 任务", riskLevel: "pure-compute", capabilities: [], generated: false }, validate: value => value, inspect: () => ({ affectedFiles: [], certifiedComputerApplication: false }), execute: async () => input.scheduler.list(sessionId()), serializeOutput: output => JSON.stringify(output),
  };
  const wait: Tool<unknown, unknown> = { manifest: { name: "SubagentWait", version: "1.0.0", description: "等待子 Agent 任务稳定边界", riskLevel: "pure-compute", capabilities: [], generated: false }, validate: value => value, inspect: () => ({ affectedFiles: [], certifiedComputerApplication: false }), execute: async value => input.scheduler.waitStable(stringValue(record(value), "taskId")), serializeOutput: output => JSON.stringify(output) };
  const abort: Tool<unknown, unknown> = { manifest: { name: "SubagentAbort", version: "1.0.0", description: "取消子 Agent 任务", riskLevel: "pure-compute", capabilities: [], generated: false }, validate: value => value, inspect: () => ({ affectedFiles: [], certifiedComputerApplication: false }), execute: async value => input.scheduler.abort(stringValue(record(value), "taskId")), serializeOutput: output => JSON.stringify(output) };
  const gateReport: Tool<unknown, unknown> = {
    manifest: { name: "GateReport", version: "1.0.0", description: "提交 Reviewer/Tester 的结构化门禁结论", riskLevel: "pure-compute", capabilities: [], generated: false, visibility: "subagent" },
    validate: value => value,
    inspect: () => ({ affectedFiles: [], certifiedComputerApplication: false }),
    execute: async (value, context) => {
      const r = record(value);
      const verdict = r.verdict;
      if (verdict !== "approved" && verdict !== "rejected") throw new Error("verdict 必须是 approved 或 rejected");
      const report = {
        verdict,
        summary: stringValue(r, "summary"),
        issues: stringArray(r, "issues"),
        evidence: stringArray(r, "evidence"),
        tests: stringArray(r, "tests"),
        createdAt: new Date().toISOString(),
      } as const;
      return input.gateReports.submit(context.sessionId, report);
    },
    serializeOutput: output => JSON.stringify(output),
  };
  return [planCreate, planList, dispatch, wait, list, abort, gateReport];
}
