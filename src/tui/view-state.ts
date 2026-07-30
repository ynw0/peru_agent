import type { TuiSetupDraft, TuiHealthReport } from "./config.js";
import { createTuiInputBuffer, reduceTuiInput, type TuiInputBufferState, type TuiInputKey } from "./input-buffer.js";

export interface TuiViewportState {
  /** 渲染后的终端行数，而不是消息/对象数量。 */
  readonly total: number;
  readonly pageSize: number;
  /** 0 表示跟随末尾，数值越大表示越靠前。 */
  readonly offset: number;
  readonly unread: number;
}

export interface TuiViewportKey {
  readonly pageUp?: boolean;
  readonly pageDown?: boolean;
  readonly ctrl?: boolean;
  readonly home?: boolean;
  readonly end?: boolean;
  readonly wheel?: "up" | "down";
  readonly wheelAmount?: number;
}

export function createTuiViewport(total = 0, pageSize = 1): TuiViewportState {
  return { total: Math.max(0, total), pageSize: Math.max(1, pageSize), offset: 0, unread: 0 };
}

export function reduceTuiViewport(
  current: TuiViewportState,
  key: TuiViewportKey,
  total = current.total,
  pageSize = current.pageSize,
): TuiViewportState {
  const nextTotal = Math.max(0, total);
  const nextPageSize = Math.max(1, pageSize);
  const maxOffset = Math.max(0, nextTotal - nextPageSize);
  let nextOffset = Math.min(current.offset, maxOffset);
  const added = Math.max(0, nextTotal - current.total);
  const wasFollowing = current.offset === 0;
  // Keep the same absolute content in view while new output arrives above the
  // user's viewport. Offset is measured from the tail, so new items increase
  // it by the number of appended items.
  if (!wasFollowing && added > 0 && key.pageUp !== true && key.pageDown !== true
    && !(key.ctrl === true && (key.home === true || key.end === true))) {
    nextOffset = Math.min(maxOffset, nextOffset + added);
  }
  if (key.pageUp === true) nextOffset = Math.min(maxOffset, nextOffset + nextPageSize);
  if (key.pageDown === true) nextOffset = Math.max(0, nextOffset - nextPageSize);
  if (key.ctrl === true && key.home === true) nextOffset = maxOffset;
  if (key.ctrl === true && key.end === true) nextOffset = 0;
  if (key.wheel === "up") nextOffset = Math.min(maxOffset, nextOffset + Math.max(1, key.wheelAmount ?? 3));
  if (key.wheel === "down") nextOffset = Math.max(0, nextOffset - Math.max(1, key.wheelAmount ?? 3));

  const isFollowing = nextOffset === 0;
  return {
    total: nextTotal,
    pageSize: nextPageSize,
    offset: nextOffset,
    unread: isFollowing ? 0 : (wasFollowing ? 0 : current.unread + added),
  };
}

export function markTuiViewportRead(current: TuiViewportState): TuiViewportState {
  return { ...current, unread: 0 };
}

export function getTuiViewportRange(state: TuiViewportState): { readonly start: number; readonly end: number } {
  const end = Math.max(0, state.total - state.offset);
  return { start: Math.max(0, end - state.pageSize), end };
}

export function clampTuiSelection(selected: number, count: number): number {
  return count <= 0 ? 0 : Math.min(Math.max(0, selected), count - 1);
}

export function moveTuiSelection(selected: number, count: number, direction: -1 | 1): number {
  if (count <= 0) return 0;
  return (clampTuiSelection(selected, count) + direction + count) % count;
}

export type TuiReviewDecision = "accept" | "reject";

/**
 * Permission 和 Diff 共用同一套安全审核键。Esc 永远等价于拒绝，
 * A 接受，D/R 拒绝；其他按键只用于浏览，不产生审核结果。
 */
export function getTuiReviewDecision(
  value: string,
  key: { readonly escape?: boolean },
): TuiReviewDecision | undefined {
  const normalized = value.toLocaleLowerCase();
  if (normalized === "a") return "accept";
  if (normalized === "d" || normalized === "r" || key.escape === true) return "reject";
  return undefined;
}

export const TUI_CONFIGURATION_FIELDS = [
  "baseUrl",
  "chatCompletionsPath",
  "model",
  "apiKey",
  "contextWindowTokens",
  "permissionMode",
  "networkMode",
  "save",
] as const;

export type TuiConfigurationField = typeof TUI_CONFIGURATION_FIELDS[number];

export interface TuiConfigurationEditorState {
  readonly draft: TuiSetupDraft;
  readonly fieldIndex: number;
  readonly input: TuiInputBufferState;
  /** 当前字段输入的水平窗口，避免长路径/端点把光标推出终端。 */
  readonly horizontalOffset: number;
  readonly horizontalWidth: number;
  readonly busy: boolean;
  readonly status: string;
  readonly health?: TuiHealthReport;
}

export interface TuiConfigurationEditorKey extends TuiInputKey {
  readonly escape?: boolean;
  readonly tab?: boolean;
}

export interface TuiConfigurationEditorTransition {
  readonly state: TuiConfigurationEditorState;
  readonly submitted?: TuiSetupDraft;
  readonly cancelled?: boolean;
}

export function createTuiConfigurationEditor(
  draft: TuiSetupDraft,
  status = "首次启动需要完成本地配置。API Key 只从环境变量读取。",
): TuiConfigurationEditorState {
  return {
    draft,
    fieldIndex: 0,
    input: createTuiInputBufferForField(draft, TUI_CONFIGURATION_FIELDS[0]),
    horizontalOffset: 0,
    horizontalWidth: 60,
    busy: false,
    status,
  };
}

export function setTuiConfigurationEditorStatus(
  state: TuiConfigurationEditorState,
  status: string,
  health?: TuiHealthReport,
): TuiConfigurationEditorState {
  return {
    ...state,
    status,
    ...(health === undefined ? {} : { health }),
  };
}

export function setTuiConfigurationEditorBusy(
  state: TuiConfigurationEditorState,
  busy: boolean,
): TuiConfigurationEditorState {
  return { ...state, busy };
}

export function setTuiConfigurationEditorWidth(
  state: TuiConfigurationEditorState,
  width: number,
): TuiConfigurationEditorState {
  const horizontalWidth = Math.max(8, Math.floor(width));
  return normalizeConfigurationViewport({ ...state, horizontalWidth });
}

export function reduceTuiConfigurationEditor(
  current: TuiConfigurationEditorState,
  value: string,
  key: TuiConfigurationEditorKey,
): TuiConfigurationEditorTransition {
  if (current.busy) return { state: current };
  if (key.ctrl === true && value.toLocaleLowerCase() === "c") return { state: current, cancelled: true };
  if (key.escape === true) return { state: current, cancelled: true };

  if (key.up === true || key.upArrow === true || key.down === true || key.downArrow === true || key.tab === true) {
    const direction = key.up === true || key.upArrow === true ? -1 : 1;
    return { state: switchConfigurationField(current, current.fieldIndex + direction) };
  }

  const field = TUI_CONFIGURATION_FIELDS[current.fieldIndex] ?? "save";
  if (field === "save" && key.return === true) {
    return { state: flushConfigurationField(current), submitted: flushConfigurationField(current).draft };
  }
  if (isChoiceField(field) && (key.left === true || key.leftArrow === true || key.right === true || key.rightArrow === true || value === " ")) {
    return { state: updateConfigurationChoice(current, key.right === true || key.rightArrow === true || value === " " ? 1 : -1) };
  }
  if (key.return === true) return { state: switchConfigurationField(current, current.fieldIndex + 1) };

  const inputTransition = reduceTuiInput(current.input, value, key);
  return {
    state: normalizeConfigurationViewport({
      ...current,
      input: inputTransition.state,
      draft: updateConfigurationField(current.draft, field, inputTransition.state.text),
    }),
  };
}

function switchConfigurationField(
  current: TuiConfigurationEditorState,
  requestedIndex: number,
): TuiConfigurationEditorState {
  const nextIndex = Math.min(Math.max(0, requestedIndex), TUI_CONFIGURATION_FIELDS.length - 1);
  const flushed = flushConfigurationField(current);
  const nextField = TUI_CONFIGURATION_FIELDS[nextIndex] ?? "save";
  return {
    ...flushed,
    fieldIndex: nextIndex,
    input: createTuiInputBufferForField(flushed.draft, nextField),
    horizontalOffset: 0,
  };
}

function flushConfigurationField(current: TuiConfigurationEditorState): TuiConfigurationEditorState {
  const field = TUI_CONFIGURATION_FIELDS[current.fieldIndex] ?? "save";
  return { ...current, draft: updateConfigurationField(current.draft, field, current.input.text) };
}

function createTuiInputBufferForField(draft: TuiSetupDraft, field: TuiConfigurationField): TuiInputBufferState {
  const value = getConfigurationFieldValue(draft, field);
  return { ...createTuiInputBuffer(), text: value, cursor: value.length };
}

function getConfigurationFieldValue(draft: TuiSetupDraft, field: TuiConfigurationField): string {
  if (field === "save") return "Enter 执行 / Esc 取消";
  return draft[field];
}

function updateConfigurationField(draft: TuiSetupDraft, field: TuiConfigurationField, value: string): TuiSetupDraft {
  if (field === "save" || isChoiceField(field)) return draft;
  return { ...draft, [field]: value } as TuiSetupDraft;
}

function isChoiceField(field: TuiConfigurationField): field is "permissionMode" | "networkMode" {
  return field === "permissionMode" || field === "networkMode";
}

function updateConfigurationChoice(current: TuiConfigurationEditorState, direction: -1 | 1): TuiConfigurationEditorState {
  const field = TUI_CONFIGURATION_FIELDS[current.fieldIndex];
  if (field === "permissionMode") {
    return switchChoice(current, {
      permissionMode: current.draft.permissionMode === "default" ? "autoReview" : "default",
    });
  }
  if (field === "networkMode") {
    const modes = ["offline", "lan", "internet"] as const;
    const index = modes.indexOf(current.draft.networkMode);
    const next = modes[(index + direction + modes.length) % modes.length] ?? "offline";
    return switchChoice(current, { networkMode: next });
  }
  return current;
}

function switchChoice(current: TuiConfigurationEditorState, change: Partial<TuiSetupDraft>): TuiConfigurationEditorState {
  const draft = { ...current.draft, ...change };
  const field = TUI_CONFIGURATION_FIELDS[current.fieldIndex] ?? "save";
  return normalizeConfigurationViewport({ ...current, draft, input: createTuiInputBufferForField(draft, field), horizontalOffset: 0 });
}

function normalizeConfigurationViewport(state: TuiConfigurationEditorState): TuiConfigurationEditorState {
  const cursor = state.input.cursor;
  const width = state.horizontalWidth;
  const horizontalOffset = cursor < state.horizontalOffset
    ? cursor
    : cursor > state.horizontalOffset + width
      ? cursor - width
      : state.horizontalOffset;
  return { ...state, horizontalOffset: Math.max(0, horizontalOffset) };
}
