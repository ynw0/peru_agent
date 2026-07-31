import type { WorkbenchSnapshot } from "../workbench/workbench-state.js";
import {
  flattenTuiConversationTurns,
  layoutTuiLines,
  type TuiConversationTurn,
  type TuiRenderedLine,
} from "./terminal-layout.js";

export interface TuiStaticHistoryItem {
  readonly id: string;
  readonly kind: "session" | "turn";
  readonly label?: string;
  readonly lines: readonly TuiRenderedLine[];
}

export interface TuiStaticHistoryState {
  readonly sessionId: string;
  readonly generation: number;
  readonly turnIds: readonly string[];
  readonly items: TuiStaticHistoryItem[];
}

export interface TuiTerminalTurnSplit {
  readonly completedTurns: readonly TuiConversationTurn[];
  readonly liveTurns: readonly TuiConversationTurn[];
}

/**
 * 只有当前 activeRun 产生的 Turn 保持动态；所有已结束 Turn 都可以安全地
 * 交给 Ink Static，进入终端原生 scrollback。
 */
export function splitTuiTurnsForNativeTerminal(
  turns: readonly TuiConversationTurn[],
  snapshot: WorkbenchSnapshot,
): TuiTerminalTurnSplit {
  const activeRunId = snapshot.activeRunId;
  if (activeRunId === undefined) return { completedTurns: turns, liveTurns: [] };

  const activeMessageIds = new Set(
    snapshot.chatMessages
      .filter(message => message.runId === activeRunId)
      .map(message => message.id),
  );
  if (activeMessageIds.size === 0) return { completedTurns: turns, liveTurns: [] };

  const liveIndex = turns.findIndex(turn => activeMessageIds.has(turn.id));
  if (liveIndex < 0) return { completedTurns: turns, liveTurns: [] };
  return {
    completedTurns: turns.slice(0, liveIndex),
    liveTurns: turns.slice(liveIndex),
  };
}

export function createTuiStaticHistoryState(
  sessionId: string,
  sessionLabel: string,
  turns: readonly TuiConversationTurn[],
  width: number,
  verbose: boolean,
): TuiStaticHistoryState {
  return {
    sessionId,
    generation: 0,
    turnIds: turns.map(turn => turn.id),
    items: [sessionItem(sessionId, sessionLabel), ...turns.map(turn => turnItem(turn, width, verbose))],
  };
}

/**
 * Static 只接受追加。若会话切换、压缩或恢复导致历史不再是旧历史的前缀，
 * 创建新的 Static 边界并打印明确的会话分隔，绝不重放旧边界中的条目。
 */
export function reconcileTuiStaticHistory(
  current: TuiStaticHistoryState,
  sessionId: string,
  sessionLabel: string,
  turns: readonly TuiConversationTurn[],
  width: number,
  verbose: boolean,
): TuiStaticHistoryState {
  const nextIds = turns.map(turn => turn.id);
  const sameSession = current.sessionId === sessionId;
  const appendOnly = sameSession
    && current.turnIds.length <= nextIds.length
    && current.turnIds.every((id, index) => nextIds[index] === id);

  if (!appendOnly) {
    return {
      sessionId,
      generation: current.generation + 1,
      turnIds: nextIds,
      items: [sessionItem(sessionId, sessionLabel), ...turns.map(turn => turnItem(turn, width, verbose))],
    };
  }

  if (current.turnIds.length === nextIds.length) return current;
  const appended = turns.slice(current.turnIds.length).map(turn => turnItem(turn, width, verbose));
  return {
    ...current,
    turnIds: nextIds,
    items: [...current.items, ...appended],
  };
}

function sessionItem(sessionId: string, sessionLabel: string): TuiStaticHistoryItem {
  return {
    id: `session:${sessionId}`,
    kind: "session",
    label: sessionLabel,
    lines: [],
  };
}

function turnItem(
  turn: TuiConversationTurn,
  width: number,
  verbose: boolean,
): TuiStaticHistoryItem {
  const entries = flattenTuiConversationTurns([turn], verbose);
  return {
    id: `turn:${turn.id}`,
    kind: "turn",
    lines: layoutTuiLines(entries, width, { verbose }).lines,
  };
}
