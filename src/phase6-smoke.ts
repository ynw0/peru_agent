import { IncrementingIdGenerator } from "./agent/id-generator.js";
import { InMemoryEventJournal } from "./agent/event-journal.js";
import { PlanManager } from "./plan/plan-manager.js";
import { WorkbenchRuntime } from "./runtime/workbench-runtime.js";

const journal = new InMemoryEventJournal();
const plans = new PlanManager(new IncrementingIdGenerator(), journal);
const workbench = new WorkbenchRuntime(journal);
plans.onEvent(async event => { await workbench.handleEvent(event); });

await workbench.handleEvent({
  type: "session.created",
  sessionId: "phase6-session",
  workspaceId: "phase6-workspace",
});
const plan = await plans.create({
  sessionId: "phase6-session",
  title: "Phase 6 Smoke",
  summary: "验证计划审核和 Workbench 事件投影",
  confidence: 93,
  affectedFiles: ["src/workbench/workbench-controller.ts"],
  steps: [{
    title: "验证交互层",
    description: "投影计划并完成用户审核",
    affectedFiles: ["src/workbench/workbench-controller.ts"],
    capabilities: ["workspace.propose"],
  }],
});
await plans.resolve(plan.id, "approved");

const snapshot = workbench.getSnapshot("phase6-session");
if (snapshot.plans[0]?.status !== "approved") {
  throw new Error("Phase 6 Plan Review Smoke Test 失败");
}
console.log("AI IDE Phase 6 Interaction Smoke Test 通过");
