import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { adaptOpenTuiKey } from "../src/tui/opentui-key-adapter.js";

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
