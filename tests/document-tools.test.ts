import test from "node:test";
import assert from "node:assert/strict";
import { createDocumentTools } from "../src/tools/document-tools.js";

test("document tool registry exposes the nine reviewed operations", () => {
  const tools = createDocumentTools({ workspaces: {} as never, diffs: {} as never });
  assert.deepEqual(tools.map(tool => tool.manifest.name), [
    "ExcelRead", "ExcelEdit", "ExcelWrite",
    "PdfRead", "PdfEdit", "PdfWrite",
    "WordRead", "WordEdit", "WordWrite",
  ]);
});
