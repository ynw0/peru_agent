import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseTuiCommand, TUI_COMMANDS } from "../src/tui/commands.js";
import { checkTuiHealth, loadTuiSetupDraft, writeTuiConfiguration } from "../src/tui/config.js";
import { TuiController } from "../src/tui/controller.js";
import { TuiApplicationLifecycle, type TuiLifecycleEvent, type TuiLifecycleHost } from "../src/tui/lifecycle.js";
import { createTuiInputBuffer, reduceTuiInput } from "../src/tui/input-buffer.js";
import { buildTuiTimeline, layoutTuiLines } from "../src/tui/terminal-layout.js";
import { CheckpointManager, InMemoryCheckpointStore } from "../src/checkpoint/checkpoint-manager.js";
import { DiffManager } from "../src/diff/diff-manager.js";
import { DiffReviewCoordinator } from "../src/diff/diff-review-coordinator.js";
import { InMemoryDiffProposalStore } from "../src/diff/diff-store.js";
import { InMemoryEventJournal } from "../src/agent/event-journal.js";
import { IncrementingIdGenerator } from "../src/agent/id-generator.js";
import { createWorkspaceTools } from "../src/tools/workspace-tools.js";
import { WorkspaceService, WorkspaceRegistry } from "../src/workspace/workspace-service.js";
import { EMPTY_WORKBENCH_SNAPSHOT } from "../src/workbench/workbench-state.js";
import type { TuiConfiguration } from "../src/tui/config.js";
import type { TuiRuntime } from "../src/tui/runtime.js";
import {
  createTuiConfigurationEditor,
  getTuiReviewDecision,
  reduceTuiConfigurationEditor,
  TUI_CONFIGURATION_FIELDS,
} from "../src/tui/view-state.js";
import { createTuiViewport, getTuiViewportRange, reduceTuiViewport } from "../src/tui/view-state.js";

test("TUI slash command parser handles workspace and mode commands", () => {
  assert.deepEqual(parseTuiCommand("/mode autoReview"), { kind: "mode", mode: "autoReview" });
  assert.deepEqual(parseTuiCommand("/workspace C:\\project folder"), {
    kind: "workspace",
    path: "C:\\project folder",
  });
  assert.equal(parseTuiCommand("/mode fullAccess"), undefined);
  assert.deepEqual(parseTuiCommand("/restore checkpoint-1"), { kind: "restore", checkpointId: "checkpoint-1" });
  assert.deepEqual(parseTuiCommand("/retry"), { kind: "retry" });
  assert.deepEqual(parseTuiCommand("/doctor"), { kind: "doctor" });
  assert.deepEqual(parseTuiCommand("/config"), { kind: "config" });
  assert.deepEqual(parseTuiCommand("/permissions"), { kind: "permissions" });
  assert.equal(parseTuiCommand("/permissions extra"), undefined);
});

test("TUI command descriptors all have a parser route", () => {
  const requiredArguments: Readonly<Record<string, string>> = {
    workspace: " C:\\peru_agent",
    mode: " default",
    restore: " checkpoint-1",
  };
  for (const descriptor of TUI_COMMANDS) {
    const parsed = parseTuiCommand(`/${descriptor.name}${requiredArguments[descriptor.name] ?? ""}`);
    assert.notEqual(parsed, undefined, `缺少命令解析：/${descriptor.name}`);
  }
});

test("TUI setup draft uses the confirmed local model defaults and blocks missing credentials", async () => {
  const root = join(process.cwd(), `.tui-config-test-${Date.now()}`);
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
  const loaded = await loadTuiSetupDraft(join(root, "config.json"));
  assert.equal(loaded.exists, false);
  assert.equal(loaded.draft.baseUrl, "http://127.0.0.1:1234/v1");
  assert.equal(loaded.draft.model, "google/gemma-4-e2b");
  const health = await checkTuiHealth({ ...loaded.draft, sandboxBrokerExecutablePath: "C:\\missing\\broker.exe" });
  assert.equal(health.ok, false);
  assert.equal(health.apiKeyPresent, false);
  await rm(root, { recursive: true, force: true });
});

test("TUI setup writes atomically and backs up invalid config", async () => {
  const root = join(process.cwd(), `.tui-config-backup-${Date.now()}`);
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
  const configPath = join(root, "config.json");
  await writeFile(configPath, "{broken", "utf8");
  const draft = (await loadTuiSetupDraft(configPath)).draft;
  await writeTuiConfiguration({ ...draft, apiKey: "test-key", sandboxBrokerExecutablePath: "C:\\broker.exe" });
  const written = JSON.parse(await readFile(configPath, "utf8")) as { model: { model: string } };
  assert.equal(written.model.model, "google/gemma-4-e2b");
  const names = await readdir(root);
  assert.equal(names.some(name => name.startsWith("config.json.invalid-") && name.endsWith(".bak")), true);
  await rm(root, { recursive: true, force: true });
});

test("TUI setup backs up a structurally invalid old config before repair", async () => {
  const root = join(process.cwd(), `.tui-config-shape-${Date.now()}`);
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
  const configPath = join(root, "config.json");
  await writeFile(configPath, JSON.stringify({
    model: { baseUrl: 123, model: "old", apiKey: "bad" },
    sandboxBrokerExecutablePath: "relative-broker.exe",
  }), "utf8");
  const draft = (await loadTuiSetupDraft(configPath)).draft;
  await writeTuiConfiguration({ ...draft, sandboxBrokerExecutablePath: "C:\\broker.exe" });
  const names = await readdir(root);
  assert.equal(names.some(name => name.startsWith("config.json.invalid-") && name.endsWith(".bak")), true);
  await rm(root, { recursive: true, force: true });
});

test("TUI input buffer supports cursor editing and command history", () => {
  let state = createTuiInputBuffer();
  state = reduceTuiInput(state, "abc", {}).state;
  state = reduceTuiInput(state, "", { left: true }).state;
  state = reduceTuiInput(state, "X", {}).state;
  assert.equal(state.text, "abXc");
  const submitted = reduceTuiInput(state, "", { return: true });
  assert.equal(submitted.submitted, "abXc");
  state = reduceTuiInput(submitted.state, "", { up: true }).state;
  assert.equal(state.text, "abXc");
});

test("TUI input reducers accept Ink 7 arrow key names", () => {
  let state = createTuiInputBuffer();
  state = reduceTuiInput(state, "abc", {}).state;
  state = reduceTuiInput(state, "", { leftArrow: true }).state;
  assert.equal(state.cursor, 2);
  state = reduceTuiInput(state, "", { upArrow: true }).state;
  assert.equal(state.cursor, 2);
});

test("TUI input reducer supports line clearing, word deletion and delete-to-end", () => {
  let state = createTuiInputBuffer();
  state = reduceTuiInput(state, "one two three", {}).state;
  state = reduceTuiInput(state, "", { deleteWord: true }).state;
  assert.equal(state.text, "one two ");
  state = reduceTuiInput(state, "", { deleteToEnd: true }).state;
  assert.equal(state.text, "one two ");
  state = reduceTuiInput(state, "", { clearLine: true }).state;
  assert.equal(state.text, "");
});

test("TUI permission and Diff reviews share A accept and D/R/Esc reject semantics", () => {
  assert.equal(getTuiReviewDecision("a", {}), "accept");
  assert.equal(getTuiReviewDecision("A", {}), "accept");
  assert.equal(getTuiReviewDecision("d", {}), "reject");
  assert.equal(getTuiReviewDecision("R", {}), "reject");
  assert.equal(getTuiReviewDecision("", { escape: true }), "reject");
  assert.equal(getTuiReviewDecision("v", {}), undefined);
});

test("TUI timeline preserves persisted message/tool order and folds tools to four lines", () => {
  const session = {
    id: "session",
    workspaceId: "workspace",
    permissionMode: "default" as const,
    status: "completed" as const,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    usage: { inputTokens: 0, outputTokens: 0 },
    messages: [
      { id: "u", role: "user" as const, content: "读取文件" },
      { id: "a1", role: "assistant" as const, content: "我来读取", toolCalls: [{ id: "t1", name: "Read", arguments: {} }] },
      { id: "tm", role: "tool" as const, toolCallId: "t1", toolName: "Read", content: "结果内容", isError: false },
      { id: "a2", role: "assistant" as const, content: "读取完成", toolCalls: [] },
    ],
  };
  const snapshot = { ...EMPTY_WORKBENCH_SNAPSHOT, chatMessages: [
    { id: "u", role: "user" as const, content: "读取文件", state: "completed" as const },
    { id: "a1", role: "assistant" as const, content: "我来读取", state: "completed" as const },
    { id: "a2", role: "assistant" as const, content: "读取完成", state: "completed" as const },
  ], tools: [{
    toolCallId: "t1", toolName: "Read", description: "读取文件", riskLevel: "workspace-read" as const,
    capabilities: ["workspace.read" as const], affectedFiles: ["中文.txt"], networkTargets: [], commands: [],
    progressMessages: ["已读取"], outputPreview: "结果内容", outputTruncated: false, outputIsError: false, state: "completed" as const,
  }] };
  const timeline = buildTuiTimeline(session, snapshot);
  assert.deepEqual(timeline.map(item => item.id), ["u", "a1", "tool:t1", "a2"]);
  const layout = layoutTuiLines(timeline, 24);
  assert.equal(layout.lines.filter(line => line.entryId === "tool:t1").length <= 4, true);
  assert.equal(layout.lines.some(line => line.text.includes("中文.txt")), true);
});

test("TUI viewport pages, follows new output and preserves the browsed item", () => {
  let viewport = createTuiViewport(40, 10);
  viewport = reduceTuiViewport(viewport, { pageUp: true }, 40, 10);
  assert.deepEqual(getTuiViewportRange(viewport), { start: 20, end: 30 });
  const browsed = reduceTuiViewport(viewport, {}, 42, 10);
  assert.deepEqual(getTuiViewportRange(browsed), { start: 20, end: 30 });
  assert.equal(browsed.unread, 2);
  const tail = reduceTuiViewport(browsed, { ctrl: true, end: true }, 42, 10);
  assert.deepEqual(getTuiViewportRange(tail), { start: 32, end: 42 });
  assert.equal(tail.unread, 0);
  const head = reduceTuiViewport(tail, { ctrl: true, home: true }, 42, 10);
  assert.deepEqual(getTuiViewportRange(head), { start: 0, end: 10 });
});

test("TUI configuration editor exposes the full editable field sequence", () => {
  const draft = {
    configPath: "C:\\config.json",
    baseUrl: "http://127.0.0.1:1234/v1",
    chatCompletionsPath: "/chat/completions",
    model: "google/gemma-4-e2b",
    apiKey: "test-key",
    contextWindowTokens: "131072",
    sandboxBrokerExecutablePath: "C:\\broker.exe",
    permissionMode: "default" as const,
    networkMode: "offline" as const,
  };
  let state = createTuiConfigurationEditor(draft);
  assert.deepEqual(TUI_CONFIGURATION_FIELDS.slice(0, 3), ["baseUrl", "chatCompletionsPath", "model"]);
  state = reduceTuiConfigurationEditor(state, "", { downArrow: true }).state;
  assert.equal(state.fieldIndex, 1);
  state = reduceTuiConfigurationEditor(state, "", { end: true }).state;
  state = reduceTuiConfigurationEditor(state, "x", {}).state;
  assert.equal(state.draft.chatCompletionsPath, "/chat/completionsx");
  state = reduceTuiConfigurationEditor(state, "", { ctrl: true, home: true }).state;
  assert.equal(state.input.cursor, 0);
  const cancelled = reduceTuiConfigurationEditor(state, "", { escape: true });
  assert.equal(cancelled.cancelled, true);
});

test("repository TUI launcher pins Node 22 and uses a stable build stamp", async () => {
  const launcher = await readFile(join(process.cwd(), "tui.ps1"), "utf8");
  assert.match(launcher, /\[switch\]\$ForceBuild/);
  assert.match(launcher, /\[switch\]\$BuildOnly/);
  assert.match(launcher, /vendor\\node22-22\.14\.0/);
  assert.match(launcher, /Get-FileHash/);
  assert.match(launcher, /sandbox:build-windows/);
});

test("TuiController keeps the current runtime when workspace creation fails and disposes it after a successful switch", async () => {
  let initialDisposed = false;
  const initial = fakeRuntime("workspace-1", "C:\\workspace-1", () => { initialDisposed = true; });
  const configuration = fakeConfiguration();
  const failedController = new TuiController(initial, configuration, async () => { throw new Error("workspace invalid"); });
  await assert.rejects(failedController.switchWorkspace("C:\\missing"), /workspace invalid/);
  assert.equal(failedController.getRuntime(), initial);
  await failedController.dispose();
  assert.equal(initialDisposed, true);

  let previousDisposed = false;
  const previous = fakeRuntime("workspace-2", "C:\\workspace-2", () => { previousDisposed = true; });
  const next = fakeRuntime("workspace-3", "C:\\workspace-3", () => undefined);
  const controller = new TuiController(previous, configuration, async () => next);
  await controller.switchWorkspace("C:\\workspace-3");
  assert.equal(controller.getRuntime(), next);
  assert.equal(previousDisposed, true);
  await controller.dispose();
});

test("TuiController reconfigure is transactional and keeps the old runtime on candidate failure", async () => {
  const root = join(process.cwd(), `.tui-reconfigure-${Date.now()}`);
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
  const configuration = { ...fakeConfiguration(), configPath: join(root, "config.json") };
  let oldDisposed = false;
  const oldRuntime = fakeRuntime("workspace-reconfigure-old", root, () => { oldDisposed = true; });
  const failedController = new TuiController(oldRuntime, configuration, async () => { throw new Error("candidate invalid"); });
  const changed = { ...configuration, model: { ...configuration.model, model: "changed-model" } };
  await assert.rejects(failedController.reconfigure(changed), /candidate invalid/);
  assert.equal(failedController.getRuntime(), oldRuntime);
  assert.equal(failedController.getConfiguration().model.model, configuration.model.model);
  assert.equal(oldDisposed, false);
  await failedController.dispose();

  let previousDisposed = false;
  const previous = fakeRuntime("workspace-reconfigure-previous", root, () => { previousDisposed = true; });
  const next = fakeRuntime("workspace-reconfigure-next", root, () => undefined);
  const controller = new TuiController(previous, configuration, async () => next);
  await controller.reconfigure(changed);
  assert.equal(controller.getRuntime(), next);
  assert.equal(controller.getConfiguration().model.model, "changed-model");
  assert.equal(previousDisposed, true);
  assert.equal((JSON.parse(await readFile(configuration.configPath, "utf8")) as { model: { model: string } }).model.model, "changed-model");
  await controller.dispose();
  await rm(root, { recursive: true, force: true });
});

test("TuiApplicationLifecycle releases the current Runtime exactly once", async () => {
  let disposed = 0;
  const runtime = fakeRuntime("lifecycle", "C:\\lifecycle", () => { disposed += 1; });
  const controller = new TuiController(runtime, fakeConfiguration(), async () => runtime);
  const host = new FakeLifecycleHost();
  const errors: string[] = [];
  const exitCodes: number[] = [];
  let unmounted = 0;
  const lifecycle = new TuiApplicationLifecycle(controller, {
    host,
    writeError: message => errors.push(message),
    setExitCode: code => exitCodes.push(code),
  });
  lifecycle.setRenderer({ unmount: () => { unmounted += 1; }, waitUntilExit: async () => undefined });
  lifecycle.install();
  assert.equal(host.listenerCount("SIGINT"), 1);
  const firstShutdown = lifecycle.shutdown(new Error("late error"));
  host.emit("SIGINT");
  await firstShutdown;
  await lifecycle.shutdown();
  assert.equal(disposed, 1);
  assert.equal(unmounted, 1);
  assert.deepEqual(exitCodes, [1]);
  assert.match(errors[0] ?? "", /late error/);
  lifecycle.uninstall();
  assert.equal(host.listenerCount("SIGINT"), 0);
});

test("TuiApplicationLifecycle restores the screen when Runtime disposal fails", async () => {
  const runtime = fakeRuntime("lifecycle-failure", "C:\\lifecycle-failure", () => {
    throw new Error("dispose failed");
  });
  const controller = new TuiController(runtime, fakeConfiguration(), async () => runtime);
  const errors: string[] = [];
  const exitCodes: number[] = [];
  let unmounted = 0;
  const lifecycle = new TuiApplicationLifecycle(controller, {
    host: new FakeLifecycleHost(),
    writeError: message => errors.push(message),
    setExitCode: code => exitCodes.push(code),
  });
  lifecycle.setRenderer({
    unmount: () => { unmounted += 1; },
    waitUntilExit: async () => undefined,
  });
  await lifecycle.shutdown();
  assert.equal(unmounted, 1);
  assert.deepEqual(exitCodes, [1]);
  assert.match(errors[0] ?? "", /dispose failed/);
});

class FakeLifecycleHost implements TuiLifecycleHost {
  private readonly listeners = new Map<TuiLifecycleEvent, Set<(error?: unknown) => void>>();

  public once(event: TuiLifecycleEvent, listener: (error?: unknown) => void): void {
    const listeners = this.listeners.get(event) ?? new Set<(error?: unknown) => void>();
    listeners.add(listener);
    this.listeners.set(event, listeners);
  }

  public removeListener(event: TuiLifecycleEvent, listener: (error?: unknown) => void): void {
    this.listeners.get(event)?.delete(listener);
  }

  public emit(event: TuiLifecycleEvent, error?: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) listener(error);
  }

  public listenerCount(event: TuiLifecycleEvent): number {
    return this.listeners.get(event)?.size ?? 0;
  }
}

function fakeConfiguration(): TuiConfiguration {
  return {
    configPath: "C:\\config.json",
    dataDirectory: "C:\\data",
    sandboxBrokerExecutablePath: "C:\\broker.exe",
    permissionMode: "default",
    networkMode: "offline",
    model: {
      baseUrl: "http://127.0.0.1:1234/v1",
      chatCompletionsPath: "/chat/completions",
      model: "google/gemma-4-e2b",
      apiKey: "test-key",
      contextWindowTokens: 131072,
    },
  };
}

function fakeRuntime(workspaceId: string, workspaceRoot: string, dispose: () => void): TuiRuntime {
  const session = {
    id: `session-${workspaceId}`,
    workspaceId,
    permissionMode: "default" as const,
    status: "idle" as const,
    messages: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    usage: { inputTokens: 0, outputTokens: 0 },
  };
  return {
    configuration: fakeConfiguration(),
    workspaceId,
    workspaceRoot,
    agent: {} as never,
    getSnapshot: () => ({ ...EMPTY_WORKBENCH_SNAPSHOT, activeSessionId: session.id }),
    onSnapshot: () => ({ dispose: () => undefined }),
    getActiveSessionId: () => session.id,
    getActiveSession: async () => session,
    sendInput: async () => ({ runId: "run" }),
    prepareUserInput: async content => ({ content }),
    getExternalPathCandidates: () => [],
    authorizeExternalDirectory: async () => ({ id: "external", sessionId: session.id, directory: "C:\\external", createdAt: "2026-01-01T00:00:00.000Z" }),
    prepareAuthorizedExternalInput: async content => ({ content }),
    authorizeAndSendExternalInput: async () => ({ runId: "run" }),
    queueInput: async (input, priority) => ({ id: "queue", input, priority, createdAt: "2026-01-01T00:00:00.000Z" }),
    listQueuedInputs: async () => [],
    removeQueuedInput: async () => false,
    runQueuedInput: async () => ({ runId: "run" }),
    renameActiveSession: async () => session,
    compactActiveSession: async () => ({ summary: "", sourceMessageCount: 0, inputTokens: 0, outputTokens: 0 }),
    exportActiveSession: async () => "C:\\data\\export.md",
    suggestFiles: async () => [],
    loadInputHistory: async () => [],
    recordInputHistory: async () => undefined,
    abortActiveRun: () => false,
    createSession: async () => session,
    activateSession: async () => session,
    listSessions: async () => [session],
    listDiffs: () => [],
    getDiff: () => undefined,
    resolvePermission: () => false,
    resolveDiff: async () => { throw new Error("not implemented"); },
    listCheckpoints: async () => [],
    restoreCheckpoint: async () => { throw new Error("not implemented"); },
    retryActiveSession: async () => ({ sessionId: session.id, runId: "run" }),
    getToolResult: async () => undefined,
    getHealthReport: async () => { throw new Error("not implemented"); },
    getContextReport: async () => ({ contextWindowTokens: 131072, recentInputTokens: 0, usedPercent: 0, remainingTokens: 131072 }),
    listTools: () => [],
    getSession: async () => session,
    dispose: async () => dispose(),
  };
}

test("DiffReviewCoordinator pauses a write until the user accepts it", async () => {
  const root = join(process.cwd(), ".tui-test-workspace");
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "note.txt"), "before", "utf8");

  const ids = new IncrementingIdGenerator();
  const workspaces = new WorkspaceRegistry();
  const workspace = await WorkspaceService.create("workspace", root);
  workspaces.register(workspace);
  const journal = new InMemoryEventJournal();
  const checkpoints = new CheckpointManager(new InMemoryCheckpointStore(), ids, workspaces);
  const diffs = new DiffManager(workspaces, checkpoints, ids, journal, new InMemoryDiffProposalStore());
  const diffReviews = new DiffReviewCoordinator(diffs);
  const tools = createWorkspaceTools({ workspaces, diffs, checkpoints, diffReviews });
  const write = tools.find(tool => tool.manifest.name === "Write");
  assert.ok(write !== undefined);

  const execution = write.execute(write.validate({ path: "note.txt", content: "after" }), {
    sessionId: "session-1",
    workspaceId: "workspace",
    toolCallId: "tool-1",
    signal: new AbortController().signal,
    reportProgress: async () => undefined,
  });
  let proposal = diffs.list("workspace")[0];
  for (let attempt = 0; proposal === undefined && attempt < 50; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 5));
    proposal = diffs.list("workspace")[0];
  }
  assert.ok(proposal !== undefined);
  assert.equal((await workspace.readText("note.txt")).content, "before");
  await diffReviews.resolve(proposal.id, "accepted");
  const accepted = await execution as { readonly status: string };
  assert.equal(accepted.status, "accepted");
  assert.equal((await readFile(join(root, "note.txt"), "utf8")), "after");
  await rm(root, { recursive: true, force: true });
});

test("DiffReviewCoordinator wakes a waiter registered while acceptance is in flight", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let proposal: {
    readonly id: string;
    readonly sessionId: string;
    readonly workspaceId: string;
    readonly toolCallId: string;
    readonly createdAt: string;
    readonly status: "proposed" | "accepted" | "rejected";
    readonly changes: readonly never[];
  } = {
    id: "diff-race",
    sessionId: "session-race",
    workspaceId: "workspace-race",
    toolCallId: "tool-race",
    createdAt: new Date().toISOString(),
    status: "proposed",
    changes: [],
  };
  const fakeDiffs = {
    get: () => structuredClone(proposal),
    accept: async () => {
      await gate;
      proposal = { ...proposal, status: "accepted" };
      return structuredClone(proposal);
    },
    reject: async () => {
      proposal = { ...proposal, status: "rejected" };
      return structuredClone(proposal);
    },
  } as unknown as DiffManager;
  const coordinator = new DiffReviewCoordinator(fakeDiffs);
  const resolving = coordinator.resolve(proposal.id, "accepted");
  const waiting = coordinator.awaitResolution(proposal.id, proposal.sessionId, new AbortController().signal);
  assert.strictEqual(coordinator.resolve(proposal.id, "accepted"), resolving);
  await assert.rejects(coordinator.resolve(proposal.id, "rejected"), /不能同时执行 rejected/);
  release();
  assert.equal((await resolving).status, "accepted");
  assert.equal((await waiting).status, "accepted");
  assert.deepEqual(coordinator.listPending(), []);
});
