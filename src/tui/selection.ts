import sliceAnsi from "slice-ansi";
import stringWidth from "string-width";
import type { TuiRenderedLine } from "./terminal-layout.js";
import type { TuiMouseEvent } from "./mouse.js";

export interface TuiSelectionAnchor {
  readonly entryId: string;
  readonly lineIndex: number;
  readonly column: number;
}

export interface TuiTextSelection {
  readonly start: TuiSelectionAnchor;
  readonly end: TuiSelectionAnchor;
}

export function anchorAtMouse(
  event: TuiMouseEvent,
  lines: readonly TuiRenderedLine[],
  timelineTopRow: number,
  contentLeftColumn = 4,
): TuiSelectionAnchor | undefined {
  if (event.y < timelineTopRow || event.y >= timelineTopRow + lines.length) return undefined;
  const line = lines[event.y - timelineTopRow];
  if (line === undefined) return undefined;
  const column = Math.max(0, Math.min(stringWidth(line.text), event.x - contentLeftColumn));
  return { entryId: line.entryId, lineIndex: line.lineIndex, column };
}

export function compareSelectionAnchors(
  left: TuiSelectionAnchor,
  right: TuiSelectionAnchor,
  lines: readonly TuiRenderedLine[],
): number {
  const leftIndex = anchorLinePosition(left, lines);
  const rightIndex = anchorLinePosition(right, lines);
  if (leftIndex !== rightIndex) return leftIndex - rightIndex;
  return left.column - right.column;
}

export function normalizeSelection(selection: TuiTextSelection, lines: readonly TuiRenderedLine[]): TuiTextSelection {
  return compareSelectionAnchors(selection.start, selection.end, lines) <= 0
    ? selection
    : { start: selection.end, end: selection.start };
}

export function selectionForMouse(
  current: TuiTextSelection | undefined,
  event: TuiMouseEvent,
  lines: readonly TuiRenderedLine[],
  timelineTopRow: number,
  contentLeftColumn = 4,
): TuiTextSelection | undefined {
  const anchor = anchorAtMouse(event, lines, timelineTopRow, contentLeftColumn);
  if (anchor === undefined) {
    if (event.kind === "press" && event.button === "left") return undefined;
    return current;
  }
  if (event.kind === "press" && event.button === "left") return { start: anchor, end: anchor };
  if ((event.kind === "move" || event.kind === "release") && current !== undefined) {
    return { start: current.start, end: anchor };
  }
  return current;
}

export function selectionIsCollapsed(selection: TuiTextSelection | undefined): boolean {
  return selection === undefined
    || (selection.start.entryId === selection.end.entryId
      && selection.start.lineIndex === selection.end.lineIndex
      && selection.start.column === selection.end.column);
}

export function selectedText(
  lines: readonly TuiRenderedLine[],
  selection: TuiTextSelection | undefined,
  clickedLine?: TuiRenderedLine,
): string {
  if (selectionIsCollapsed(selection)) {
    if (clickedLine === undefined) return "";
    return stripAnsi(clickedLine.text);
  }
  const normalized = normalizeSelection(selection!, lines);
  const start = anchorLinePosition(normalized.start, lines);
  const end = anchorLinePosition(normalized.end, lines);
  const parts: string[] = [];
  for (let index = start; index <= end; index += 1) {
    const line = lines[index];
    if (line === undefined) continue;
    const from = index === start ? normalized.start.column : 0;
    const to = index === end ? normalized.end.column : stringWidth(line.text);
    parts.push(stripAnsi(sliceAnsi(line.text, from, Math.max(from, to))));
  }
  return parts.join("\n");
}

export function selectionColumnsForLine(
  line: TuiRenderedLine,
  linePosition: number,
  lines: readonly TuiRenderedLine[],
  selection: TuiTextSelection | undefined,
): { readonly start: number; readonly end: number } | undefined {
  if (selectionIsCollapsed(selection)) return undefined;
  const normalized = normalizeSelection(selection!, lines);
  const startPosition = anchorLinePosition(normalized.start, lines);
  const endPosition = anchorLinePosition(normalized.end, lines);
  if (linePosition < startPosition || linePosition > endPosition) return undefined;
  return {
    start: linePosition === startPosition ? normalized.start.column : 0,
    end: linePosition === endPosition ? normalized.end.column : stringWidth(line.text),
  };
}

function anchorLinePosition(anchor: TuiSelectionAnchor, lines: readonly TuiRenderedLine[]): number {
  const exact = lines.findIndex(line => line.entryId === anchor.entryId && line.lineIndex === anchor.lineIndex);
  if (exact >= 0) return exact;
  const entry = lines.findIndex(line => line.entryId === anchor.entryId);
  return entry >= 0 ? entry : 0;
}

function stripAnsi(value: string): string {
  return value.replace(/[\u001B\u009B][[\]()#;?]*(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*)?\u0007|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g, "");
}
