export interface TuiInputBufferState {
  readonly text: string;
  readonly cursor: number;
  readonly history: readonly string[];
  readonly historyIndex: number;
  readonly historyDraft: string;
}

export interface TuiInputKey {
  readonly ctrl?: boolean;
  readonly meta?: boolean;
  readonly shift?: boolean;
  readonly return?: boolean;
  readonly backspace?: boolean;
  readonly delete?: boolean;
  readonly left?: boolean;
  readonly right?: boolean;
  readonly home?: boolean;
  readonly end?: boolean;
  readonly up?: boolean;
  readonly down?: boolean;
  /** Ink 7 key names. The short aliases remain for pure reducer tests. */
  readonly upArrow?: boolean;
  readonly downArrow?: boolean;
  readonly leftArrow?: boolean;
  readonly rightArrow?: boolean;
  readonly clearLine?: boolean;
  readonly deleteWord?: boolean;
  readonly deleteToEnd?: boolean;
}

export interface TuiInputTransition {
  readonly state: TuiInputBufferState;
  readonly submitted?: string;
}

export function searchTuiHistory(history: readonly string[], query: string, from = -1): { readonly value?: string; readonly index: number } {
  for (let index = Math.max(0, from + 1); index < history.length; index += 1) {
    const value = history[index] ?? "";
    if (value.toLocaleLowerCase().includes(query.toLocaleLowerCase())) return { value, index };
  }
  return { index: -1 };
}

export function createTuiInputBuffer(): TuiInputBufferState {
  return { text: "", cursor: 0, history: [], historyIndex: -1, historyDraft: "" };
}

export function reduceTuiInput(
  current: TuiInputBufferState,
  value: string,
  key: TuiInputKey,
): TuiInputTransition {
  if (key.return) {
    if (key.shift || key.meta) {
      const inserted = "\n";
      return { state: { ...current, text: current.text.slice(0, current.cursor) + inserted + current.text.slice(current.cursor), cursor: current.cursor + 1, historyIndex: -1 } };
    }
    const submitted = current.text;
    if (submitted.trim() === "") return { state: current };
    const history = current.history[0] === submitted
      ? current.history
      : [submitted, ...current.history].slice(0, 500);
    return { submitted, state: { ...createTuiInputBuffer(), history } };
  }
  if (key.left || key.leftArrow) return { state: { ...current, cursor: Math.max(0, current.cursor - 1), historyIndex: -1 } };
  if (key.right || key.rightArrow) return { state: { ...current, cursor: Math.min(current.text.length, current.cursor + 1), historyIndex: -1 } };
  if (key.home || (key.ctrl && value.toLocaleLowerCase() === "a")) return { state: { ...current, cursor: 0, historyIndex: -1 } };
  if (key.end || (key.ctrl && value.toLocaleLowerCase() === "e")) return { state: { ...current, cursor: current.text.length, historyIndex: -1 } };
  if (key.up || key.upArrow) return { state: historyMove(current, -1) };
  if (key.down || key.downArrow) return { state: historyMove(current, 1) };
  if (key.clearLine || (key.ctrl && value.toLocaleLowerCase() === "u")) {
    return { state: { ...current, text: "", cursor: 0, historyIndex: -1 } };
  }
  if (key.deleteToEnd || (key.ctrl && value.toLocaleLowerCase() === "k")) {
    return { state: { ...current, text: current.text.slice(0, current.cursor), historyIndex: -1 } };
  }
  if (key.deleteWord || (key.ctrl && value.toLocaleLowerCase() === "w")) {
    const before = current.text.slice(0, current.cursor);
    const trimmed = before.replace(/\s+$/, "");
    const wordStart = trimmed.lastIndexOf(" ") + 1;
    const nextText = trimmed.slice(0, wordStart) + current.text.slice(current.cursor);
    return {
      state: {
        ...current,
        text: nextText,
        cursor: wordStart,
        historyIndex: -1,
      },
    };
  }
  if (key.backspace || (key.ctrl && value.toLocaleLowerCase() === "h")) {
    if (current.cursor === 0) return { state: current };
    return {
      state: {
        ...current,
        text: current.text.slice(0, current.cursor - 1) + current.text.slice(current.cursor),
        cursor: current.cursor - 1,
        historyIndex: -1,
      },
    };
  }
  if (key.delete) {
    if (current.cursor >= current.text.length) return { state: current };
    return { state: { ...current, text: current.text.slice(0, current.cursor) + current.text.slice(current.cursor + 1), historyIndex: -1 } };
  }
  if (value !== "" && !key.ctrl && !key.meta) {
    return {
      state: {
        ...current,
        text: current.text.slice(0, current.cursor) + value + current.text.slice(current.cursor),
        cursor: current.cursor + value.length,
        historyIndex: -1,
      },
    };
  }
  return { state: current };
}

function historyMove(current: TuiInputBufferState, direction: -1 | 1): TuiInputBufferState {
  if (current.history.length === 0) return current;
  if (direction < 0) {
    const nextIndex = current.historyIndex < 0
      ? 0
      : Math.min(current.history.length - 1, current.historyIndex + 1);
    return {
      ...current,
      text: current.history[nextIndex] ?? "",
      cursor: (current.history[nextIndex] ?? "").length,
      historyIndex: nextIndex,
      historyDraft: current.historyIndex < 0 ? current.text : current.historyDraft,
    };
  }
  if (current.historyIndex < 0) return current;
  const nextIndex = current.historyIndex - 1;
  if (nextIndex < 0) return { ...current, text: current.historyDraft, cursor: current.historyDraft.length, historyIndex: -1 };
  return {
    ...current,
    text: current.history[nextIndex] ?? "",
    cursor: (current.history[nextIndex] ?? "").length,
    historyIndex: nextIndex,
  };
}
