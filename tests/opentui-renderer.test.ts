import { strict as assert } from "node:assert";
import { access, readFile } from "node:fs/promises";
import { test } from "node:test";
import { adaptOpenTuiKey } from "../src/tui/opentui-key-adapter.js";
import {
  buildTuiPlanEditorSubmission,
  buildTuiTaskEditorSubmission,
  createTuiPlanEditorState,
  createTuiTaskEditorState,
  updateTuiPlanField,
  updateTuiTaskField,
} from "../src/tui/orchestration-state.js";

const read = (path: string): Promise<string> => readFile(path, "utf8");

test("OpenTUI renderer owns mouse, alternate screen, scrollbox and selection", async () => {
  const [main, app, selection] = await Promise.all([
    read("tui-opentui/src/main.tsx"),
    read("tui-opentui/src/app.tsx"),
    read("tui-opentui/src/selection.ts"),
  ]);

  assert.match(main, /createCliRenderer/);
  assert.match(main, /screenMode:\s*"alternate-screen"/);
  assert.match(main, /useMouse:\s*true/);
  assert.match(main, /createRoot\(renderer\)/);
  assert.match(app, /<scrollbox/);
  assert.match(app, /stickyScroll/);
  assert.match(app, /stickyStart="bottom"/);
  assert.match(app, /useSelectionHandler/);
  assert.match(app, /onMouseUp=/);
  assert.match(selection, /renderer\.getSelection\(\)/);
  assert.match(selection, /renderer\.clearSelection\(\)/);
  assert.doesNotMatch(app, /mouse\.js|hit-regions\.js|selectionForMouse|TuiInputRouter/);
});

test("tui.ps1 requires Bun and never falls back to Ink", async () => {
  const script = await read("tui.ps1");
  assert.match(script, /Bun >= 1\.3/);
  assert.match(script, /tui-opentui/);
  assert.match(script, /不会回退到 Ink\/Node TUI/);
  assert.doesNotMatch(script, /dist\\src\\tui\\main\.js/);
  assert.doesNotMatch(script, /node\.exe/);
});

test("OpenTUI key adapter reuses the existing input reducer contract", () => {
  assert.deepEqual(adaptOpenTuiKey({ name: "left", sequence: "", ctrl: false, meta: false, shift: false }), {
    value: "",
    key: { left: true, leftArrow: true },
  });
  assert.deepEqual(adaptOpenTuiKey({ name: "c", sequence: "\u0003", ctrl: true, meta: false, shift: false }), {
    value: "c",
    key: { ctrl: true },
  });
  assert.deepEqual(adaptOpenTuiKey({ name: "pageup", sequence: "", ctrl: false, meta: false, shift: false }), {
    value: "",
    key: { pageUp: true },
  });
  assert.deepEqual(adaptOpenTuiKey({ name: "a", sequence: "a", ctrl: false, meta: false, shift: true }), {
    value: "a",
    key: { shift: true },
  });
});

test("OpenTUI Phase 2 owns config, external path, shell and active-run confirmation dialogs", async () => {
  const [app, setup, runtime] = await Promise.all([
    read("tui-opentui/src/app.tsx"),
    read("tui-opentui/src/setup.tsx"),
    read("src/tui/runtime.ts"),
  ]);

  assert.match(app, /kind: "externalAccess"/);
  assert.match(app, /authorizeAndPrepareExternalInput/);
  assert.match(app, /kind: "shell"/);
  assert.match(app, /Windows Sandbox Broker/);
  assert.match(app, /kind: "queueChoice"/);
  assert.match(app, /"immediate"/);
  assert.match(app, /"guide"/);
  assert.match(app, /"next"/);
  assert.match(app, /OpenTuiConfigurationEditor/);
  assert.match(app, /configurationFromTuiSetupDraft/);
  assert.match(setup, /export function OpenTuiConfigurationEditor/);
  assert.match(runtime, /authorizeAndPrepareExternalInput/);
  assert.doesNotMatch(app, /Phase 1 尚未迁移授权对话框|Shell 确认对话框将在 OpenTUI Phase 2/);
});


test("OpenTUI Phase 3 reuses pure orchestration editor state and native suggestions", async () => {
  const app = await read("tui-opentui/src/app.tsx");
  const editors = await read("tui-opentui/src/orchestration-editors.tsx");

  assert.match(app, /getTuiSuggestions/);
  assert.match(app, /acceptTuiSuggestion/);
  assert.match(app, /OpenTuiPlanEditor/);
  assert.match(app, /OpenTuiTaskEditor/);
  assert.match(app, /getToolResult/);
  assert.match(editors, /buildTuiPlanEditorSubmission/);
  assert.match(editors, /buildTuiTaskEditorSubmission/);
  assert.doesNotMatch(editors, /from "ink"|parseTuiMouseInput/);
});

test("shared orchestration state builds structured Plan and Task requests", () => {
  let plan = createTuiPlanEditorState("实现 OpenTUI");
  plan = updateTuiPlanField(plan, "title", "Renderer migration", 0);
  plan = updateTuiPlanField(plan, "stepFiles", "tui-opentui,src/tui", 0);
  const planInput = buildTuiPlanEditorSubmission(plan);
  assert.equal(planInput.title, "Renderer migration");
  assert.deepEqual(planInput.steps[0]?.affectedFiles, ["tui-opentui", "src/tui"]);

  let task = createTuiTaskEditorState("迁移 renderer");
  task = updateTuiTaskField(task, "role", "implementer");
  task = updateTuiTaskField(task, "allowedPaths", "tui-opentui,src/tui");
  const taskInput = buildTuiTaskEditorSubmission(task);
  assert.equal(taskInput.role, "implementer");
  assert.deepEqual(taskInput.writablePaths, ["tui-opentui", "src/tui"]);
  assert.deepEqual(taskInput.allowedCapabilities, ["workspace.read", "workspace.propose", "workspace.write"]);
});

test("OpenTUI E2E uses the official native test renderer and mock mouse", async () => {
  const [e2e, script] = await Promise.all([
    read("tui-opentui/src/e2e.tsx"),
    read("tui.ps1"),
  ]);
  assert.match(e2e, /@opentui\/core\/testing/);
  assert.match(e2e, /createTestRenderer/);
  assert.match(e2e, /mockMouse\.scroll/);
  assert.match(e2e, /mockMouse\.drag/);
  assert.match(e2e, /renderer\.getSelection/);
  assert.match(e2e, /OPENTUI_E2E_OK/);
  assert.match(script, /\[switch\]\$E2E/);
  assert.match(script, /src\\e2e\.tsx/);
});


test("legacy Ink renderer and root Ink dependencies are removed", async () => {
  const rootPackage = JSON.parse(await read("package.json")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  assert.equal(rootPackage.dependencies?.ink, undefined);
  assert.equal(rootPackage.dependencies?.react, undefined);
  assert.equal(rootPackage.devDependencies?.["@types/react"], undefined);

  for (const path of [
    "src/tui/app.tsx",
    "src/tui/main.tsx",
    "src/tui/lifecycle.ts",
    "src/tui/mouse.ts",
    "src/tui/input-router.ts",
    "src/tui/hit-regions.ts",
    "src/tui/selection.ts",
    "src/tui/clipboard.ts",
    "src/tui/setup.tsx",
    "src/tui/orchestration-editor.tsx",
  ]) {
    await assert.rejects(access(path));
  }
});
