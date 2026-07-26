import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { IncrementingIdGenerator } from "./agent/id-generator.js";
import { InMemoryEventJournal } from "./agent/event-journal.js";
import { CheckpointManager, InMemoryCheckpointStore } from "./checkpoint/checkpoint-manager.js";
import { DiffManager } from "./diff/diff-manager.js";
import { InMemoryDiffProposalStore } from "./diff/diff-store.js";
import { WorkspaceRegistry, WorkspaceService } from "./workspace/workspace-service.js";

const directory = `/tmp/independent-ai-ide-phase4-smoke-${Date.now()}`;
await rm(directory, { recursive: true, force: true });
await mkdir(directory, { recursive: true });
const ids = new IncrementingIdGenerator();
const workspaces = new WorkspaceRegistry();
const workspace = await WorkspaceService.create("smoke-workspace", `${directory}/workspace`);
workspaces.register(workspace);
await writeFile(`${workspace.root}/smoke.txt`, "before", "utf8");
const checkpoints = new CheckpointManager(new InMemoryCheckpointStore(), ids, workspaces);
const diffs = new DiffManager(
  workspaces,
  checkpoints,
  ids,
  new InMemoryEventJournal(),
  new InMemoryDiffProposalStore(),
);
const proposal = await diffs.propose({
  sessionId: "smoke-session",
  workspaceId: "smoke-workspace",
  toolCallId: "smoke-call",
  changes: [{ path: "smoke.txt", afterContent: "after" }],
});
const accepted = await diffs.accept(proposal.id);
if (await readFile(`${workspace.root}/smoke.txt`, "utf8") !== "after") {
  throw new Error("Phase 4 Smoke Test 写入结果错误");
}
await checkpoints.restore(accepted.checkpointId ?? "");
if (await readFile(`${workspace.root}/smoke.txt`, "utf8") !== "before") {
  throw new Error("Phase 4 Smoke Test Checkpoint 恢复错误");
}
await rm(directory, { recursive: true, force: true });
console.log("Phase 4 Smoke Test 通过：Diff 接受与 Checkpoint 恢复正常");
