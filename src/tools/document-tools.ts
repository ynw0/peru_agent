import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import ExcelJS from "exceljs";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { Document, Paragraph, Packer, Table, TableCell, TableRow } from "docx";
import JSZip from "jszip";
import * as mammoth from "mammoth";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { toolPermission, type Tool } from "../tool-runtime.js";
import type { DiffManager } from "../diff/diff-manager.js";
import type { DiffReviewCoordinator } from "../diff/diff-review-coordinator.js";
import type { WorkspaceRegistry, WorkspaceService } from "../workspace/workspace-service.js";
import type { WorkspaceTargetResolver } from "../workspace/target-resolver.js";

const { Workbook } = ExcelJS;

const MAX_BINARY_BYTES = 32 * 1024 * 1024;

export interface DocumentToolDependencies {
  readonly workspaces: WorkspaceRegistry;
  readonly targetResolver?: WorkspaceTargetResolver;
  readonly diffs: DiffManager;
  readonly diffReviews?: DiffReviewCoordinator;
}

interface FileInput { readonly path: string }
interface ExcelReadInput extends FileInput { readonly sheet?: string; readonly range?: string }
interface ExcelWriteInput extends FileInput { readonly sheets: readonly { readonly name: string; readonly rows: readonly unknown[][] }[] }
interface ExcelEditInput extends FileInput { readonly operations: readonly { readonly sheet: string; readonly cell: string; readonly value?: unknown; readonly formula?: string }[] }
interface PdfReadInput extends FileInput { readonly pages?: readonly number[] }
interface PdfWriteInput extends FileInput { readonly pages: readonly { readonly text: string }[]; readonly metadata?: { readonly title?: string; readonly author?: string; readonly subject?: string } }
interface PdfEditInput extends FileInput { readonly operations: readonly Record<string, unknown>[] }
interface WordWriteInput extends FileInput { readonly blocks: readonly { readonly type: "paragraph" | "table"; readonly text?: string; readonly rows?: readonly (readonly string[])[] }[] }
interface WordEditInput extends FileInput { readonly replacements: readonly { readonly oldText: string; readonly newText: string; readonly replaceAll?: boolean }[] }

function asRecord(value: unknown, label = "参数"): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label}必须是对象`);
  return value as Record<string, unknown>;
}
function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${name} 必须是非空字符串`);
  return value;
}
function optionalString(value: unknown, name: string): string | undefined {
  return value === undefined ? undefined : requiredString(value, name);
}
function assertExtension(path: string, expected: string): void {
  if (extname(path).toLocaleLowerCase() !== expected) throw new Error(`只支持 ${expected} 文件：${path}`);
}
function parseFile(value: unknown): FileInput {
  return { path: requiredString(asRecord(value).path, "path") };
}

function resolveTarget(deps: DocumentToolDependencies, sessionId: string, workspaceId: string, path: string): { readonly workspaceId: string; readonly relativePath: string; readonly workspace: WorkspaceService } {
  if (deps.targetResolver !== undefined) return deps.targetResolver.resolve(sessionId, workspaceId, path);
  return { workspaceId, relativePath: path, workspace: deps.workspaces.get(workspaceId) };
}

async function readBinary(deps: DocumentToolDependencies, sessionId: string, workspaceId: string, path: string): Promise<{ readonly target: ReturnType<typeof resolveTarget>; readonly bytes: Uint8Array }> {
  const target = resolveTarget(deps, sessionId, workspaceId, path);
  const snapshot = await target.workspace.readBytes(target.relativePath);
  if (!snapshot.exists || snapshot.bytesBase64 === undefined) throw new Error(`文件不存在：${path}`);
  if (snapshot.byteLength > MAX_BINARY_BYTES) throw new Error(`文件超过 32 MiB：${path}`);
  return { target, bytes: Uint8Array.from(Buffer.from(snapshot.bytesBase64, "base64")) };
}

async function proposeBinary(
  deps: DocumentToolDependencies,
  input: FileInput,
  context: { readonly sessionId: string; readonly workspaceId: string; readonly toolCallId: string; readonly signal: AbortSignal },
  output: Uint8Array,
): Promise<unknown> {
  const target = resolveTarget(deps, context.sessionId, context.workspaceId, input.path);
  const proposal = await deps.diffs.proposeBinary({
    sessionId: context.sessionId,
    workspaceId: target.workspaceId,
    toolCallId: context.toolCallId,
    changes: [{ path: target.relativePath, afterBytes: output }],
  });
  return deps.diffReviews === undefined
    ? proposal
    : deps.diffReviews.awaitResolution(proposal.id, context.sessionId, context.signal);
}

function manifest(name: string, description: string, writable: boolean): Tool<unknown, unknown>["manifest"] {
  return {
    name,
    version: "1.0.0",
    description,
    inputSchema: { type: "object", properties: {}, additionalProperties: true },
    riskLevel: writable ? "workspace-write" : "workspace-read",
    capabilities: writable ? ["workspace.read", "workspace.propose"] : ["workspace.read"],
    generated: false,
  };
}

function parseExcelRead(value: unknown): ExcelReadInput {
  const r = asRecord(value); const sheet = optionalString(r.sheet, "sheet"); const range = optionalString(r.range, "range");
  return { path: requiredString(r.path, "path"), ...(sheet === undefined ? {} : { sheet }), ...(range === undefined ? {} : { range }) };
}
function parseExcelWrite(value: unknown): ExcelWriteInput {
  const r = asRecord(value); if (!Array.isArray(r.sheets) || r.sheets.length === 0) throw new Error("sheets 必须是非空数组");
  return { path: requiredString(r.path, "path"), sheets: r.sheets.map((item, index) => { const sheet = asRecord(item, `sheets[${index}]`); if (!Array.isArray(sheet.rows)) throw new Error("rows 必须是数组"); return { name: requiredString(sheet.name, "name"), rows: sheet.rows.filter(Array.isArray) as unknown[][] }; }) };
}
function parseExcelEdit(value: unknown): ExcelEditInput {
  const r = asRecord(value); if (!Array.isArray(r.operations) || r.operations.length === 0) throw new Error("operations 必须是非空数组");
  return { path: requiredString(r.path, "path"), operations: r.operations.map((item, index) => { const op = asRecord(item, `operations[${index}]`); if (op.value === undefined && typeof op.formula !== "string") throw new Error("操作必须包含 value 或 formula"); return { sheet: requiredString(op.sheet, "sheet"), cell: requiredString(op.cell, "cell"), ...(op.value === undefined ? {} : { value: op.value }), ...(typeof op.formula === "string" ? { formula: op.formula } : {}) }; }) };
}

function excelRead(deps: DocumentToolDependencies): Tool<ExcelReadInput, object> {
  return { manifest: manifest("ExcelRead", "读取 XLSX 工作表、单元格值和公式", false), validate: parseExcelRead, inspect: input => ({ affectedFiles: [input.path], certifiedComputerApplication: false }),
    permissions: input => toolPermission("read", [input.path]), execute: async (input, context) => {
    assertExtension(input.path, ".xlsx"); const source = await readBinary(deps, context.sessionId, context.workspaceId, input.path); const workbook = new Workbook(); await workbook.xlsx.load(Buffer.from(source.bytes) as never);
    const sheets = workbook.worksheets.map(item => item.name); const sheet = workbook.getWorksheet(input.sheet ?? sheets[0]); if (sheet === undefined) throw new Error(`工作表不存在：${input.sheet ?? ""}`);
    const range = input.range ?? (sheet.actualRowCount > 0 && sheet.actualColumnCount > 0 ? `A1:${sheet.getCell(sheet.actualRowCount, sheet.actualColumnCount).address}` : undefined); const values: unknown[][] = [];
    if (range !== undefined) { const match = /^([A-Z]+[0-9]+):([A-Z]+[0-9]+)$/i.exec(range); if (match !== null) { const start = sheet.getCell(match[1] ?? "A1"); const end = sheet.getCell(match[2] ?? "A1"); for (let row = start.row; row <= end.row; row += 1) { const line: unknown[] = []; for (let col = start.col; col <= end.col; col += 1) { const cell = sheet.getCell(row, col); line.push({ address: cell.address, value: cell.value }); } values.push(line); } } }
    return { path: input.path, sheets, sheet: sheet.name, range: input.range ?? null, values };
  }, serializeOutput: output => JSON.stringify(output) };
}

function excelWrite(deps: DocumentToolDependencies): Tool<ExcelWriteInput, unknown> {
  return { manifest: manifest("ExcelWrite", "创建 XLSX 工作簿并提交 Diff", true), validate: parseExcelWrite, inspect: input => ({ affectedFiles: [input.path], certifiedComputerApplication: false }),
    permissions: input => toolPermission("edit", [input.path]), execute: async (input, context) => { assertExtension(input.path, ".xlsx"); const workbook = new Workbook(); for (const source of input.sheets) { const sheet = workbook.addWorksheet(source.name); for (const row of source.rows) sheet.addRow([...row]); } return proposeBinary(deps, input, context, await workbook.xlsx.writeBuffer() as unknown as Uint8Array); }, serializeOutput: output => JSON.stringify(output) };
}

function excelEdit(deps: DocumentToolDependencies): Tool<ExcelEditInput, unknown> {
  return { manifest: manifest("ExcelEdit", "修改 XLSX 单元格并提交 Diff", true), validate: parseExcelEdit, inspect: input => ({ affectedFiles: [input.path], certifiedComputerApplication: false }),
    permissions: input => toolPermission("edit", [input.path]), execute: async (input, context) => { assertExtension(input.path, ".xlsx"); const source = await readBinary(deps, context.sessionId, context.workspaceId, input.path); const workbook = new Workbook(); await workbook.xlsx.load(Buffer.from(source.bytes) as never); for (const op of input.operations) { const sheet = workbook.getWorksheet(op.sheet); if (sheet === undefined) throw new Error(`工作表不存在：${op.sheet}`); sheet.getCell(op.cell).value = op.formula === undefined ? op.value as never : { formula: op.formula, result: op.value as never }; } return proposeBinary(deps, input, context, await workbook.xlsx.writeBuffer() as unknown as Uint8Array); }, serializeOutput: output => JSON.stringify(output) };
}

function parsePdfRead(value: unknown): PdfReadInput { const r = asRecord(value); const pages = Array.isArray(r.pages) ? r.pages.filter(Number.isInteger).map(Number) : undefined; return { path: requiredString(r.path, "path"), ...(pages === undefined ? {} : { pages }) }; }
function parsePdfWrite(value: unknown): PdfWriteInput { const r = asRecord(value); if (!Array.isArray(r.pages) || r.pages.length === 0) throw new Error("pages 必须是非空数组"); const metadata = typeof r.metadata === "object" && r.metadata !== null ? r.metadata as PdfWriteInput["metadata"] : undefined; return { path: requiredString(r.path, "path"), pages: r.pages.map(item => ({ text: requiredString(asRecord(item).text, "text") })), ...(metadata === undefined ? {} : { metadata }) }; }
function parsePdfEdit(value: unknown): PdfEditInput { const r = asRecord(value); if (!Array.isArray(r.operations) || r.operations.length === 0) throw new Error("operations 必须是非空数组"); return { path: requiredString(r.path, "path"), operations: r.operations.map(item => asRecord(item)) }; }
async function pdfFont(document: PDFDocument) { document.registerFontkit(fontkit); for (const candidate of ["C:\\Windows\\Fonts\\msyh.ttc", "C:\\Windows\\Fonts\\simhei.ttf", "C:\\Windows\\Fonts\\arial.ttf"]) { try { return await document.embedFont(await readFile(candidate)); } catch { /* fixed Windows candidates only */ } } return document.embedFont(StandardFonts.Helvetica); }

function pdfRead(deps: DocumentToolDependencies): Tool<PdfReadInput, object> {
  return {
    manifest: manifest("PdfRead", "读取 PDF 页数、文本和元数据", false),
    validate: parsePdfRead,
    inspect: input => ({ affectedFiles: [input.path], certifiedComputerApplication: false }),
    permissions: input => toolPermission("read", [input.path]),
    execute: async (input, context) => {
      assertExtension(input.path, ".pdf");
      const source = await readBinary(deps, context.sessionId, context.workspaceId, input.path);
      const document = await PDFDocument.load(source.bytes);
      const pages = input.pages ?? [...Array(document.getPageCount()).keys()];
      const parsed = await getDocument({ data: source.bytes, useSystemFonts: true }).promise;
      const texts = await Promise.all(pages.filter(index => index >= 0 && index < document.getPageCount()).map(async index => {
        const page = await parsed.getPage(index + 1);
        const content = await page.getTextContent();
        return { index, text: content.items.map(item => "str" in item ? item.str : "").join("") };
      }));
      return { path: input.path, pageCount: document.getPageCount(), pages: texts, title: document.getTitle() ?? null, author: document.getAuthor() ?? null, subject: document.getSubject() ?? null };
    },
    serializeOutput: output => JSON.stringify(output),
  };
}
function pdfWrite(deps: DocumentToolDependencies): Tool<PdfWriteInput, unknown> {
  return { manifest: manifest("PdfWrite", "创建 PDF 并提交 Diff", true), validate: parsePdfWrite, inspect: input => ({ affectedFiles: [input.path], certifiedComputerApplication: false }),
    permissions: input => toolPermission("edit", [input.path]), execute: async (input, context) => { assertExtension(input.path, ".pdf"); const document = await PDFDocument.create(); const font = await pdfFont(document); if (input.metadata?.title !== undefined) document.setTitle(input.metadata.title); if (input.metadata?.author !== undefined) document.setAuthor(input.metadata.author); if (input.metadata?.subject !== undefined) document.setSubject(input.metadata.subject); for (const item of input.pages) { const page = document.addPage(); page.drawText(item.text, { x: 48, y: page.getHeight() - 72, size: 12, font, color: rgb(0, 0, 0) }); } return proposeBinary(deps, input, context, await document.save()); }, serializeOutput: output => JSON.stringify(output) };
}
function pdfEdit(deps: DocumentToolDependencies): Tool<PdfEditInput, unknown> {
  return {
    manifest: manifest("PdfEdit", "执行 PDF 页面级编辑并提交 Diff" , true),
    validate: parsePdfEdit,
    inspect: input => ({ affectedFiles: [input.path], certifiedComputerApplication: false }),
    permissions: input => toolPermission("edit", [input.path]),
    execute: async (input, context) => {
      assertExtension(input.path, ".pdf");
      const source = await readBinary(deps, context.sessionId, context.workspaceId, input.path);
      let document = await PDFDocument.load(source.bytes);
      for (const operation of input.operations) {
        const type = requiredString(operation.type, "operations.type");
        if (type === "deletePage") {
          document.removePage(Number(operation.index));
        } else if (type === "movePage") {
          const from = Number(operation.from); const to = Number(operation.to);
          const order = [...Array(document.getPageCount()).keys()]; const [moved] = order.splice(from, 1);
          if (moved === undefined || to < 0 || to >= order.length + 1) throw new Error("PDF 页面索引无效");
          order.splice(to, 0, moved);
          const reordered = await PDFDocument.create();
          const copied = await reordered.copyPages(document, order);
          copied.forEach(page => reordered.addPage(page));
          document = reordered;
        } else if (type === "setMetadata") {
          if (typeof operation.title === "string") document.setTitle(operation.title);
          if (typeof operation.author === "string") document.setAuthor(operation.author);
          if (typeof operation.subject === "string") document.setSubject(operation.subject);
        } else if (type === "appendPage") {
          const page = document.addPage();
          page.drawText(requiredString(operation.text, "operations.text"), { x: 48, y: page.getHeight() - 72, size: 12, font: await pdfFont(document) });
        } else if (type === "overlayText") {
          const page = document.getPage(Number(operation.index));
          page.drawText(requiredString(operation.text, "operations.text"), { x: Number(operation.x ?? 48), y: Number(operation.y ?? 72), size: Number(operation.size ?? 12), font: await pdfFont(document) });
        } else throw new Error(`不支持的 PDF 操作：${type}`);
      }
      return proposeBinary(deps, input, context, await document.save());
    },
    serializeOutput: output => JSON.stringify(output),
  };
}

function parseWordWrite(value: unknown): WordWriteInput { const r = asRecord(value); if (!Array.isArray(r.blocks) || r.blocks.length === 0) throw new Error("blocks 必须是非空数组"); return { path: requiredString(r.path, "path"), blocks: r.blocks.map(item => { const block = asRecord(item); return { type: block.type === "table" ? "table" : "paragraph", ...(typeof block.text === "string" ? { text: block.text } : {}), ...(Array.isArray(block.rows) ? { rows: block.rows.filter(Array.isArray) as string[][] } : {}) }; }) }; }
function wordRead(deps: DocumentToolDependencies): Tool<FileInput, object> {
  return {
    manifest: manifest("WordRead", "读取 DOCX 正文、段落和表格文本", false),
    validate: parseFile,
    inspect: input => ({ affectedFiles: [input.path], certifiedComputerApplication: false }),
    permissions: input => toolPermission("read", [input.path]),
    execute: async (input, context) => {
      assertExtension(input.path, ".docx"); const source = await readBinary(deps, context.sessionId, context.workspaceId, input.path); const result = await mammoth.extractRawText({ buffer: source.bytes });
      const zip = await JSZip.loadAsync(source.bytes); const entry = zip.file("word/document.xml"); const xml = entry === null ? "" : await entry.async("string");
      const tables = [...xml.matchAll(/<w:tbl[\s\S]*?<\/w:tbl>/g)].map(match => [...(match[0] ?? "").matchAll(/<w:tr[\s\S]*?<\/w:tr>/g)].map(row => [...(row[0] ?? "").matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g)].map(cell => decodeXml(cell[1] ?? ""))));
      return { path: input.path, text: result.value, paragraphs: result.value.split(/\r?\n/).filter(Boolean), tables, messages: result.messages };
    },
    serializeOutput: output => JSON.stringify(output),
  };
}
function wordWrite(deps: DocumentToolDependencies): Tool<WordWriteInput, unknown> { return { manifest: manifest("WordWrite", "创建 DOCX 并提交 Diff", true), validate: parseWordWrite, inspect: input => ({ affectedFiles: [input.path], certifiedComputerApplication: false }),
    permissions: input => toolPermission("edit", [input.path]), execute: async (input, context) => { assertExtension(input.path, ".docx"); const children = input.blocks.map(block => block.type === "table" ? new Table({ rows: (block.rows ?? []).map(row => new TableRow({ children: row.map(text => new TableCell({ children: [new Paragraph(text)] })) })) }) : new Paragraph(block.text ?? "")); return proposeBinary(deps, input, context, await Packer.toBuffer(new Document({ sections: [{ children }] })) as unknown as Uint8Array); }, serializeOutput: output => JSON.stringify(output) }; }
function wordEdit(deps: DocumentToolDependencies): Tool<WordEditInput, unknown> {
  return {
    manifest: manifest("WordEdit", "在 DOCX 同一文本 run 内替换并提交 Diff", true),
    validate: value => {
      const r = asRecord(value); if (!Array.isArray(r.replacements) || r.replacements.length === 0) throw new Error("replacements 必须是非空数组");
      return { path: requiredString(r.path, "path"), replacements: r.replacements.map(item => { const x = asRecord(item); return { oldText: requiredString(x.oldText, "oldText"), newText: typeof x.newText === "string" ? x.newText : "", ...(x.replaceAll === true ? { replaceAll: true } : {}) }; }) };
    },
    inspect: input => ({ affectedFiles: [input.path], certifiedComputerApplication: false }),
    permissions: input => toolPermission("edit", [input.path]),
    execute: async (input, context) => {
      assertExtension(input.path, ".docx"); const source = await readBinary(deps, context.sessionId, context.workspaceId, input.path); const zip = await JSZip.loadAsync(source.bytes); const entry = zip.file("word/document.xml"); if (entry === null) throw new Error("DOCX 缺少 word/document.xml"); let xml = await entry.async("string");
      for (const replacement of input.replacements) {
        const oldEncoded = escapeXml(replacement.oldText); const newEncoded = escapeXml(replacement.newText); let count = 0;
        xml = xml.replace(/(<w:t[^>]*>)([^<]*)(<\/w:t>)/g, (all, open: string, body: string, close: string) => {
          if (!body.includes(oldEncoded) || (replacement.replaceAll !== true && count > 0)) return all;
          count += 1; return `${open}${body.split(oldEncoded).join(newEncoded)}${close}`;
        });
        if (count === 0) throw new Error(`DOCX 未找到同一文本 run：${replacement.oldText}`);
      }
      zip.file("word/document.xml", xml); return proposeBinary(deps, input, context, await zip.generateAsync({ type: "uint8array" }));
    },
    serializeOutput: output => JSON.stringify(output),
  };
}

function escapeXml(value: string): string { return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\"/g, "&quot;").replace(/'/g, "&apos;"); }
function decodeXml(value: string): string { return value.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&apos;/g, "'").replace(/&amp;/g, "&"); }
function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

export function createDocumentTools(dependencies: DocumentToolDependencies): readonly Tool<unknown, unknown>[] {
  return [excelRead(dependencies), excelEdit(dependencies), excelWrite(dependencies), pdfRead(dependencies), pdfEdit(dependencies), pdfWrite(dependencies), wordRead(dependencies), wordEdit(dependencies), wordWrite(dependencies)];
}
