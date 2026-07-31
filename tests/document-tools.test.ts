import test from "node:test";
import assert from "node:assert/strict";

test("document tool registry exposes the nine reviewed operations", async () => {
  class TestDOMMatrix {}
  Object.defineProperty(globalThis, "DOMMatrix", { value: TestDOMMatrix, configurable: true });
  const { createDocumentTools } = await import("../src/tools/document-tools.js");
  const tools = createDocumentTools({ workspaces: {} as never, diffs: {} as never });
  assert.deepEqual(tools.map(tool => tool.manifest.name), [
    "ExcelRead", "ExcelEdit", "ExcelWrite",
    "PdfRead", "PdfEdit", "PdfWrite",
    "WordRead", "WordEdit", "WordWrite",
  ]);
});
