import wrapAnsi from "wrap-ansi";
import stringWidth from "string-width";
import sliceAnsi from "slice-ansi";
import type {
  AgentMessage,
  AgentSessionSnapshot,
  ToolAgentMessage,
} from "../agent/types.js";
import type { ToolActivityView, WorkbenchSnapshot } from "../workbench/workbench-state.js";

/** 时间线条目是 TUI 唯一的渲染中间表示；内容仍来自 Session Message/Snapshot。 */
export interface TuiTimelineEntry {
  readonly id: string;
  readonly kind: "message" | "tool";
  readonly role?: "user" | "assistant" | "summary";
  readonly label: string;
  readonly content: string;
  readonly tool?: ToolActivityView;
}

export interface TuiCollapsedToolSummary {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly state: ToolActivityView["state"];
  readonly summary: string;
  readonly entry: TuiTimelineEntry;
}

export interface TuiTurnAgentContent {
  readonly text: string;
  readonly toolSummaries: readonly TuiCollapsedToolSummary[];
  readonly toolEntries: readonly TuiTimelineEntry[];
}

export interface TuiConversationTurn {
  readonly id: string;
  readonly user?: TuiTimelineEntry;
  readonly agent: TuiTurnAgentContent;
}

export interface TuiRenderedLine {
  readonly entryId: string;
  readonly kind: TuiTimelineEntry["kind"];
  readonly role?: TuiTimelineEntry["role"];
  readonly spacer?: boolean;
  readonly text: string;
  readonly lineIndex: number;
}

export interface TuiTerminalLayout {
  readonly width: number;
  readonly lines: readonly TuiRenderedLine[];
}

/**
 * 按 Agent Session 的持久化消息顺序构造时间线。
 * Workbench 只补充仍在流式传输的 Assistant 和尚未落盘的实时 Tool。
 */
export function buildTuiTimeline(
  session: AgentSessionSnapshot,
  snapshot: WorkbenchSnapshot,
): readonly TuiTimelineEntry[] {
  const liveMessages = new Map<string, WorkbenchSnapshot["chatMessages"][number]>();
  for (const message of snapshot.chatMessages) liveMessages.set(message.id, message);
  const liveTools = new Map<string, ToolActivityView>();
  for (const tool of snapshot.tools) liveTools.set(tool.toolCallId, tool);
  const seen = new Set<string>();
  const entries: TuiTimelineEntry[] = [];

  for (const message of session.messages) {
    if (message.role === "user" || message.role === "assistant" || message.role === "summary") {
      entries.push(messageEntry(message, liveMessages.get(message.id)));
      seen.add(message.id);
      if (message.role === "assistant") {
        for (const call of message.toolCalls) {
          const tool = liveTools.get(call.id);
          entries.push(toolEntry(call.id, tool, toolMessageFor(session.messages, call.id)));
          seen.add(call.id);
        }
      }
      continue;
    }
    if (message.role === "tool") {
      if (seen.has(message.toolCallId)) continue;
      entries.push(toolEntry(message.toolCallId, liveTools.get(message.toolCallId), message));
      seen.add(message.toolCallId);
    }
  }

  // Only the active run may contribute a message that has not reached
  // SessionStore yet. Completed/unrelated Workbench messages are stale
  // projections and must never be appended to the current answer.
  for (const message of snapshot.chatMessages) {
    if (seen.has(message.id)) continue;
    if (
      message.role !== "assistant"
      || message.state !== "streaming"
      || snapshot.activeRunId === undefined
      || message.runId !== snapshot.activeRunId
    ) continue;
    entries.push({
      id: message.id,
      kind: "message",
      role: message.role,
      label: "Agent",
      content: message.content || "…",
    });
    seen.add(message.id);
  }

  // A tool can be requested before the active assistant message is persisted.
  // Keep only those live tools while a run is active; historical leftovers
  // would otherwise be merged into the next Conversation Turn.
  const hasActiveStreamingAssistant = snapshot.chatMessages.some(
    message => message.role === "assistant"
      && message.state === "streaming"
      && snapshot.activeRunId !== undefined
      && message.runId === snapshot.activeRunId,
  );
  if (!hasActiveStreamingAssistant) return entries;
  for (const tool of snapshot.tools) {
    if (seen.has(tool.toolCallId)) continue;
    entries.push(toolEntry(tool.toolCallId, tool));
    seen.add(tool.toolCallId);
  }
  return entries;
}

/** 将原始消息流折叠成“用户问题 → Agent 完整回答”的 Turn。 */
export function buildTuiConversationTurns(
  session: AgentSessionSnapshot,
  snapshot: WorkbenchSnapshot,
): readonly TuiConversationTurn[] {
  const entries = buildTuiTimeline(session, snapshot);
  const turns: TuiConversationTurn[] = [];
  let current: { id: string; user?: TuiTimelineEntry; assistants: string[]; tools: TuiTimelineEntry[] } | undefined;
  const flush = (): void => {
    if (current === undefined) return;
    const toolSummaries = current.tools.map(entry => {
      const tool = entry.tool;
      return {
        toolCallId: entry.id.replace(/^tool:/, ""),
        toolName: tool?.toolName ?? entry.label,
        state: tool?.state ?? "requested",
        summary: compactToolSummary(entry),
        entry,
      } satisfies TuiCollapsedToolSummary;
    });
    const text = [
      ...current.assistants.filter(item => item.trim() !== ""),
      ...(toolSummaries.length === 0 ? [] : [`工具：${toolSummaries.map(item => `${item.toolName}（${item.state}）`).join("、")}`]),
    ].join("\n\n") || (toolSummaries.length > 0 ? "Agent 正在处理工具结果…" : "…");
    turns.push({
      id: current.id,
      ...(current.user === undefined ? {} : { user: current.user }),
      agent: { text, toolSummaries, toolEntries: current.tools },
    });
    current = undefined;
  };
  for (const entry of entries) {
    if (entry.kind === "message" && entry.role === "user") {
      flush();
      current = { id: entry.id, user: entry, assistants: [], tools: [] };
      continue;
    }
    if (current === undefined) current = { id: entry.id, assistants: [], tools: [] };
    if (entry.kind === "tool") current.tools.push(entry);
    else if (entry.role === "assistant" || entry.role === "summary") current.assistants.push(entry.content);
  }
  flush();
  return turns;
}

export function flattenTuiConversationTurns(
  turns: readonly TuiConversationTurn[],
  verbose = false,
): readonly TuiTimelineEntry[] {
  const entries: TuiTimelineEntry[] = [];
  for (const turn of turns) {
    if (turn.user !== undefined) entries.push(turn.user);
    entries.push({
      id: `agent:${turn.id}`,
      kind: "message",
      role: "assistant",
      label: "Agent",
      content: turn.agent.text,
    });
    if (verbose) entries.push(...turn.agent.toolEntries);
  }
  return entries;
}

/** 将时间线按真实终端行布局；每个 Tool 条目固定最多四行。 */
export function layoutTuiLines(entries: readonly TuiTimelineEntry[], width: number, options: { readonly verbose?: boolean } = {}): TuiTerminalLayout {
  const safeWidth = Math.max(8, Math.floor(width));
  const lines: TuiRenderedLine[] = [];
  for (const [entryPosition, entry] of entries.entries()) {
    const raw = entry.kind === "tool"
      ? (options.verbose === true ? [...compactToolLines(entry), ...(entry.content === "" ? [] : ["输入/结果：", entry.content])] : compactToolLines(entry)).map(line => truncateTuiLine(line, safeWidth))
      : [`${entry.label}：${entry.content}`];
    let lineIndex = 0;
    for (const source of raw) {
      const wrapped = entry.kind === "tool"
        ? source
        : wrapAnsi(source, safeWidth, { hard: true, wordWrap: false, trim: false });
      const chunks = wrapped.split("\n");
      for (const chunk of chunks) {
        lines.push({
          entryId: entry.id,
          kind: entry.kind,
          ...(entry.role === undefined ? {} : { role: entry.role }),
          text: chunk,
          lineIndex,
        });
        lineIndex += 1;
      }
    }
    if (entryPosition < entries.length - 1) {
      lines.push({
        entryId: entry.id,
        kind: entry.kind,
        ...(entry.role === undefined ? {} : { role: entry.role }),
        spacer: true,
        text: "",
        lineIndex,
      });
    }
  }
  return { width: safeWidth, lines };
}

function truncateTuiLine(value: string, width: number): string {
  if (stringWidth(value) <= width) return value;
  return `${sliceAnsi(value, 0, Math.max(1, width - 1))}…`;
}

export function layoutTuiTextLines(lines: readonly string[], width: number): readonly string[] {
  const safeWidth = Math.max(8, Math.floor(width));
  return lines.flatMap(line => wrapAnsi(line, safeWidth, { hard: true, wordWrap: false, trim: false }).split("\n"));
}

/** 为输入框提供按显示宽度计算的水平窗口和光标位置。 */
export function getTuiInputWindow(
  text: string,
  cursor: number,
  width: number,
): { readonly text: string; readonly before: string; readonly after: string; readonly cursor: number; readonly offset: number } {
  const safeWidth = Math.max(4, Math.floor(width));
  const safeCursor = Math.min(Math.max(0, cursor), text.length);
  let offset = 0;
  const cursorWidthTotal = stringWidth(text.slice(0, safeCursor));
  while (cursorWidthTotal - offset > safeWidth && offset < cursorWidthTotal) {
    offset += 1;
  }
  const visible = sliceAnsi(text, offset, offset + safeWidth);
  const cursorWidth = Math.max(0, cursorWidthTotal - offset);
  return {
    text: visible,
    before: sliceAnsi(visible, 0, cursorWidth),
    after: sliceAnsi(visible, cursorWidth),
    cursor: cursorWidth,
    offset,
  };
}

function messageEntry(
  message: Extract<AgentMessage, { role: "user" | "assistant" | "summary" }>,
  live: WorkbenchSnapshot["chatMessages"][number] | undefined,
): TuiTimelineEntry {
  return {
    id: message.id,
    kind: "message",
    role: message.role,
    label: message.role === "user" ? "你" : message.role === "summary" ? "会话摘要" : "Agent",
    content: message.role === "user"
      ? stripLegacyAuthorizationNotice(message.displayContent ?? live?.content ?? message.content ?? "…")
      : live?.content || message.content || "…",
  };
}

function stripLegacyAuthorizationNotice(value: string): string {
  return value.replace(/^\[Peru Agent 授权提示[：:][^\]]*\]\s*/u, "");
}

function compactToolSummary(entry: TuiTimelineEntry): string {
  const tool = entry.tool;
  if (tool === undefined) return `${entry.label}：等待结果`;
  const preview = tool.outputPreview?.replace(/\r?\n/g, " ").trim();
  return `${tool.toolName} · ${tool.state}${preview === undefined || preview === "" ? "" : ` · ${preview.slice(0, 160)}`}`;
}

function toolEntry(
  toolCallId: string,
  live: ToolActivityView | undefined,
  persisted?: ToolAgentMessage,
): TuiTimelineEntry {
  const tool = live ?? fallbackTool(toolCallId, persisted);
  return {
    id: `tool:${toolCallId}`,
    kind: "tool",
    label: tool.toolName,
    content: persisted?.content ?? tool.outputPreview ?? "",
    tool,
  };
}

function toolMessageFor(messages: readonly AgentMessage[], toolCallId: string): ToolAgentMessage | undefined {
  const message = messages.find(item => item.role === "tool" && item.toolCallId === toolCallId);
  if (message?.role === "tool") return message;
  return undefined;
}

function fallbackTool(toolCallId: string, persisted?: ToolAgentMessage): ToolActivityView {
  return {
    toolCallId,
    toolName: persisted?.toolName ?? "Tool",
    description: persisted?.toolName ?? "Tool",
    riskLevel: "pure-compute",
    capabilities: [],
    affectedFiles: [],
    networkTargets: [],
    commands: [],
    progressMessages: [],
    ...(persisted === undefined ? {} : {
      outputPreview: persisted.content.slice(0, 8_192),
      outputTruncated: persisted.content.length > 8_192,
      outputIsError: persisted.isError,
    }),
    state: persisted === undefined ? "requested" : persisted.isError ? "failed" : "completed",
  };
}

function compactToolLines(entry: TuiTimelineEntry): readonly string[] {
  const tool = entry.tool;
  if (tool === undefined) return [`[Tool] ${entry.label}`];
  const status = `[Tool] ${tool.toolName} · ${tool.state} · ${tool.riskLevel}`;
  const impact = tool.affectedFiles.length > 0
    ? `影响：${tool.affectedFiles.join(", ")}`
    : tool.networkTargets.length > 0
      ? `网络：${tool.networkTargets.join(", ")}`
      : tool.capabilities.length > 0 ? `能力：${tool.capabilities.join(", ")}` : `说明：${tool.description}`;
  const latest = tool.progressMessages.at(-1) ?? "无额外进度";
  const result = tool.outputPreview === undefined
    ? "结果：等待结果"
    : `结果：${tool.outputPreview.replace(/\r?\n/g, " ")}${tool.outputTruncated === true ? " …" : ""}`;
  return [status, impact, `进度：${latest}`, result];
}
