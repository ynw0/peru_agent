import type { AgentMessage, AgentSessionSnapshot } from "../agent/types.js";
import type { JournalEntry } from "../agent/event-journal.js";

export type TuiTranscriptFilter = "all" | "user" | "assistant" | "tool" | "event";

export interface TuiTranscriptEntry {
  readonly id: string;
  readonly kind: Exclude<TuiTranscriptFilter, "all">;
  readonly recordedAt?: string;
  readonly text: string;
}

export function buildTuiTranscriptEntries(
  session: AgentSessionSnapshot,
  journal: readonly JournalEntry[],
): readonly TuiTranscriptEntry[] {
  const entries: Array<TuiTranscriptEntry & { readonly order: number }> = [];
  const messageOrder = new Map<string, number>();
  const toolOrder = new Map<string, number>();
  for (const entry of journal) {
    const event = entry.event as unknown as Record<string, unknown>;
    if (typeof event.messageId === "string") messageOrder.set(event.messageId, entry.sequence);
    if (typeof event.toolCallId === "string") toolOrder.set(event.toolCallId, entry.sequence);
  }
  let fallbackOrder = journal.length + 1;
  for (const message of session.messages) {
    const item = messageEntry(message);
    const order = message.role === "tool" && message.toolCallId !== undefined
      ? toolOrder.get(message.toolCallId) ?? fallbackOrder++
      : messageOrder.get(message.id) ?? fallbackOrder++;
    entries.push({ ...item, order });
  }
  for (const entry of journal) {
    const event = entry.event;
    if (["assistant.delta", "tool.progress", "model.started", "assistant.started", "assistant.completed"].includes(event.type)) continue;
    entries.push({ id: `event:${entry.sequence}`, kind: "event", recordedAt: entry.recordedAt, text: `[${event.type}] ${JSON.stringify(event)}`, order: entry.sequence + 0.5 });
  }
  return entries.sort((left, right) => left.order - right.order).map(({ order: _order, ...entry }) => entry);
}

export function filterTuiTranscriptEntries(
  entries: readonly TuiTranscriptEntry[],
  filter: TuiTranscriptFilter,
  query = "",
): readonly TuiTranscriptEntry[] {
  const needle = query.trim().toLocaleLowerCase();
  return entries.filter(entry => (filter === "all" || entry.kind === filter) && (needle === "" || entry.text.toLocaleLowerCase().includes(needle)));
}

export function nextTuiTranscriptMatch(
  entries: readonly TuiTranscriptEntry[],
  query: string,
  from: number,
  direction: 1 | -1,
): number {
  const filtered = filterTuiTranscriptEntries(entries, "all", query);
  if (filtered.length === 0) return -1;
  const current = Math.min(Math.max(from, -1), entries.length);
  for (let offset = 1; offset <= entries.length; offset += 1) {
    const index = (current + offset * direction + entries.length) % entries.length;
    if (filtered.some(entry => entry.id === entries[index]?.id)) return index;
  }
  return -1;
}

function messageEntry(message: AgentMessage): TuiTranscriptEntry {
  if (message.role === "user") return { id: message.id, kind: "user", text: stripLegacyAuthorizationNotice(message.displayContent ?? message.content) };
  if (message.role === "assistant") return { id: message.id, kind: "assistant", text: message.content };
  if (message.role === "tool") return { id: message.id, kind: "tool", text: `[${message.toolName}] ${message.content}` };
  return { id: message.id, kind: "event", text: `[会话摘要] ${message.content}` };
}

function stripLegacyAuthorizationNotice(value: string): string {
  return value.replace(/^\[Peru Agent 授权提示[：:][^\]]*\]\s*/u, "");
}
