import { strict as assert } from "node:assert";
import { test } from "node:test";
import { TuiHitRegionRegistry } from "../src/tui/hit-regions.js";
import { TuiInputRouter } from "../src/tui/input-router.js";
import { selectionForMouse } from "../src/tui/selection.js";

test("full-screen TUI keeps mouse wheel routed to the active timeline", () => {
  const registry = new TuiHitRegionRegistry();
  registry.set([{ id: "timeline", left: 0, top: 5, right: 119, bottom: 30 }]);

  assert.equal(registry.hit(20, 10)?.id, "timeline");
  assert.equal(registry.hit(20, 2)?.id, "timeline");
  assert.equal(registry.hit(20, 35)?.id, "timeline");

  registry.set([{ id: "overlay", left: 10, top: 5, right: 90, bottom: 25 }]);
  assert.equal(registry.hit(5, 2), undefined);
});

test("mouse router preserves Esc and reuses the existing copy action after a left drag", () => {
  const events: string[] = [];
  const router = new TuiInputRouter(event => {
    if (event.kind !== "mouse") return;
    const mouse = event.event;
    events.push(mouse.kind === "wheel" ? `wheel:${mouse.direction}` : `${mouse.kind}:${mouse.button ?? "none"}`);
  });

  assert.equal(router.feed("[<64;4;5M"), true);
  assert.equal(router.feed("\u001b"), false);
  assert.equal(router.feed("hello"), false);
  assert.equal(router.feed("[<0;4;5M[<32;8;5M[<0;8;5m"), true);
  assert.deepEqual(events, ["wheel:up", "press:left", "move:left", "release:left", "press:right"]);
});

test("clicking outside timeline does not extend a previous text selection", () => {
  const lines = [{ entryId: "entry", kind: "message" as const, role: "user" as const, text: "你：hello", lineIndex: 0 }];
  const current = {
    start: { entryId: "entry", lineIndex: 0, column: 0 },
    end: { entryId: "entry", lineIndex: 0, column: 2 },
  };

  const next = selectionForMouse(current, {
    kind: "press", button: "left", x: 1, y: 1, shift: false, alt: false, ctrl: false,
  }, lines, 5, 4);
  assert.equal(next, undefined);
});
