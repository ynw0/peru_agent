import test from "node:test";
import assert from "node:assert/strict";
import { createDocumentTools } from "../src/tools/document-tools.js";
import { parseTuiMouseInput } from "../src/tui/mouse.js";

test("TUI SGR wheel input is isolated from text input", () => {
  assert.deepEqual(parseTuiMouseInput("\u001b[<64;12;8M"), { kind: "wheel", direction: "up", amount: 3 });
  assert.deepEqual(parseTuiMouseInput("\u001b[<65;12;8M"), { kind: "wheel", direction: "down", amount: 3 });
  assert.equal(parseTuiMouseInput("hello"), undefined);
});

test("document tool registry exposes the nine reviewed operations", () => {
  const tools = createDocumentTools({ workspaces: {} as never, diffs: {} as never });
  assert.deepEqual(tools.map(tool => tool.manifest.name), [
    "ExcelRead", "ExcelEdit", "ExcelWrite",
    "PdfRead", "PdfEdit", "PdfWrite",
    "WordRead", "WordEdit", "WordWrite",
  ]);
});
