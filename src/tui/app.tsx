import { useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { dirname } from "node:path";
import { lstat } from "node:fs/promises";
import sliceAnsi from "slice-ansi";
import { Box, Text, useApp, useInput, useStdin, useWindowSize } from "ink";
import type { AgentSessionSnapshot, AgentQueuedInput } from "../agent/types.js";
import type { TrashedSessionRecord } from "../storage/session-store.js";
import type { CheckpointRecord } from "../checkpoint/checkpoint-manager.js";
import type { DiffProposal } from "../diff/diff-manager.js";
import type { WorkbenchSnapshot } from "../workbench/workbench-state.js";
import {
  configurationFromTuiSetupDraft,
  configurationToTuiSetupDraft,
  type TuiHealthReport,
  type TuiSetupDraft,
} from "./config.js";
import { parseTuiCommand, TUI_HELP, TUI_COMMANDS, type TuiCommand } from "./commands.js";
import { acceptTuiSuggestion, getTuiSuggestions, type TuiSuggestion } from "./suggestions.js";
import { TuiController, type TuiControllerState } from "./controller.js";
import { createTuiInputBuffer, reduceTuiInput, type TuiInputBufferState } from "./input-buffer.js";
import { TuiConfigurationEditor } from "./setup.js";
import {
  clampTuiSelection,
  createTuiViewport,
  getTuiReviewDecision,
  getTuiViewportRange,
  markTuiViewportRead,
  moveTuiSelection,
  reduceTuiViewport,
  type TuiViewportState,
} from "./view-state.js";
import type { TuiToolResultDetail } from "./runtime.js";
import type { PlanRecord } from "../plan/plan-manager.js";
import type { SubagentTaskRecord } from "../subagent/types.js";
import type { SubagentCommit } from "../subagent/types.js";
import { buildTuiConversationTurns, flattenTuiConversationTurns, getTuiInputWindow, layoutTuiLines, layoutTuiTextLines, type TuiRenderedLine } from "./terminal-layout.js";
import { formatCollapsedInput } from "./user-input.js";
import { isTuiMouseInputFragment, parseTuiMouseInput, type TuiMouseEvent } from "./mouse.js";
import { TuiInputRouter } from "./input-router.js";
import { TuiHitRegionRegistry } from "./hit-regions.js";
import { TuiPlanEditor, TuiTaskEditor } from "./orchestration-editor.js";
import { calculateTuiScreenLayout } from "./screen-layout.js";
import { Osc52ClipboardWriter } from "./clipboard.js";
import { anchorAtMouse, selectedText, selectionForMouse, selectionIsCollapsed, selectionColumnsForLine, type TuiTextSelection } from "./selection.js";
import { filterTuiTranscriptEntries, nextTuiTranscriptMatch, type TuiTranscriptEntry, type TuiTranscriptFilter } from "./transcript.js";

interface TuiAppProps {
  readonly controller: TuiController;
  readonly onExit: () => Promise<void>;
}

type PanelKind = "help" | "permissions" | "sessions" | "diffs" | "checkpoints" | "tools" | "model" | "doctor" | "context" | "usage" | "queue" | "plans" | "tasks" | "subagents" | "trash" | "transcript" | "artifacts";
type Overlay =
  | { readonly kind: "permission"; readonly requestId: string; readonly full: boolean }
  | { readonly kind: "diff"; readonly proposalId: string; readonly full: boolean }
  | { readonly kind: "restore"; readonly checkpointId: string }
  | { readonly kind: "tool"; readonly toolCallId: string }
  | { readonly kind: "config"; readonly draft: TuiSetupDraft }
  | { readonly kind: "queueChoice"; readonly input: string; readonly prepared?: import("../agent/types.js").AgentUserInput }
  | { readonly kind: "externalAccess"; readonly input: string; readonly paths: readonly string[] }
  | { readonly kind: "shell"; readonly command: string }
  | { readonly kind: "planReview"; readonly planId: string }
  | { readonly kind: "planEditor"; readonly instruction?: string }
  | { readonly kind: "taskEditor"; readonly instruction?: string }
  | { readonly kind: "artifactConfirm"; readonly commitId: string }
  | { readonly kind: "taskStartConfirm"; readonly taskId: string }
  | { readonly kind: "panel"; readonly panel: PanelKind; readonly selected: number };

interface NavigationKey {
  readonly up?: boolean;
  readonly down?: boolean;
  readonly upArrow?: boolean;
  readonly downArrow?: boolean;
  readonly leftArrow?: boolean;
  readonly rightArrow?: boolean;
  readonly return?: boolean;
  readonly escape?: boolean;
  readonly tab?: boolean;
  readonly pageUp?: boolean;
  readonly pageDown?: boolean;
  readonly ctrl?: boolean;
  readonly shift?: boolean;
  readonly home?: boolean;
  readonly end?: boolean;
}

export function TuiApp({ controller, onExit }: TuiAppProps): ReactElement {
  const { exit } = useApp();
  const { stdin } = useStdin();
  const { columns, rows } = useWindowSize();
  const [state, setState] = useState<TuiControllerState>(controller.getState());
  const [input, setInput] = useState<TuiInputBufferState>(createTuiInputBuffer());
  const [overlay, setOverlay] = useState<Overlay | undefined>();
  const [clearedItems, setClearedItems] = useState(0);
  const [clearedToolItems, setClearedToolItems] = useState(0);
  const [sessions, setSessions] = useState<readonly AgentSessionSnapshot[]>([]);
  const [trashSessions, setTrashSessions] = useState<readonly TrashedSessionRecord[]>([]);
  const [diffs, setDiffs] = useState<readonly DiffProposal[]>([]);
  const [checkpoints, setCheckpoints] = useState<readonly CheckpointRecord[]>([]);
  const [toolDetail, setToolDetail] = useState<TuiToolResultDetail | undefined>();
  const [queuedInputs, setQueuedInputs] = useState<readonly AgentQueuedInput[]>([]);
  const [plans, setPlans] = useState<readonly PlanRecord[]>([]);
  const [tasks, setTasks] = useState<readonly SubagentTaskRecord[]>([]);
  const [artifacts, setArtifacts] = useState<readonly SubagentCommit[]>([]);
  const [transcriptEntries, setTranscriptEntries] = useState<readonly TuiTranscriptEntry[]>([]);
  const [transcriptQuery, setTranscriptQuery] = useState("");
  const [transcriptFilter, setTranscriptFilter] = useState<TuiTranscriptFilter>("all");
  const [transcriptSearchMode, setTranscriptSearchMode] = useState(false);
  const [suggestions, setSuggestions] = useState<readonly TuiSuggestion[]>([]);
  const [suggestionIndex, setSuggestionIndex] = useState(0);
  const [verboseTranscript, setVerboseTranscript] = useState(false);
  const [home, setHome] = useState(true);
  const [timelineViewport, setTimelineViewport] = useState<TuiViewportState>(() => createTuiViewport());
  const [detailViewport, setDetailViewport] = useState<TuiViewportState>(() => createTuiViewport());
  const [timelineSelection, setTimelineSelection] = useState<TuiTextSelection | undefined>();
  const [overlayActionIndex, setOverlayActionIndex] = useState(0);
  const timelineSelectionRef = useRef<TuiTextSelection | undefined>(undefined);
  const selectingTimelineRef = useRef(false);
  const mouseHandlerRef = useRef<(event: TuiMouseEvent) => void>(() => undefined);
  const terminalInputRouterRef = useRef<TuiInputRouter | undefined>(undefined);
  const hitRegionRegistryRef = useRef(new TuiHitRegionRegistry());
  const clipboard = useMemo(() => new Osc52ClipboardWriter(), []);
  const previousColumns = useRef(columns);
  const lastEscapeAt = useRef(0);

  useEffect(() => {
    const subscription = controller.onState(next => setState(next));
    void controller.doctor().catch(() => undefined);
    void controller.listSessions().then(items => setSessions(items.slice(0, 8))).catch(() => undefined);
    void controller.loadInputHistory().then(history => setInput(current => ({ ...current, history: [...history] }))).catch(() => undefined);
    void controller.listQueuedInputs().then(setQueuedInputs).catch(() => undefined);
    return () => subscription.dispose();
  }, [controller]);

  useEffect(() => {
    const current = input.text;
    if (transcriptSearchMode) { setSuggestions([]); return; }
    if (current.trimStart().startsWith("/")) { setSuggestions(getTuiSuggestions(current, TUI_COMMANDS, [])); setSuggestionIndex(0); return; }
    if (/(?:^|\s)@[^\s]*$/.test(current)) { void controller.getRuntime().suggestFiles(current.match(/@([^\s]*)$/)?.[1] ?? "").then(files => { setSuggestions(getTuiSuggestions(current, TUI_COMMANDS, files)); setSuggestionIndex(0); }).catch(() => setSuggestions([])); return; }
    setSuggestions([]);
  }, [input.text, controller, transcriptSearchMode]);

  const conversationTurns = useMemo(
    () => buildTuiConversationTurns(state.activeSession, state.snapshot),
    [state.activeSession, state.snapshot],
  );
  const timelineEntries = useMemo(
    () => flattenTuiConversationTurns(conversationTurns, verboseTranscript),
    [conversationTurns, verboseTranscript],
  );
  const visibleEntries = useMemo(
    () => timelineEntries.slice(Math.max(clearedItems, clearedToolItems)),
    [timelineEntries, clearedItems, clearedToolItems],
  );
  const timelineLines = useMemo(
    () => layoutTuiLines(visibleEntries, Math.max(24, columns - 6), { verbose: verboseTranscript }).lines,
    [visibleEntries, columns, verboseTranscript],
  );
  const filteredTranscriptEntries = useMemo(
    () => filterTuiTranscriptEntries(transcriptEntries, transcriptFilter, transcriptQuery),
    [transcriptEntries, transcriptFilter, transcriptQuery],
  );
  const transcriptLines = useMemo(
    () => layoutTuiTextLines(filteredTranscriptEntries.map(entry => `[${entry.kind}] ${entry.text}`), Math.max(24, columns - 8)),
    [filteredTranscriptEntries, columns],
  );
  const screenLayout = calculateTuiScreenLayout({
    rows,
    columns,
    headerRows: calculateHeaderRows(state, columns),
    suggestionRows: suggestions.length > 0 ? Math.min(9, suggestions.length + 1) : 0,
  });
  useEffect(() => {
    hitRegionRegistryRef.current.set(overlay === undefined && !home
      ? [{
          id: "timeline",
          left: 0,
          top: screenLayout.timelineContentTopRow,
          right: Math.max(0, columns - 1),
          bottom: screenLayout.timelineContentBottomRow,
        }]
      : overlay === undefined
        ? []
        : [{ id: "overlay", left: 0, top: 0, right: Math.max(0, columns - 1), bottom: Math.max(0, rows - 1) }]);
  }, [overlay, home, columns, rows, screenLayout.timelineContentTopRow, screenLayout.timelineContentBottomRow]);
  const timelinePageSize = screenLayout.timelinePageSize;
  const detailSourceLines = overlay === undefined || overlay.kind === "panel" || overlay.kind === "config" || overlay.kind === "planEditor" || overlay.kind === "taskEditor" || overlay.kind === "artifactConfirm" || overlay.kind === "taskStartConfirm" || overlay.kind === "restore" || overlay.kind === "queueChoice" || overlay.kind === "externalAccess" || overlay.kind === "shell" || overlay.kind === "planReview"
    ? []
    : buildDetailLines(overlay, controller, state.snapshot, state.runtime.workspaceRoot, toolDetail);
  const detailLines = useMemo(
    () => layoutTuiTextLines(detailSourceLines, Math.max(24, columns - 8)),
    [detailSourceLines, columns],
  );
  const persistentIssue = state.lastRunError
    ?? (state.snapshot.aborted ? { code: "aborted", message: "本次 Agent 运行已取消" } : undefined);
  const effectiveTimelineViewport = reduceTuiViewport(timelineViewport, {}, timelineLines.length, timelinePageSize);
  const detailViewportLength = overlay?.kind === "panel" && overlay.panel === "transcript" ? transcriptLines.length : detailLines.length;
  const effectiveDetailViewport = reduceTuiViewport(detailViewport, {}, detailViewportLength, Math.max(5, rows - 8));
  const timelineRange = getTuiViewportRange(effectiveTimelineViewport);
  const visibleTimelineLines = timelineLines.slice(timelineRange.start, timelineRange.end);

  timelineSelectionRef.current = timelineSelection;
  mouseHandlerRef.current = mouse => {
    if (overlay !== undefined && mouse.kind === "press" && mouse.button === "left") {
      const actions = overlayActions(overlay);
      if (actions.length > 0) {
        const bodyLineCount = overlayActionBodyLineCount(
          overlay,
          detailLines,
          effectiveDetailViewport,
          state.snapshot,
        );
        const selected = actionModalIndexAtMouse(mouse.x, mouse.y, bodyLineCount, actions.length, columns, rows);
        if (selected !== undefined) {
          setOverlayActionIndex(selected);
          void activateOverlayAction(selected);
        }
        return;
      }
    }
    if (overlay === undefined && mouse.kind === "press" && mouse.button === "left" && suggestions.length > 0) {
      const suggestion = suggestions[mouse.y - screenLayout.suggestionTopRow - 1];
      if (suggestion !== undefined) {
        const accepted = acceptTuiSuggestion(input.text, suggestion);
        setInput(current => ({ ...current, text: accepted, cursor: accepted.length }));
        setSuggestions([]);
      }
      return;
    }
    if (overlay?.kind === "panel" && overlay.panel === "transcript") {
      if (mouse.kind === "wheel") {
        setDetailViewport(current => reduceTuiViewport(current, { wheel: mouse.direction, wheelAmount: mouse.amount }, transcriptLines.length, Math.max(5, rows - 8)));
        return;
      }
      if (mouse.kind === "press" && mouse.button === "right") {
        const entry = filteredTranscriptEntries[overlay.selected];
        if (entry === undefined) controller.setStatus("没有可复制的 Transcript 内容");
        else void clipboard.copy(entry.text).then(() => controller.setStatus(`已复制 ${entry.text.length} 个字符`), error => controller.setStatus(errorMessage(error)));
        return;
      }
      return;
    }
    if (overlay?.kind === "panel" && mouse.kind === "press" && mouse.button === "left") {
      const lines = panelLines(overlay.panel, state.snapshot, sessions, diffs, checkpoints, queuedInputs, plans, tasks, artifacts, trashSessions);
      const selected = selectablePanelIndexAtMouse(mouse.x, mouse.y, overlay.selected, lines.length, columns, rows);
      if (selected !== undefined) {
        setOverlay({ ...overlay, selected });
        if (isDirectClickPanel(overlay.panel)) void activateSelected(overlay.panel, selected);
      }
      return;
    }
    if (overlay === undefined && !home) {
      const hit = hitRegionRegistryRef.current.hit(mouse.x, mouse.y);
      if (hit?.id !== "timeline") return;
      if (mouse.kind === "wheel") {
        setTimelineViewport(current => reduceTuiViewport(current, { wheel: mouse.direction, wheelAmount: mouse.amount }, timelineLines.length, timelinePageSize));
        return;
      }
      const nextSelection = selectionForMouse(
        timelineSelectionRef.current,
        mouse,
        visibleTimelineLines,
        screenLayout.timelineContentTopRow,
        screenLayout.timelineContentLeftColumn,
      );
      if (mouse.kind === "press" && mouse.button === "left") {
        timelineSelectionRef.current = nextSelection;
        selectingTimelineRef.current = true;
        setTimelineSelection(nextSelection);
        return;
      }
      if (mouse.kind === "move" && selectingTimelineRef.current) {
        timelineSelectionRef.current = nextSelection;
        setTimelineSelection(nextSelection);
        return;
      }
      if (mouse.kind === "release" && mouse.button === "left") {
        timelineSelectionRef.current = nextSelection;
        selectingTimelineRef.current = false;
        setTimelineSelection(nextSelection);
        return;
      }
      if (mouse.kind === "press" && mouse.button === "right") {
        const clicked = anchorAtMouse(mouse, visibleTimelineLines, screenLayout.timelineContentTopRow, screenLayout.timelineContentLeftColumn);
        const clickedLine = clicked === undefined
          ? undefined
          : timelineLines.find(line => line.entryId === clicked.entryId && line.lineIndex === clicked.lineIndex);
        const copied = selectedText(timelineLines, timelineSelectionRef.current, clickedLine);
        if (copied.trim() === "") controller.setStatus("没有可复制的对话内容");
        else void clipboard.copy(copied).then(
          () => controller.setStatus(`已复制 ${copied.length} 个字符`),
          error => controller.setStatus(errorMessage(error)),
        );
      }
      return;
    }
    if (overlay !== undefined && mouse.kind === "wheel" && isScrollableOverlay(overlay)) {
      const sourceLength = overlay.kind === "panel" && overlay.panel === "transcript" ? transcriptLines.length : detailLines.length;
      setDetailViewport(current => reduceTuiViewport(current, { wheel: mouse.direction, wheelAmount: mouse.amount }, sourceLength, Math.max(5, rows - 8)));
    }
  };

  useEffect(() => {
    const router = new TuiInputRouter(event => {
      if (event.kind === "mouse") mouseHandlerRef.current(event.event);
    });
    terminalInputRouterRef.current = router;
    const handleRawInput = (chunk: Buffer | string): void => {
      router.feed(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
    };
    stdin.on("data", handleRawInput);
    return () => {
      stdin.removeListener("data", handleRawInput);
      router.reset();
      if (terminalInputRouterRef.current === router) terminalInputRouterRef.current = undefined;
    };
  }, [stdin]);

  useEffect(() => {
    const resized = previousColumns.current !== columns;
    previousColumns.current = columns;
    setTimelineViewport(current => {
      const next = reduceTuiViewport(current, {}, timelineLines.length, timelinePageSize);
      return resized ? { ...next, unread: current.unread } : next;
    });
  }, [timelineLines.length, timelinePageSize, columns]);

  useEffect(() => {
    const sourceLength = overlay?.kind === "panel" && overlay.panel === "transcript" ? transcriptLines.length : detailLines.length;
    setDetailViewport(current => reduceTuiViewport(current, {}, sourceLength, Math.max(5, rows - 8)));
  }, [detailLines.length, transcriptLines.length, rows, columns, overlayIdentity(overlay)]);

  useEffect(() => {
    setOverlayActionIndex(0);
  }, [overlayIdentity(overlay)]);

  useEffect(() => {
    if (timelineViewport.offset === 0) {
      controller.markOutputFollowing(true);
      setTimelineViewport(current => markTuiViewportRead(current));
    } else {
      controller.markOutputFollowing(false);
    }
  }, [controller, timelineViewport.offset]);

  useEffect(() => {
    if (home) return;
    const pendingPermission = state.snapshot.pendingPermissions[0];
    if (overlay?.kind === "config" || overlay?.kind === "planEditor" || overlay?.kind === "taskEditor" || overlay?.kind === "artifactConfirm" || overlay?.kind === "taskStartConfirm") return;
    if (pendingPermission !== undefined && (overlay === undefined || overlay.kind === "panel")) {
      setOverlay({ kind: "permission", requestId: pendingPermission.requestId, full: false });
      return;
    }
    const pendingDiff = state.snapshot.diffProposals.find(item => item.status === "proposed");
    if (pendingDiff !== undefined && (overlay === undefined || overlay.kind === "panel")) {
      setOverlay({ kind: "diff", proposalId: pendingDiff.proposalId, full: false });
      return;
    }
    const pendingPlan = state.snapshot.plans.find(item => item.status === "reviewing");
    if (pendingPlan !== undefined && (overlay === undefined || overlay.kind === "panel")) {
      setOverlay({ kind: "planReview", planId: pendingPlan.planId });
    }
  }, [state.snapshot, overlay, home]);

  useEffect(() => {
    if (overlay?.kind === "permission"
      && !state.snapshot.pendingPermissions.some(item => item.requestId === overlay.requestId)) {
      setOverlay(undefined);
    }
    if (overlay?.kind === "diff") {
      const proposal = state.snapshot.diffProposals.find(item => item.proposalId === overlay.proposalId);
      if (proposal === undefined || proposal.status !== "proposed") setOverlay(undefined);
    }
  }, [state.snapshot, overlay]);

  useEffect(() => {
    if (overlay?.kind !== "panel") return;
    void refreshPanel(overlay.panel);
    if (overlay.panel === "queue") void controller.listQueuedInputs().then(setQueuedInputs).catch(() => undefined);
  }, [overlay?.kind === "panel" ? overlay.panel : undefined, state.runtime, state.activeSession.updatedAt]);

  useEffect(() => {
    if (overlay?.kind !== "panel") return;
    const corrected = clampTuiSelection(overlay.selected, panelCount(overlay.panel));
    if (corrected !== overlay.selected) setOverlay({ ...overlay, selected: corrected });
  }, [overlay, sessions, diffs, checkpoints, queuedInputs, plans, tasks, artifacts, transcriptEntries, transcriptFilter, transcriptQuery, state.snapshot.pendingPermissions, state.snapshot.tools]);

  useEffect(() => {
    if (overlay?.kind !== "tool") return;
    setToolDetail(undefined);
    void controller.getToolResult(overlay.toolCallId).then(setToolDetail).catch(() => setToolDetail(undefined));
  }, [overlay?.kind === "tool" ? overlay.toolCallId : undefined, controller]);

  useInput((value, key) => {
    if (state.switching) return;
    const mouse = parseTuiMouseInput(value);
    if (mouse !== undefined || isTuiMouseInputFragment(value)) return;
    if (overlay?.kind === "config" || overlay?.kind === "planEditor" || overlay?.kind === "taskEditor") return;
    if (overlay?.kind === "panel" && overlay.panel === "transcript" && transcriptSearchMode) {
      if (key.escape || (key.ctrl && value.toLocaleLowerCase() === "c")) {
        setTranscriptSearchMode(false);
        setInput(createTuiInputBuffer());
        controller.setStatus("已取消 Transcript 搜索");
        return;
      }
      if (key.return) {
        setTranscriptQuery(input.text);
        setTranscriptSearchMode(false);
        setInput(createTuiInputBuffer());
        setDetailViewport(createTuiViewport());
        controller.setStatus(input.text.trim() === "" ? "Transcript 搜索已清除" : `Transcript 搜索：${input.text}`);
        return;
      }
      const transition = reduceTuiInput(input, value, key);
      setInput(transition.state);
      return;
    }
    const actions = overlay === undefined ? [] : overlayActions(overlay);
    if (actions.length > 0) {
      if (key.leftArrow || key.upArrow) {
        setOverlayActionIndex(current => (current - 1 + actions.length) % actions.length);
        return;
      }
      if (key.rightArrow || key.downArrow) {
        setOverlayActionIndex(current => (current + 1) % actions.length);
        return;
      }
      if (key.return) {
        void activateOverlayAction(overlayActionIndex);
        return;
      }
    }
    if (overlay?.kind === "artifactConfirm") { void handleArtifactConfirmKey(value, key); return; }
    if (overlay?.kind === "taskStartConfirm") { void handleTaskStartConfirmKey(value, key); return; }
    if (key.ctrl && value.toLocaleLowerCase() === "c") {
      if (controller.abortActiveRun()) controller.setStatus("已请求取消当前 Agent 运行");
      else controller.setStatus("当前没有运行中的 Agent");
      return;
    }
    if (key.ctrl && value.toLocaleLowerCase() === "r") { controller.setStatus("历史搜索：使用 Ctrl+R 查找下一项，Enter 发送，Esc 取消"); return; }
    if (key.ctrl && value.toLocaleLowerCase() === "o") { setVerboseTranscript(current => !current); controller.setStatus(verboseTranscript ? "已关闭 Verbose Transcript" : "已开启 Verbose Transcript"); return; }
    if (overlay === undefined && !home && value.toLocaleLowerCase() === "c" && !key.ctrl) {
      const copied = selectedText(timelineLines, timelineSelectionRef.current);
      if (copied.trim() === "") controller.setStatus("请先左键拖选对话内容");
      else void clipboard.copy(copied).then(
        () => controller.setStatus(`已复制 ${copied.length} 个字符`),
        error => controller.setStatus(errorMessage(error)),
      );
      return;
    }
    if (overlay?.kind === "permission") { void handlePermissionKey(value, key); return; }
    if (overlay?.kind === "diff") { void handleDiffKey(value, key); return; }
    if (overlay?.kind === "restore") { void handleRestoreKey(value, key); return; }
    if (overlay?.kind === "queueChoice") { void handleQueueChoice(value, key); return; }
    if (overlay?.kind === "planReview") { void handlePlanReviewKey(value, key); return; }
    if (overlay?.kind === "externalAccess") { void handleExternalAccessKey(value, key); return; }
    if (overlay?.kind === "shell") { void handleShellKey(value, key); return; }
    if (overlay?.kind === "tool") { void handleDetailKey(value, key); return; }
    if (overlay?.kind === "panel") { void handlePanelKey(value, key); return; }
    if (suggestions.length > 0) {
      if (key.escape) { setSuggestions([]); return; }
      if (key.upArrow) { setSuggestionIndex(current => (current - 1 + suggestions.length) % suggestions.length); return; }
      if (key.downArrow) { setSuggestionIndex(current => (current + 1) % suggestions.length); return; }
      if (key.tab) { const selected = suggestions[suggestionIndex]; if (selected !== undefined) { setInput(current => ({ ...current, text: acceptTuiSuggestion(current.text, selected), cursor: acceptTuiSuggestion(current.text, selected).length })); setSuggestions([]); } return; }
    }
    if (key.escape && overlay === undefined && timelineSelectionRef.current !== undefined) {
      timelineSelectionRef.current = undefined;
      setTimelineSelection(undefined);
      controller.setStatus("已清除文本选择");
      return;
    }
    if (key.escape && input.text !== "") {
      const now = Date.now();
      if (now - lastEscapeAt.current < 500) { setInput(createTuiInputBuffer()); controller.setStatus("已清空输入"); }
      else controller.setStatus("再次按 Esc 清空输入");
      lastEscapeAt.current = now;
      return;
    }

    if (key.pageUp || key.pageDown || (key.ctrl && (key.home || key.end))) {
      setTimelineViewport(current => reduceTuiViewport(current, key, timelineLines.length, timelinePageSize));
      return;
    }
    if (key.ctrl && value === "l") {
      setClearedItems(timelineEntries.length);
      setClearedToolItems(timelineEntries.length);
      setTimelineViewport(createTuiViewport());
      controller.markOutputRead();
      controller.setStatus("已清理当前屏幕投影，会话未删除");
      return;
    }
    if (key.ctrl && value === "n") { void createNewSession(); return; }
    if (key.ctrl && value === "p") { openPanel("permissions"); return; }
    if (key.ctrl && value === "d") { openPanel("diffs"); return; }
    if (key.tab) { openPanel(nextPanel(undefined)); return; }
    const transition = reduceTuiInput(input, value, key);
    setInput(transition.state);
    if (transition.submitted !== undefined) void submitInput(transition.submitted);
  });

  async function submitInput(value: string): Promise<void> {
    const command = parseTuiCommand(value);
    if (value.startsWith("/") && command === undefined) {
      controller.setStatus("未知或参数无效的命令；输入 /help 查看帮助");
      return;
    }
    if (command !== undefined) { await executeCommand(command); return; }
    const externalPaths = controller.getExternalPathCandidates(value);
    if (externalPaths.length > 0) {
      setOverlay({ kind: "externalAccess", input: value, paths: externalPaths });
      return;
    }
    if (value.startsWith("!") && value.slice(1).trim() !== "") {
      setOverlay({ kind: "shell", command: value.slice(1).trim() });
      return;
    }
    if (state.snapshot.sessionStatus === "running" || state.snapshot.sessionStatus === "awaitingPermission") {
      setOverlay({ kind: "queueChoice", input: value });
      return;
    }
    try { setHome(false); await controller.sendInput(await controller.prepareUserInput(value)); await controller.recordInputHistory(value); } catch (error: unknown) { controller.setStatus(errorMessage(error)); }
  }

  async function activateOverlayAction(index: number): Promise<void> {
    if (overlay === undefined) return;
    const action = overlayActions(overlay)[index];
    if (action === undefined) return;
    const key: NavigationKey = {};
    if (overlay.kind === "permission") { await handlePermissionKey(action.value, key); return; }
    if (overlay.kind === "diff") { await handleDiffKey(action.value, key); return; }
    if (overlay.kind === "restore") { await handleRestoreKey(action.value, key); return; }
    if (overlay.kind === "queueChoice") { await handleQueueChoice(action.value, key); return; }
    if (overlay.kind === "planReview") { await handlePlanReviewKey(action.value, key); return; }
    if (overlay.kind === "externalAccess") { await handleExternalAccessKey(action.value, key); return; }
    if (overlay.kind === "shell") { await handleShellKey(action.value, key); return; }
    if (overlay.kind === "artifactConfirm") { await handleArtifactConfirmKey(action.value, key); return; }
    if (overlay.kind === "taskStartConfirm") await handleTaskStartConfirmKey(action.value, key);
  }

  async function handleExternalAccessKey(value: string, key: NavigationKey): Promise<void> {
    if (overlay?.kind !== "externalAccess") return;
    if (key.escape || value.toLocaleLowerCase() === "d" || value.toLocaleLowerCase() === "r") {
      setOverlay(undefined); controller.setStatus("已拒绝外部目录访问"); return;
    }
    if (value.toLocaleLowerCase() !== "a") return;
    try {
      if (state.snapshot.sessionStatus === "running" || state.snapshot.sessionStatus === "awaitingPermission") {
        const directories: string[] = [];
        for (const path of overlay.paths) {
          const status = await lstat(path).catch(() => undefined);
          directories.push(status?.isDirectory() === true ? path : dirname(path));
        }
        for (const directory of new Set(directories)) await controller.authorizeExternalDirectory(directory);
        const prepared = await controller.prepareAuthorizedExternalInput(overlay.input, overlay.paths);
        setOverlay(undefined);
        setOverlay({ kind: "queueChoice", input: overlay.input, prepared });
      } else {
        // Authorization and Agent start are committed against one captured
        // Session inside the Runtime, so a snapshot refresh cannot separate
        // the grant from the Tool execution context.
        await controller.authorizeAndSendExternalInput(overlay.input, overlay.paths);
        setOverlay(undefined);
        await controller.recordInputHistory(overlay.input);
      }
    } catch (error: unknown) { setOverlay(undefined); controller.setStatus(errorMessage(error)); }
  }

  async function handleShellKey(value: string, key: NavigationKey): Promise<void> {
    if (overlay?.kind !== "shell") return;
    if (key.escape || value.toLocaleLowerCase() === "d" || value.toLocaleLowerCase() === "r") { setOverlay(undefined); controller.setStatus("已取消 Shell 命令"); return; }
    if (value.toLocaleLowerCase() !== "a") return;
    const command = overlay.command;
    setOverlay(undefined);
    try { setHome(false); await controller.sendInput(`请通过 PowerShell Tool 执行以下用户明确确认的命令：${command}`); }
    catch (error: unknown) { controller.setStatus(errorMessage(error)); }
  }

  async function handlePlanReviewKey(value: string, key: NavigationKey): Promise<void> {
    if (overlay?.kind !== "planReview") return;
    if (key.escape || value.toLocaleLowerCase() === "d" || value.toLocaleLowerCase() === "r") {
      await controller.resolvePlan(overlay.planId, "rejected").catch(error => controller.setStatus(errorMessage(error)));
      setOverlay(undefined); return;
    }
    if (value.toLocaleLowerCase() === "a") {
      await controller.resolvePlan(overlay.planId, "approved").then(() => controller.setStatus("Plan 已批准"), error => controller.setStatus(errorMessage(error)));
      setOverlay(undefined);
    }
  }

  async function handleArtifactConfirmKey(value: string, key: NavigationKey): Promise<void> {
    if (overlay?.kind !== "artifactConfirm") return;
    if (key.escape || value.toLocaleLowerCase() === "n" || value.toLocaleLowerCase() === "d") { setOverlay(undefined); return; }
    if (value.toLocaleLowerCase() !== "y" && value.toLocaleLowerCase() !== "a") return;
    try { await controller.deleteArtifact(overlay.commitId); setArtifacts(await controller.listArtifacts()); setOverlay(undefined); controller.setStatus("Commit 产物已清理"); }
    catch (error: unknown) { controller.setStatus(errorMessage(error)); setOverlay(undefined); }
  }

  async function handleTaskStartConfirmKey(value: string, key: NavigationKey): Promise<void> {
    if (overlay?.kind !== "taskStartConfirm") return;
    if (key.escape || value.toLocaleLowerCase() === "n" || value.toLocaleLowerCase() === "d") { setOverlay(undefined); return; }
    if (value.toLocaleLowerCase() !== "y" && value.toLocaleLowerCase() !== "a") return;
    try { await controller.startTask(overlay.taskId); setTasks(controller.listTasks()); setOverlay(undefined); controller.setStatus("Implementer 已启动"); }
    catch (error: unknown) { controller.setStatus(errorMessage(error)); setOverlay(undefined); }
  }

  async function executeCommand(command: TuiCommand): Promise<void> {
    try {
      switch (command.kind) {
        case "help": openPanel("help"); return;
        case "home": setHome(true); setOverlay(undefined); return;
        case "new": await createNewSession(); return;
        case "sessions": openPanel("sessions"); return;
        case "resume": if (command.sessionId === undefined) { openPanel("sessions"); return; } await controller.activateSession(command.sessionId); setHome(false); setClearedItems(0); setClearedToolItems(0); return;
        case "workspace": await controller.switchWorkspace(command.path); setClearedItems(0); setClearedToolItems(0); setTimelineViewport(createTuiViewport()); return;
        case "model": openPanel("model"); return;
        case "mode": await createNewSession(command.mode); return;
        case "diffs": openPanel("diffs"); return;
        case "checkpoints": openPanel("checkpoints"); return;
        case "restore":
          if (isRunActive(state)) { controller.setStatus("运行期间不能恢复 Checkpoint"); return; }
          setOverlay({ kind: "restore", checkpointId: command.checkpointId });
          return;
        case "retry": await controller.retryActiveSession(); return;
        case "doctor": await controller.doctor(); openPanel("doctor"); return;
        case "config": openConfigurationEditor(); return;
        case "tools": openPanel("tools"); return;
        case "permissions": openPanel("permissions"); return;
        case "subagents": setTasks(controller.listTasks()); openPanel("subagents"); return;
        case "trash": openPanel("trash"); return;
        case "transcript": setTranscriptQuery(""); setTranscriptFilter("all"); setTranscriptSearchMode(false); setOverlay({ kind: "panel", panel: "transcript", selected: 0 }); return;
        case "rename":
          if (command.title === undefined) {
            const renameInput = "/rename ";
            setInput(current => ({ ...current, text: renameInput, cursor: renameInput.length }));
            controller.setStatus("输入新的会话名称后按 Enter");
            return;
          }
          await controller.renameActiveSession(command.title);
          controller.setStatus(`会话已重命名为：${command.title}`);
          return;
        case "export": controller.setStatus(`已导出：${await controller.exportActiveSession(command.path)}`); return;
        case "compact": if (isRunActive(state)) { controller.setStatus("运行期间不能压缩会话"); return; } setOverlay({ kind: "queueChoice", input: `/compact ${command.instructions ?? ""}` }); return;
        case "context": openPanel("context"); return;
        case "usage": openPanel("usage"); return;
        case "queue": openPanel("queue"); return;
        case "plans": setPlans(controller.listPlans()); openPanel("plans"); return;
        case "plan": setOverlay({ kind: "planEditor", ...(command.instruction === undefined ? {} : { instruction: command.instruction }) }); return;
        case "tasks": setTasks(controller.listTasks()); openPanel("tasks"); return;
        case "artifacts": void controller.listArtifacts().then(setArtifacts); openPanel("artifacts"); return;
        case "task": setOverlay({ kind: "taskEditor", ...(command.instruction === undefined ? {} : { instruction: command.instruction }) }); return;
        case "clear": setClearedItems(timelineEntries.length); setClearedToolItems(timelineEntries.length); setTimelineViewport(createTuiViewport()); controller.markOutputRead(); controller.setStatus("已清理当前屏幕投影，会话未删除"); return;
        case "exit": await onExit(); exit(); return;
      }
    } catch (error: unknown) { controller.setStatus(errorMessage(error)); }
  }

  async function handleQueueChoice(value: string, key: NavigationKey): Promise<void> {
    if (key.escape || value.toLocaleLowerCase() === "x") { setOverlay(undefined); return; }
    const inputValue = overlay?.kind === "queueChoice" ? overlay.input : "";
    if (inputValue.startsWith("/compact")) {
      if (value.toLocaleLowerCase() !== "y" && value.toLocaleLowerCase() !== "a") return;
      setOverlay(undefined); try { await controller.compactActiveSession(inputValue.slice("/compact".length).trim()); controller.setStatus("会话已压缩"); } catch (error: unknown) { controller.setStatus(errorMessage(error)); } return;
    }
    const prepared = overlay?.kind === "queueChoice" && overlay.prepared !== undefined
      ? overlay.prepared
      : await controller.prepareUserInput(inputValue);
    if (value.toLocaleLowerCase() === "i") { await controller.queueInput(prepared, "immediate"); setOverlay(undefined); controller.setStatus("已中断当前运行，准备立即发送"); return; }
    if (value.toLocaleLowerCase() === "g") { await controller.queueInput(prepared, "guide"); setOverlay(undefined); controller.setStatus("已引导当前运行"); return; }
    if (value.toLocaleLowerCase() === "l") { await controller.queueInput(prepared, "next"); setOverlay(undefined); controller.setStatus("已排队到下一轮"); return; }
  }

  async function createNewSession(mode = state.configuration.permissionMode): Promise<void> {
    if (state.snapshot.sessionStatus === "running" || state.snapshot.sessionStatus === "awaitingPermission") {
      controller.setStatus("运行期间不能新建会话");
      return;
    }
    await controller.createSession(mode);
    setHome(false);
    setClearedItems(0);
    setClearedToolItems(0);
    setTimelineViewport(createTuiViewport());
  }

  function openConfigurationEditor(): void {
    if (state.snapshot.sessionStatus === "running" || state.snapshot.sessionStatus === "awaitingPermission") {
      controller.setStatus("运行期间不能修改配置，请先按 Ctrl+C");
      return;
    }
    setOverlay({ kind: "config", draft: configurationToTuiSetupDraft(state.configuration) });
  }

  function openPanel(panel: PanelKind): void { setOverlay({ kind: "panel", panel, selected: 0 }); }

  async function refreshPanel(panel: PanelKind): Promise<void> {
    try {
      if (panel === "sessions") setSessions(await controller.listSessions());
      if (panel === "trash") setTrashSessions(await controller.listTrash());
      if (panel === "diffs") setDiffs(controller.listDiffs());
      if (panel === "checkpoints") setCheckpoints(await controller.listCheckpoints());
      if (panel === "plans") setPlans(controller.listPlans());
      if (panel === "tasks") setTasks(controller.listTasks());
      if (panel === "artifacts") setArtifacts(await controller.listArtifacts());
      if (panel === "transcript") setTranscriptEntries(await controller.listTranscriptEntries());
    } catch (error: unknown) { controller.setStatus(errorMessage(error)); }
  }

  async function handlePanelKey(value: string, key: NavigationKey): Promise<void> {
    if (overlay?.kind !== "panel") return;
    if (overlay.panel === "transcript") {
      if (transcriptSearchMode) return;
      if (key.escape) { setOverlay(undefined); return; }
      if (key.ctrl && value.toLocaleLowerCase() === "f") {
        setTranscriptSearchMode(true);
        setInput(createTuiInputBuffer());
        controller.setStatus("Transcript 搜索：输入关键词后按 Enter，Esc 取消");
        return;
      }
      if (key.leftArrow || value.toLocaleLowerCase() === "f") {
        const filters: readonly TuiTranscriptFilter[] = ["all", "user", "assistant", "tool", "event"];
        const index = filters.indexOf(transcriptFilter);
        setTranscriptFilter(filters[(index + 1) % filters.length] ?? "all");
        setDetailViewport(createTuiViewport());
        return;
      }
      if (key.upArrow || key.up) { setOverlay({ ...overlay, selected: moveTuiSelection(overlay.selected, Math.max(1, filteredTranscriptEntries.length), -1) }); return; }
      if (key.downArrow || key.down) { setOverlay({ ...overlay, selected: moveTuiSelection(overlay.selected, Math.max(1, filteredTranscriptEntries.length), 1) }); return; }
      if (key.pageUp || key.pageDown || (key.ctrl && (key.home || key.end))) {
        setDetailViewport(current => reduceTuiViewport(current, key, transcriptLines.length, Math.max(5, rows - 8)));
        return;
      }
      if (key.return && transcriptQuery.trim() !== "") {
        const selectedId = filteredTranscriptEntries[overlay.selected]?.id;
        const currentOriginal = selectedId === undefined ? -1 : transcriptEntries.findIndex(entry => entry.id === selectedId);
        const match = nextTuiTranscriptMatch(transcriptEntries, transcriptQuery, currentOriginal, key.shift === true ? -1 : 1);
        if (match >= 0) setOverlay({ ...overlay, selected: filteredTranscriptEntries.findIndex(entry => entry.id === transcriptEntries[match]?.id) });
        else controller.setStatus("没有找到匹配的 Transcript 内容");
        return;
      }
      if (value.toLocaleLowerCase() === "c") {
        const entry = filteredTranscriptEntries[overlay.selected];
        if (entry === undefined) { controller.setStatus("没有可复制的 Transcript 内容"); return; }
        void clipboard.copy(entry.text).then(() => controller.setStatus(`已复制 ${entry.text.length} 个字符`), error => controller.setStatus(errorMessage(error)));
        return;
      }
      return;
    }
    if (overlay.panel === "help" || overlay.panel === "model" || overlay.panel === "doctor") {
      if (key.pageUp || key.pageDown || (key.ctrl && (key.home || key.end))) {
        setDetailViewport(current => reduceTuiViewport(current, key, layoutTuiTextLines(panelDetailLines(overlay.panel, state), Math.max(24, columns - 8)).length, Math.max(5, rows - 8)));
      } else if (key.escape) {
        setOverlay(undefined);
      }
      return;
    }
    const count = panelCount(overlay.panel);
    if (key.escape) { setOverlay(undefined); return; }
    if (key.tab) { openPanel(nextPanel(overlay.panel)); return; }
    if (key.up || key.upArrow) { setOverlay({ ...overlay, selected: moveTuiSelection(overlay.selected, count, -1) }); return; }
    if (key.down || key.downArrow) { setOverlay({ ...overlay, selected: moveTuiSelection(overlay.selected, count, 1) }); return; }
    if (key.pageUp) { setOverlay({ ...overlay, selected: Math.max(0, overlay.selected - Math.max(1, rows - 10)) }); return; }
    if (key.pageDown) { setOverlay({ ...overlay, selected: Math.min(Math.max(0, count - 1), overlay.selected + Math.max(1, rows - 10)) }); return; }
    if (overlay.panel === "queue" && value.toLocaleLowerCase() === "d") { const item = queuedInputs[overlay.selected]; if (item !== undefined) { await controller.removeQueuedInput(item.id); setQueuedInputs(current => current.filter(entry => entry.id !== item.id)); } return; }
    if (overlay.panel === "sessions" && value.toLocaleLowerCase() === "d") {
      const session = sessions[overlay.selected];
      if (session !== undefined) {
        if (session.id === state.activeSession.id) {
          await controller.trashSession(session.id);
          await createNewSession();
          setHome(true);
        } else {
          await controller.trashSession(session.id);
          setSessions(await controller.listSessions());
        }
      }
      return;
    }
    if (overlay.panel === "trash" && value.toLocaleLowerCase() === "d") {
      const record = trashSessions[overlay.selected];
      if (record !== undefined) { await controller.deleteTrash(record.snapshot.id); setTrashSessions(await controller.listTrash()); }
      return;
    }
    if (overlay.panel === "plans" && (value.toLocaleLowerCase() === "c" || value.toLocaleLowerCase() === "x")) { const plan = plans[overlay.selected]; if (plan !== undefined) { await (value.toLocaleLowerCase() === "c" ? controller.completePlan(plan.id) : controller.cancelPlan(plan.id)); setPlans(controller.listPlans()); } return; }
    if ((overlay.panel === "tasks" || overlay.panel === "subagents") && value.toLocaleLowerCase() === "x") { const task = tasks[overlay.selected]; if (task !== undefined) { await controller.abortTask(task.id); setTasks(controller.listTasks()); } return; }
    if (overlay.panel === "tasks" && value.toLocaleLowerCase() === "r") { const task = tasks[overlay.selected]; if (task !== undefined && (task.status === "failed" || task.status === "aborted" || task.status === "gateInterrupted")) { await controller.retryGateAttempt(task.id); setTasks(controller.listTasks()); } return; }
    if (overlay.panel === "artifacts" && value.toLocaleLowerCase() === "d") { const artifact = artifacts[overlay.selected]; if (artifact !== undefined) setOverlay({ kind: "artifactConfirm", commitId: artifact.id }); return; }
    if (key.return || value.toLocaleLowerCase() === "v") await activateSelected(overlay.panel, clampTuiSelection(overlay.selected, count));
  }

  async function activateSelected(panel: PanelKind, selected: number): Promise<void> {
    if (panel === "sessions") {
      const session = sessions[selected];
      if (session !== undefined) { await controller.activateSession(session.id); setHome(false); setOverlay(undefined); setClearedItems(0); setClearedToolItems(0); }
    } else if (panel === "diffs") {
      const diff = diffs[selected];
      if (diff !== undefined) setOverlay({ kind: "diff", proposalId: diff.id, full: true });
    } else if (panel === "checkpoints") {
      const checkpoint = checkpoints[selected];
      if (checkpoint?.status === "active") {
        if (isRunActive(state)) controller.setStatus("运行期间不能恢复 Checkpoint");
        else setOverlay({ kind: "restore", checkpointId: checkpoint.id });
      }
    } else if (panel === "permissions") {
      const request = state.snapshot.pendingPermissions[selected];
      if (request !== undefined) setOverlay({ kind: "permission", requestId: request.requestId, full: true });
    } else if (panel === "tools") {
      const tool = state.snapshot.tools.slice(-8)[selected];
      if (tool !== undefined) setOverlay({ kind: "tool", toolCallId: tool.toolCallId });
    } else if (panel === "queue") {
      const item = queuedInputs[selected];
      if (item !== undefined) { try { await controller.runQueuedInput(item.id); setQueuedInputs(current => current.filter(entry => entry.id !== item.id)); setOverlay(undefined); } catch (error: unknown) { controller.setStatus(errorMessage(error)); } }
    } else if (panel === "plans") {
      const plan = plans[selected]; if (plan !== undefined && plan.status === "reviewing") setOverlay(undefined), await controller.resolvePlan(plan.id, "approved");
    } else if (panel === "tasks" || panel === "subagents") {
      const task = tasks[selected];
      if (task !== undefined && task.status === "queued") {
        if (task.role === "implementer") setOverlay({ kind: "taskStartConfirm", taskId: task.id });
        else await controller.startTask(task.id);
      }
    } else if (panel === "trash") {
      const record = trashSessions[selected];
      if (record !== undefined) { await controller.restoreTrash(record.snapshot.id); setSessions(await controller.listSessions()); setTrashSessions(await controller.listTrash()); }
    }
  }

  function panelCount(panel: PanelKind): number {
    if (panel === "sessions") return sessions.length;
    if (panel === "trash") return trashSessions.length;
    if (panel === "diffs") return diffs.length;
    if (panel === "checkpoints") return checkpoints.length;
    if (panel === "permissions") return state.snapshot.pendingPermissions.length;
    if (panel === "tools") return state.snapshot.tools.slice(-8).length;
    if (panel === "transcript") return Math.max(1, filteredTranscriptEntries.length);
    if (panel === "queue") return Math.max(1, queuedInputs.length);
    if (panel === "plans") return Math.max(1, plans.length);
    if (panel === "tasks" || panel === "subagents") return Math.max(1, tasks.length);
    if (panel === "artifacts") return Math.max(1, artifacts.length);
    return 1;
  }

  async function handlePermissionKey(value: string, key: NavigationKey): Promise<void> {
    if (overlay?.kind !== "permission") return;
    const request = state.snapshot.pendingPermissions.find(item => item.requestId === overlay.requestId);
    if (request === undefined) return;
    if (key.pageUp || key.pageDown || (key.ctrl && (key.home || key.end))) { setDetailViewport(current => reduceTuiViewport(current, key, detailLines.length, Math.max(5, rows - 8))); return; }
    if (value.toLocaleLowerCase() === "v") { setOverlay({ ...overlay, full: true }); return; }
    const decision = getTuiReviewDecision(value, key);
    if (decision === "accept") controller.resolvePermission(request.requestId, "allow");
    if (decision === "reject") controller.resolvePermission(request.requestId, "deny");
    if (value.toLocaleLowerCase() === "s") controller.grantPermission(request.requestId, "session");
    if (value.toLocaleLowerCase() === "p") controller.grantPermission(request.requestId, "project");
  }

  async function handleDiffKey(value: string, key: NavigationKey): Promise<void> {
    if (overlay?.kind !== "diff") return;
    if (key.pageUp || key.pageDown || (key.ctrl && (key.home || key.end))) { setDetailViewport(current => reduceTuiViewport(current, key, detailLines.length, Math.max(5, rows - 8))); return; }
    if (value.toLocaleLowerCase() === "v") { setOverlay({ ...overlay, full: true }); return; }
    const decision = getTuiReviewDecision(value, key);
    if (decision === "accept") {
      await controller.resolveDiff(overlay.proposalId, "accepted").then(() => controller.setStatus("Diff 已接受并写入工作区"), error => controller.setStatus(errorMessage(error)));
      return;
    }
    if (decision === "reject") await controller.resolveDiff(overlay.proposalId, "rejected").then(() => controller.setStatus("Diff 已拒绝"), error => controller.setStatus(errorMessage(error)));
  }

  async function handleRestoreKey(value: string, key: NavigationKey): Promise<void> {
    if (overlay?.kind !== "restore") return;
    const choice = value.toLocaleLowerCase();
    if (choice === "a" || choice === "b" || choice === "f" || choice === "c") {
      try {
        const scope = choice === "f" ? "filesOnly" : choice === "c" ? "conversationOnly" : "filesAndConversation";
        await controller.restoreCheckpoint(overlay.checkpointId, scope);
        controller.setStatus("Checkpoint 已恢复"); setOverlay(undefined); setHome(false);
      }
      catch (error: unknown) { controller.setStatus(errorMessage(error)); }
      return;
    }
    if (value.toLocaleLowerCase() === "r" || key.escape) setOverlay(undefined);
  }

  async function handleDetailKey(value: string, key: NavigationKey): Promise<void> {
    if (overlay?.kind !== "tool") return;
    if (key.escape || value.toLocaleLowerCase() === "v") { setOverlay(undefined); return; }
    if (key.pageUp || key.pageDown || (key.ctrl && (key.home || key.end))) setDetailViewport(current => reduceTuiViewport(current, key, detailLines.length, Math.max(5, rows - 8)));
  }

  const range = timelineRange;
  const visibleTimeline = visibleTimelineLines;
  const inputDisplayText = formatCollapsedInput(input.text);
  const inputWindow = getTuiInputWindow(inputDisplayText, Math.min(input.cursor, inputDisplayText.length), Math.max(12, columns - 8));
  const contextTokens = state.activeSession.usage.contextTokens ?? state.activeSession.usage.lastInputTokens ?? 0;
  const contextWindowTokens = state.configuration.model.contextWindowTokens;
  const contextPercent = contextWindowTokens <= 0 ? 0 : Math.min(100, Math.round(contextTokens / contextWindowTokens * 100));
  return (
    <Box flexDirection="column" height={screenLayout.rootHeight} paddingX={1}>
      <Header state={state} />
      {home
        ? <HomeScreen state={state} sessions={sessions} onOpenSessions={() => openPanel("sessions")} />
        : <Box flexDirection="column" height={screenLayout.timelineBoxHeight} overflow="hidden" borderStyle="single" borderColor="gray">
            {visibleTimeline.length === 0
              ? <Text dimColor>输入问题开始 Agent 运行。/help 查看帮助。</Text>
              : visibleTimeline.map((line, index) => {
                  const selection = selectionColumnsForLine(line, range.start + index, timelineLines, timelineSelection);
                  return <TimelineLine key={`${line.entryId}-${line.lineIndex}`} line={line} {...(selection === undefined ? {} : { selection })} />;
                })}
            {persistentIssue !== undefined && <Box borderStyle="single" borderColor="red" paddingX={1}><Text color="red">运行问题 [{persistentIssue.code}]：{persistentIssue.message}</Text></Box>}
          </Box>}
      <Box borderStyle="single" borderColor="gray" paddingX={1}><Text color="yellow">&gt; </Text><Text>{inputWindow.before}</Text><Text color="yellow">▌</Text><Text>{inputWindow.after}</Text></Box>
      {suggestions.length > 0 && <Box flexDirection="column" paddingX={2}><Text dimColor>建议（Tab 接受，Esc 关闭）</Text>{suggestions.slice(0, 8).map((item, index) => <Text key={`${item.kind}-${item.value}`} {...(index === suggestionIndex ? { color: "yellow" as const } : {})}>{index === suggestionIndex ? "› " : "  "}{item.value}{item.description === undefined ? "" : ` · ${item.description}`}</Text>)}</Box>}
      <Box justifyContent="space-between">
        <Text dimColor>{state.switching ? "正在切换工作区…" : state.status}{effectiveTimelineViewport.unread > 0 ? ` · ${effectiveTimelineViewport.unread} 行新输出` : ""}</Text>
        <Text dimColor>{state.snapshot.sessionStatus} · 上下文 {contextTokens}/{contextWindowTokens} ({contextPercent}%，80% 自动压缩) · PgUp/PgDn 浏览 · 左键拖选/右键复制 · Ctrl+C 取消</Text>
      </Box>
      {overlay !== undefined && <TuiOverlayFrame height={screenLayout.overlayHeight}><OverlayView overlay={overlay} controller={controller} state={state} sessions={sessions} trashSessions={trashSessions} diffs={diffs} checkpoints={checkpoints} queuedInputs={queuedInputs} plans={plans} tasks={tasks} artifacts={artifacts} toolDetail={toolDetail} detailLines={detailLines} detailViewport={effectiveDetailViewport} columns={columns} rows={rows} timelineLines={timelineLines} transcriptEntries={filteredTranscriptEntries} transcriptQuery={transcriptQuery} transcriptFilter={transcriptFilter} actionIndex={overlayActionIndex} onClose={() => setOverlay(undefined)} /></TuiOverlayFrame>}
    </Box>
  );
}

function Header({ state }: { readonly state: TuiControllerState }): ReactElement {
  const subagents = state.snapshot.subagents;
  const activeTasks = subagents.filter(item => item.status === "queued" || item.status === "running" || item.status === "gating").length;
  const queuedImplementers = subagents.filter(item => item.role === "implementer" && item.status === "queued").length;
  const interruptedGates = subagents.filter(item => item.status === "gateInterrupted").length;
  return <Box flexDirection="column" marginBottom={1}>
    <Text bold color="yellow">Peru Agent TUI</Text>
    <Text dimColor>Workspace: {state.runtime.workspaceRoot} · Model: {state.configuration.model.model} · Mode: {state.activeSession.permissionMode} · Status: {state.snapshot.sessionStatus}</Text>
    <Text dimColor>待审 Plan：{state.snapshot.plans.filter(item => item.status === "reviewing").length} · 待启动 Implementer：{queuedImplementers} · 活动任务：{activeTasks} · 门禁中断：{interruptedGates} · 待审 Diff：{state.snapshot.diffProposals.filter(item => item.status === "proposed").length}</Text>
  </Box>;
}

function HomeScreen({ state, sessions, onOpenSessions }: { readonly state: TuiControllerState; readonly sessions: readonly AgentSessionSnapshot[]; readonly onOpenSessions: () => void }): ReactElement {
  return <Box flexDirection="column" flexGrow={1} paddingX={2} paddingY={1} borderStyle="single" borderColor="gray">
    <Text bold color="yellow">开始使用 Peru Agent</Text>
    <Text>这是一个受审核的工作区 Agent。输入任务后按 Enter，或使用 /help 查看全部命令。</Text>
    <Text dimColor>连接：{state.health?.ok === true ? "● connected" : "◌ connecting"}   权限：{state.configuration.permissionMode}   网络：{state.configuration.networkMode}</Text>
    <Text dimColor>工作区：{state.runtime.workspaceRoot}</Text>
    <Box flexDirection="column" marginTop={1}>
      <Text bold>最近会话</Text>
      {sessions.length === 0 ? <Text dimColor>暂无会话记录；直接输入任务即可新建运行。</Text> : sessions.map(session => <Text key={session.id}>  {session.title ?? "（未命名）"} · {session.status} · {session.updatedAt}</Text>)}
      <Text dimColor>按 Ctrl+P/Tab 打开面板，或输入 /sessions 选择会话。</Text>
      <Text color="yellow">{sessions.length > 0 ? "Enter 输入新任务，/resume 恢复会话" : "Enter 输入新任务"}</Text>
      <Text dimColor>会话列表：/sessions</Text>
    </Box>
  </Box>;
}

function TimelineLine({ line, selection }: { readonly line: TuiRenderedLine; readonly selection?: { readonly start: number; readonly end: number } }): ReactElement {
  if (line.spacer === true) return <Text> </Text>;
  const palette = line.kind === "tool"
    ? { accent: line.text.includes("failed") ? "red" : "blue", foreground: line.text.includes("failed") ? "red" : "blue", background: "#0d1118" }
    : line.role === "user"
      ? { accent: "cyan", foreground: "white", background: "#101719" }
      : line.role === "summary"
        ? { accent: "yellow", foreground: "yellow", background: "#18160f" }
        : { accent: "#f4a261", foreground: "#f1f1f1", background: "#17130f" };
  const content = selection === undefined || selection.end <= selection.start
    ? <Text color={palette.foreground}>{line.text}</Text>
    : <Text color={palette.foreground}><Text>{sliceDisplay(line.text, 0, selection.start)}</Text><Text color="black" backgroundColor="white">{sliceDisplay(line.text, selection.start, selection.end)}</Text><Text>{sliceDisplay(line.text, selection.end, Number.MAX_SAFE_INTEGER)}</Text></Text>;
  return <Box width="100%" backgroundColor={palette.background}><Text color={palette.accent}>┃ </Text>{content}</Box>;
}

function sliceDisplay(value: string, start: number, end: number): string {
  if (end === Number.MAX_SAFE_INTEGER) return sliceAnsi(value, start);
  return sliceAnsi(value, start, Math.max(start, end));
}

function OverlayView({ overlay, controller, state, sessions, trashSessions, diffs, checkpoints, queuedInputs, plans, tasks, artifacts, toolDetail, detailLines, detailViewport, columns, rows, timelineLines, transcriptEntries, transcriptQuery, transcriptFilter, actionIndex, onClose }: { readonly overlay: Overlay; readonly controller: TuiController; readonly state: TuiControllerState; readonly sessions: readonly AgentSessionSnapshot[]; readonly trashSessions: readonly TrashedSessionRecord[]; readonly diffs: readonly DiffProposal[]; readonly checkpoints: readonly CheckpointRecord[]; readonly queuedInputs: readonly AgentQueuedInput[]; readonly plans: readonly PlanRecord[]; readonly tasks: readonly SubagentTaskRecord[]; readonly artifacts: readonly SubagentCommit[]; readonly toolDetail: TuiToolResultDetail | undefined; readonly detailLines: readonly string[]; readonly detailViewport: TuiViewportState; readonly columns: number; readonly rows: number; readonly timelineLines: readonly TuiRenderedLine[]; readonly transcriptEntries: readonly TuiTranscriptEntry[]; readonly transcriptQuery: string; readonly transcriptFilter: TuiTranscriptFilter; readonly actionIndex: number; readonly onClose: () => void }): ReactElement {
  if (overlay.kind === "config") return <TuiConfigurationEditor initialDraft={overlay.draft} embedded onCancel={onClose} onSubmit={async draft => { await controller.reconfigure(await configurationFromTuiSetupDraft(draft)); onClose(); }} />;
  if (overlay.kind === "planEditor") return <TuiPlanEditor {...(overlay.instruction === undefined ? {} : { instruction: overlay.instruction })} onCancel={onClose} onSubmit={async input => { try { await controller.createStructuredPlan(input); controller.setStatus("Plan 已创建，等待审核"); onClose(); } catch (error: unknown) { controller.setStatus(errorMessage(error)); } }} />;
  if (overlay.kind === "taskEditor") return <TuiTaskEditor {...(overlay.instruction === undefined ? {} : { instruction: overlay.instruction })} onCancel={onClose} onSubmit={async input => { try { await controller.dispatchStructuredTask(input); controller.setStatus(input.role === "implementer" ? "Implementer 已排队，等待确认启动" : "只读子 Agent 已启动"); onClose(); } catch (error: unknown) { controller.setStatus(errorMessage(error)); } }} />;
  if (overlay.kind === "artifactConfirm") return <ActionModal title="清理内部 Commit 产物" lines={[`Commit：${overlay.commitId}`, "仅当 Plan 已终止且没有活动任务或待审 Diff 引用时可清理。"]} actions={overlayActions(overlay)} selected={actionIndex} />;
  if (overlay.kind === "taskStartConfirm") { const task = tasks.find(item => item.id === overlay.taskId); return <ActionModal title="确认启动 Implementer" lines={[`任务：${overlay.taskId}`, `范围：${task?.allowedPaths.join(", ") ?? ""}`, `预算：${task?.budget.maxTurns ?? 0} 轮 / ${task?.budget.maxToolCalls ?? 0} ToolCall`, `门禁：${task?.reviewPolicy ?? ""}`]} actions={overlayActions(overlay)} selected={actionIndex} />; }
  if (overlay.kind === "panel") {
    if (overlay.panel === "help") return <ScrollableModal title="帮助" lines={layoutTuiTextLines(TUI_HELP.split("\n"), Math.max(24, columns - 8))} viewport={detailViewport} footer="↑/↓ 选择，Enter 打开，PgUp/PgDn 浏览，Esc 返回" />;
    if (overlay.panel === "model") return <ScrollableModal title="模型" lines={layoutTuiTextLines([`模型：${state.configuration.model.model}`, `Endpoint：${state.configuration.model.baseUrl}${state.configuration.model.chatCompletionsPath}`, `API Key：${state.configuration.model.apiKey.trim() === "" ? "未配置" : "已配置（不会显示值）"}`], Math.max(24, columns - 8))} viewport={detailViewport} footer="Esc 返回" />;
    if (overlay.panel === "doctor") return <DoctorPanel health={state.health} viewport={detailViewport} columns={columns} />;
    if (overlay.panel === "transcript") {
      const transcriptLines = layoutTuiTextLines(transcriptEntries.map(entry => `[${entry.kind}] ${entry.text}`), Math.max(24, columns - 8));
      return <ScrollableModal title={`Transcript · ${transcriptFilter}${transcriptQuery === "" ? "" : ` · 搜索：${transcriptQuery}`}`} lines={transcriptLines} viewport={detailViewport} footer="Ctrl+F 搜索 · ← 切换过滤 · C/Enter 复制 · PgUp/PgDn/滚轮浏览 · Esc 返回" />;
    }
    const lines = panelLines(overlay.panel, state.snapshot, sessions, diffs, checkpoints, queuedInputs, plans, tasks, artifacts, trashSessions);
    return <SelectableModal title={panelTitle(overlay.panel)} selected={clampTuiSelection(overlay.selected, lines.length)} lines={lines} rows={rows} />;
  }
  if (overlay.kind === "restore") return <ActionModal title={`恢复 Checkpoint ${overlay.checkpointId}`} lines={["选择恢复范围：文件和对话会创建新的分支 Session；原 Session 保持不变。"]} actions={overlayActions(overlay)} selected={actionIndex} />;
  if (overlay.kind === "queueChoice") return <ActionModal title="运行中提交" lines={["选择这条输入如何进入当前运行；Esc 取消。"]} actions={overlayActions(overlay)} selected={actionIndex} />;
  if (overlay.kind === "externalAccess") return <ActionModal title="授权访问外部目录" lines={["Agent 请求读取/提出修改以下外部路径：", ...overlay.paths]} actions={overlayActions(overlay)} selected={actionIndex} />;
  if (overlay.kind === "shell") return <ActionModal title="确认 Shell 命令" lines={["该命令将通过 PowerShell Tool 和 Sandbox Broker 执行：", "$ " + overlay.command]} actions={overlayActions(overlay)} selected={actionIndex} />;
  if (overlay.kind === "planReview") { const plan = state.snapshot.plans.find(item => item.planId === overlay.planId); return <ActionModal title="Plan 审核" lines={[`标题：${plan?.title ?? overlay.planId}`, `摘要：${plan?.summary ?? ""}`, `置信度：${plan?.confidence ?? 0}%`, `步骤：${plan?.steps.length ?? 0}`]} actions={overlayActions(overlay)} selected={actionIndex} />; }
  if (overlay.kind === "permission" || overlay.kind === "diff") {
    const effective = reduceTuiViewport(detailViewport, {}, detailLines.length, detailViewport.pageSize);
    const range = getTuiViewportRange(effective);
    return <ActionModal title={detailTitle(overlay, state.snapshot)} lines={detailLines.slice(range.start, range.end)} actions={overlayActions(overlay)} selected={actionIndex} />;
  }
  return <ScrollableModal title={detailTitle(overlay, state.snapshot)} lines={detailLines} viewport={detailViewport} footer={detailFooter(overlay)} />;
}

function buildDetailLines(overlay: Exclude<Overlay, { readonly kind: "panel" | "config" | "planEditor" | "taskEditor" | "artifactConfirm" | "taskStartConfirm" | "restore" | "queueChoice" | "externalAccess" | "shell" | "planReview" }>, controller: TuiController, snapshot: WorkbenchSnapshot, workspaceRoot: string, toolDetail: TuiToolResultDetail | undefined): readonly string[] {
  if (overlay.kind === "permission") {
    const request = snapshot.pendingPermissions.find(item => item.requestId === overlay.requestId);
    if (request === undefined) return ["请求已结束"];
    const command = request.commandText ?? request.reason;
    return [
      `Tool：${request.toolName}   Risk：${request.riskLevel}`,
      `能力：${request.capabilities.join(", ") || "无"}`,
      `文件：${request.affectedFiles.join(", ") || "无"}`,
      `网络：${request.networkTargets.join(", ") || "无"}`,
      `命令：${request.commands.join(", ") || "无"}`,
      ...(overlay.full ? [command] : [command.length > 512 ? `${command.slice(0, 512)}…` : command]),
    ];
  }
  if (overlay.kind === "diff") {
    const proposal = controller.getDiff(overlay.proposalId);
    if (proposal === undefined) return ["Diff 不存在"];
    return overlay.full
      ? proposal.changes.flatMap(change => [change.path, change.unifiedDiff, ""])
      : proposal.changes.map(change => `${change.path}（${change.before.exists ? "修改" : "新建"}）`);
  }
  const tool = snapshot.tools.find(item => item.toolCallId === overlay.toolCallId);
  const metadata = tool === undefined ? [] : [
    `Tool：${tool.toolName} · 状态：${tool.state}`,
    `脚本：${tool.commandText ?? "（无）"}`,
    `CWD：${workspaceRoot}`,
    `AST 命令：${tool.commands.join(", ") || "无"}`,
    `动态能力：${tool.capabilities.join(", ") || "无"}`,
    `网络目标：${tool.networkTargets.join(", ") || "无"}`,
    `影响文件：${tool.affectedFiles.join(", ") || "无"}`,
  ];
  if (toolDetail === undefined) return ["加载中…"];
  if (toolDetail.powerShell === undefined) return [...metadata, toolDetail.content];
  const result = toolDetail.powerShell;
  return [...metadata, `exitCode=${result.exitCode} timedOut=${result.timedOut} interrupted=${result.interrupted}`, `durationMs=${result.durationMs}`, `auditLogPath=${result.auditLogPath}`, "--- stdout ---", result.stdout || "（空）", "--- stderr ---", result.stderr || "（空）"];
}

function detailTitle(overlay: Exclude<Overlay, { readonly kind: "panel" | "config" | "planEditor" | "taskEditor" | "artifactConfirm" | "taskStartConfirm" | "restore" | "queueChoice" | "externalAccess" | "shell" | "planReview" }>, snapshot: WorkbenchSnapshot): string {
  if (overlay.kind === "permission") return "权限确认";
  if (overlay.kind === "diff") return `Diff Proposal ${overlay.proposalId}`;
  const tool = snapshot.tools.find(item => item.toolCallId === overlay.toolCallId);
  return `${tool?.toolName ?? "Tool"} 完整结果`;
}

function detailFooter(overlay: Exclude<Overlay, { readonly kind: "panel" | "config" | "planEditor" | "taskEditor" | "artifactConfirm" | "taskStartConfirm" | "restore" | "queueChoice" | "externalAccess" | "shell" | "planReview" }>): string {
  if (overlay.kind === "permission") return "[A] 允许一次  [S] 允许本会话  [P] 允许本项目  [D] 拒绝  [V] 查看完整内容  [Esc] 拒绝";
  if (overlay.kind === "diff") return "[A] 接受并写入  [R] 拒绝  [V] 查看完整 Diff  [Esc] 拒绝";
  return "PgUp/PgDn 浏览，Esc 返回";
}

function panelLines(panel: PanelKind, snapshot: WorkbenchSnapshot, sessions: readonly AgentSessionSnapshot[], diffs: readonly DiffProposal[], checkpoints: readonly CheckpointRecord[], queuedInputs: readonly AgentQueuedInput[] = [], plans: readonly PlanRecord[] = [], tasks: readonly SubagentTaskRecord[] = [], artifacts: readonly SubagentCommit[] = [], trashSessions: readonly TrashedSessionRecord[] = []): readonly string[] {
  if (panel === "permissions") return snapshot.pendingPermissions.map(item => `${item.requestId} · ${item.toolName} · ${item.riskLevel} · ${item.reason}`);
  if (panel === "sessions") return sessions.map(item => `${item.title ?? "（未命名）"} · ${item.id} · ${item.status} · ${item.permissionMode} · ${item.updatedAt}`);
  if (panel === "trash") return trashSessions.map(item => `${item.snapshot.title ?? "（未命名）"} · ${item.snapshot.id} · 删除于 ${item.deletedAt}`);
  if (panel === "diffs") return diffs.map(item => `${item.id} · ${item.status} · ${item.changes.map(change => change.path).join(", ")}`);
  if (panel === "checkpoints") return checkpoints.map(item => `${item.id} · ${item.status} · ${item.files.map(file => file.path).join(", ")}`);
  if (panel === "context") return [`上下文窗口：${snapshot.usage.inputTokens} / 配置窗口见 /doctor`];
  if (panel === "usage") return [`累计输入：${snapshot.usage.inputTokens}`, `累计输出：${snapshot.usage.outputTokens}`, `ToolCall：${snapshot.tools.length}`];
  if (panel === "queue") return queuedInputs.map(item => `${item.id} · ${item.priority} · ${item.input.displayContent ?? item.input.content}`);
  if (panel === "plans") return plans.map(item => {
    const linked = tasks.filter(task => task.planId === item.id);
    const coverage = item.steps.map(step => {
      const bound = linked.filter(task => task.planStepId === step.id);
      return `${step.title}:${bound.some(task => task.status === "merged" || task.status === "noChanges" || task.status === "completed") ? "✓" : bound.length > 0 ? "…" : "-"}`;
    }).join(" ");
    return `${item.title} · ${item.status} · ${item.confidence}% · ${coverage || "无步骤"} · 任务${linked.length}`;
  });
  if (panel === "tasks" || panel === "subagents") return tasks.map(item => `${item.id} · ${item.role} · ${item.status} · Plan=${item.planId ?? "独立"}/${item.planStepId ?? "-"} · Attempt=${item.attemptId} · Commit=${item.outputCommitId ?? "-"} · ${item.reviewPolicy}`);
  if (panel === "artifacts") return artifacts.map(item => `${item.id} · ${item.taskId} · ${item.files.length} files · ${item.createdAt}`);
  return snapshot.tools.slice(-8).map(item => `${item.toolCallId} · ${item.toolName} · ${item.state} · ${item.outputTruncated === true ? "预览已截断" : ""}`);
}

function panelTitle(panel: PanelKind): string {
  const titles: Record<PanelKind, string> = { help: "帮助", permissions: "权限队列", sessions: "Sessions", diffs: "Diff 队列", checkpoints: "Checkpoints", tools: "Tools", model: "模型", doctor: "健康检查", context: "上下文", usage: "用量", queue: "输入队列", plans: "Plans", tasks: "任务", subagents: "子 Agent", trash: "回收区", transcript: "Transcript", artifacts: "内部 Commit 产物" };
  return titles[panel];
}

function panelDetailLines(panel: PanelKind, state: TuiControllerState): readonly string[] {
  if (panel === "help") return TUI_HELP.split("\n");
  if (panel === "model") return [
    `模型：${state.configuration.model.model}`,
    `Endpoint：${state.configuration.model.baseUrl}${state.configuration.model.chatCompletionsPath}`,
    `API Key：${state.configuration.model.apiKey.trim() === "" ? "未配置" : "已配置（不会显示值）"}`,
  ];
  if (panel === "context") { const current = state.activeSession.usage.contextTokens ?? state.activeSession.usage.lastInputTokens ?? 0; return [`上下文窗口：${state.configuration.model.contextWindowTokens}`, `最近上下文 Token：${current}`, `占用：${Math.min(100, Math.round((current / state.configuration.model.contextWindowTokens) * 100))}%`]; }
  if (panel === "usage") return [`累计输入：${state.activeSession.usage.inputTokens}`, `累计输出：${state.activeSession.usage.outputTokens}`, `运行次数：${state.activeSession.usage.runCount ?? 0}`, `ToolCall：${state.activeSession.usage.toolCallCount ?? 0}`];
  const health = state.health;
  return health === undefined ? ["检查中…"] : health.messages.concat(`overall=${health.ok ? "ok" : "failed"}`);
}

function overlayIdentity(overlay: Overlay | undefined): string {
  if (overlay === undefined) return "none";
  if (overlay.kind === "permission") return `permission:${overlay.requestId}:${overlay.full}`;
  if (overlay.kind === "diff") return `diff:${overlay.proposalId}:${overlay.full}`;
  if (overlay.kind === "restore") return `restore:${overlay.checkpointId}`;
  if (overlay.kind === "tool") return `tool:${overlay.toolCallId}`;
  if (overlay.kind === "config") return "config";
  if (overlay.kind === "planEditor") return "planEditor";
  if (overlay.kind === "taskEditor") return "taskEditor";
  if (overlay.kind === "artifactConfirm") return `artifact:${overlay.commitId}`;
  if (overlay.kind === "taskStartConfirm") return `taskStart:${overlay.taskId}`;
  if (overlay.kind === "queueChoice") return `queue:${overlay.input}`;
  if (overlay.kind === "externalAccess") return `external:${overlay.input}`;
  if (overlay.kind === "shell") return `shell:${overlay.command}`;
  if (overlay.kind === "planReview") return `plan:${overlay.planId}`;
  return `panel:${overlay.panel}`;
}

function DoctorPanel({ health, viewport, columns }: { readonly health: TuiHealthReport | undefined; readonly viewport: TuiViewportState; readonly columns: number }): ReactElement {
  const lines = health === undefined ? ["检查中…"] : health.messages.concat(`overall=${health.ok ? "ok" : "failed"}`);
  return <ScrollableModal title="健康检查" lines={layoutTuiTextLines(lines, Math.max(24, columns - 8))} viewport={viewport} footer="Esc 返回" />;
}

function SelectableModal({ title, selected, lines, rows }: { readonly title: string; readonly selected: number; readonly lines: readonly string[]; readonly rows: number }): ReactElement {
  const window = selectableModalWindow(lines.length, selected, rows);
  const start = window.start;
  const visible = lines.slice(start, start + window.visibleCount);
  const footer = lines.length === 0 ? "当前没有项目" : `位置 ${start + 1}-${Math.min(lines.length, start + window.visibleCount)}/${lines.length}`;
  return <Modal title={`${title}  ↑/↓  Enter  Esc`} lines={[...visible.map((line, index) => `${start + index === selected ? "›" : " "} ${line}`), footer]} selectedLine={clampTuiSelection(selected - start, visible.length)} />;
}

function ScrollableModal({ title, lines, viewport, footer }: { readonly title: string; readonly lines: readonly string[]; readonly viewport: TuiViewportState; readonly footer: string }): ReactElement {
  const effective = reduceTuiViewport(viewport, {}, lines.length, viewport.pageSize);
  const range = getTuiViewportRange(effective);
  return <Modal title={title} lines={[...lines.slice(range.start, range.end), footer, effective.offset > 0 || effective.unread > 0 ? `位置 ${range.start + 1}-${range.end}/${lines.length}` : ""]} />;
}

function TuiOverlayFrame({ height, children }: { readonly height: number; readonly children: ReactElement }): ReactElement {
  return <Box position="absolute" marginTop={0} marginLeft={0} width="100%" height={height} flexDirection="column" alignItems="center" justifyContent="center" overflow="hidden">{children}</Box>;
}

function Modal({ title, lines, selectedLine }: { readonly title: string; readonly lines: readonly string[]; readonly selectedLine?: number }): ReactElement {
  return <Box paddingX={2} paddingY={1} flexDirection="column" borderStyle="single" borderColor="gray" backgroundColor="black" width="90%" overflow="hidden">
    <Box justifyContent="space-between"><Text bold color="#f4a261">{title}</Text><Text dimColor>esc</Text></Box>
    {lines.map((line, index) => {
      const selected = selectedLine === index;
      return <Box key={`${title}-${index}`} width="100%" {...(selected ? { backgroundColor: "#f4a261" } : {})}><Text {...(selected ? { color: "black" as const, bold: true } : {})}>{line}</Text></Box>;
    })}
  </Box>;
}

interface TuiOverlayAction {
  readonly label: string;
  readonly value: string;
}

function ActionModal({ title, lines, actions, selected }: { readonly title: string; readonly lines: readonly string[]; readonly actions: readonly TuiOverlayAction[]; readonly selected: number }): ReactElement {
  return <Box paddingX={2} flexDirection="column" borderStyle="single" borderColor="gray" backgroundColor="black" width="90%" overflow="hidden">
    <Box justifyContent="space-between"><Text bold color="#f4a261">{title}</Text><Text dimColor>←/→ 选择 · Enter 确认 · esc</Text></Box>
    {lines.map((line, index) => <Text key={`${title}-body-${index}`}>{line}</Text>)}
    <Box width="100%" justifyContent="space-around">
      {actions.map((action, index) => {
        const active = index === clampTuiSelection(selected, actions.length);
        return <Text key={`${action.value}-${index}`} {...(active ? { backgroundColor: "#f4a261", color: "black" as const, bold: true } : { color: "gray" as const })}> {active ? "› " : ""}{action.label} </Text>;
      })}
    </Box>
  </Box>;
}

function overlayActions(overlay: Overlay): readonly TuiOverlayAction[] {
  if (overlay.kind === "permission") return [
    { label: "允许一次", value: "a" },
    { label: "本会话", value: "s" },
    { label: "本项目", value: "p" },
    { label: "查看完整", value: "v" },
    { label: "拒绝", value: "d" },
  ];
  if (overlay.kind === "diff") return [
    { label: "接受并写入", value: "a" },
    { label: "查看完整", value: "v" },
    { label: "拒绝", value: "r" },
  ];
  if (overlay.kind === "externalAccess") return [{ label: "授权当前会话目录", value: "a" }, { label: "拒绝", value: "d" }];
  if (overlay.kind === "shell") return [{ label: "确认执行", value: "a" }, { label: "取消", value: "d" }];
  if (overlay.kind === "planReview") return [{ label: "接受 Plan", value: "a" }, { label: "拒绝", value: "d" }];
  if (overlay.kind === "restore") return [{ label: "文件和对话", value: "a" }, { label: "仅文件", value: "f" }, { label: "仅对话", value: "c" }, { label: "取消", value: "r" }];
  if (overlay.kind === "queueChoice") return [
    { label: "中断并发送", value: "i" },
    { label: "引导当前运行", value: "g" },
    { label: "排队下一轮", value: "l" },
  ];
  if (overlay.kind === "artifactConfirm") return [{ label: "确认清理", value: "a" }, { label: "取消", value: "d" }];
  if (overlay.kind === "taskStartConfirm") return [{ label: "启动", value: "a" }, { label: "取消", value: "d" }];
  return [];
}

function overlayActionBodyLineCount(
  overlay: Overlay,
  detailLines: readonly string[],
  detailViewport: TuiViewportState,
  snapshot: WorkbenchSnapshot,
): number {
  if (overlay.kind === "permission" || overlay.kind === "diff") {
    return Math.min(detailLines.length, Math.max(1, detailViewport.pageSize));
  }
  if (overlay.kind === "externalAccess") return 1 + overlay.paths.length;
  if (overlay.kind === "shell") return 2;
  if (overlay.kind === "planReview") return snapshot.plans.some(item => item.planId === overlay.planId) ? 4 : 4;
  if (overlay.kind === "taskStartConfirm") return 4;
  if (overlay.kind === "artifactConfirm") return 2;
  return 1;
}

function actionModalIndexAtMouse(
  x: number,
  y: number,
  bodyLineCount: number,
  actionCount: number,
  columns: number,
  rows: number,
): number | undefined {
  if (actionCount <= 0) return undefined;
  const modalWidth = Math.max(24, Math.floor(columns * 0.9));
  const modalLeft = Math.max(0, Math.floor((columns - modalWidth) / 2));
  const modalHeight = Math.max(4, bodyLineCount + 4);
  const modalTop = Math.max(0, Math.floor((Math.max(1, rows - 1) - modalHeight) / 2));
  const actionRow = modalTop + modalHeight - 2;
  if (y < actionRow - 1 || y > actionRow + 1 || x <= modalLeft || x >= modalLeft + modalWidth) return undefined;
  const relativeX = x - modalLeft - 1;
  const innerWidth = Math.max(1, modalWidth - 2);
  return Math.min(actionCount - 1, Math.max(0, Math.floor(relativeX * actionCount / innerWidth)));
}

function nextPanel(current: PanelKind | undefined): PanelKind {
  const panels: readonly PanelKind[] = ["permissions", "sessions", "diffs", "checkpoints", "plans", "tasks", "subagents", "artifacts", "tools", "model", "doctor", "context", "usage", "queue", "help"];
  const index = current === undefined ? -1 : panels.indexOf(current);
  return panels[(index + 1) % panels.length] ?? "sessions";
}

function selectableModalWindow(count: number, selected: number, rows: number): { readonly start: number; readonly visibleCount: number } {
  const visibleCount = Math.max(5, Math.floor(rows) - 10);
  const start = count <= visibleCount
    ? 0
    : Math.min(Math.max(0, selected - visibleCount + 1), count - visibleCount);
  return { start, visibleCount };
}

function selectablePanelIndexAtMouse(
  x: number,
  y: number,
  selected: number,
  count: number,
  columns: number,
  rows: number,
): number | undefined {
  if (count <= 0) return undefined;
  const window = selectableModalWindow(count, selected, rows);
  const displayed = Math.min(count, window.visibleCount);
  const modalWidth = Math.max(24, Math.floor(columns * 0.9));
  const modalLeft = Math.max(0, Math.floor((columns - modalWidth) / 2));
  const modalHeight = displayed + 6;
  const modalTop = Math.max(0, Math.floor((Math.max(1, rows - 1) - modalHeight) / 2));
  const listTop = modalTop + 3;
  if (x < modalLeft || x >= modalLeft + modalWidth || y < listTop || y >= listTop + displayed) return undefined;
  return window.start + (y - listTop);
}

function isDirectClickPanel(panel: PanelKind): boolean {
  return panel === "sessions"
    || panel === "diffs"
    || panel === "checkpoints"
    || panel === "permissions"
    || panel === "tools";
}

function calculateHeaderRows(state: TuiControllerState, columns: number): number {
  const width = Math.max(8, Math.floor(columns) - 2);
  const second = `Workspace: ${state.runtime.workspaceRoot} · Model: ${state.configuration.model.model} · Mode: ${state.activeSession.permissionMode} · Status: ${state.snapshot.sessionStatus}`;
  const third = `待审 Plan：${state.snapshot.plans.filter(item => item.status === "reviewing").length} · 待启动 Implementer：${state.snapshot.subagents.filter(item => item.role === "implementer" && item.status === "queued").length} · 活动任务：${state.snapshot.subagents.filter(item => item.status === "queued" || item.status === "running" || item.status === "gating").length} · 门禁中断：${state.snapshot.subagents.filter(item => item.status === "gateInterrupted").length} · 待审 Diff：${state.snapshot.diffProposals.filter(item => item.status === "proposed").length}`;
  return 1 + layoutTuiTextLines([second], width).length + layoutTuiTextLines([third], width).length + 1;
}

function isScrollableOverlay(overlay: Overlay): boolean {
  if (overlay.kind === "permission" || overlay.kind === "diff" || overlay.kind === "tool") return true;
  return overlay.kind === "panel" && (overlay.panel === "help" || overlay.panel === "model" || overlay.panel === "doctor" || overlay.panel === "transcript");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "未知 TUI 错误";
}

function isRunActive(state: TuiControllerState): boolean {
  return state.snapshot.sessionStatus === "running" || state.snapshot.sessionStatus === "awaitingPermission";
}
