import { useEffect, useMemo, useState, type ReactNode } from "react";
import { decodePasteBytes, type CliRenderer } from "@opentui/core";
import {
  useKeyboard,
  usePaste,
  useRenderer,
  useSelectionHandler,
  useTerminalDimensions,
} from "@opentui/react";
import type { AgentSessionSnapshot, AgentUserInput } from "../../src/agent/types.js";
import type { CheckpointRecord } from "../../src/checkpoint/checkpoint-manager.js";
import type { DiffProposal } from "../../src/diff/diff-manager.js";
import type { ToolActivityView } from "../../src/workbench/workbench-state.js";
import type { TuiToolResultDetail } from "../../src/tui/runtime.js";
import { parseTuiCommand, TUI_COMMANDS, TUI_HELP, type TuiCommand } from "../../src/tui/commands.js";
import { configurationFromTuiSetupDraft, configurationToTuiSetupDraft } from "../../src/tui/config.js";
import { TuiController, type TuiControllerState } from "../../src/tui/controller.js";
import { createTuiInputBuffer, reduceTuiInput, type TuiInputBufferState } from "../../src/tui/input-buffer.js";
import { buildTuiConversationTurns, flattenTuiConversationTurns, getTuiInputWindow, layoutTuiLines } from "../../src/tui/terminal-layout.js";
import { adaptOpenTuiKey } from "../../src/tui/opentui-key-adapter.js";
import { acceptTuiSuggestion, getTuiSuggestions, type TuiSuggestion } from "../../src/tui/suggestions.js";
import { copyRendererSelection } from "./selection.js";
import { OpenTuiConfigurationEditor } from "./setup.js";
import { OpenTuiPlanEditor, OpenTuiTaskEditor } from "./orchestration-editors.js";

interface OpenTuiAppProps {
  readonly controller: TuiController;
  readonly onExit: () => Promise<void>;
}

type Panel =
  | { readonly kind: "help"; readonly title: string; readonly lines: readonly string[] }
  | { readonly kind: "sessions"; readonly title: string; readonly sessions: readonly AgentSessionSnapshot[]; readonly selected: number }
  | { readonly kind: "tools"; readonly title: string; readonly tools: readonly ToolActivityView[]; readonly selected: number }
  | { readonly kind: "diffs"; readonly title: string; readonly diffs: readonly DiffProposal[]; readonly selected: number }
  | { readonly kind: "checkpoints"; readonly title: string; readonly checkpoints: readonly CheckpointRecord[]; readonly selected: number }
  | { readonly kind: "text"; readonly title: string; readonly lines: readonly string[] };

type ActionDialog =
  | { readonly kind: "externalAccess"; readonly input: string; readonly paths: readonly string[] }
  | { readonly kind: "shell"; readonly command: string }
  | { readonly kind: "queueChoice"; readonly input: string; readonly prepared: AgentUserInput }
  | { readonly kind: "config" }
  | { readonly kind: "planEditor"; readonly instruction?: string }
  | { readonly kind: "taskEditor"; readonly instruction?: string };

export function OpenTuiApp({ controller, onExit }: OpenTuiAppProps): ReactNode {
  const renderer = useRenderer();
  const { width, height } = useTerminalDimensions();
  const [state, setState] = useState<TuiControllerState>(controller.getState());
  const [input, setInput] = useState<TuiInputBufferState>(createTuiInputBuffer());
  const [panel, setPanel] = useState<Panel | undefined>();
  const [dialog, setDialog] = useState<ActionDialog | undefined>();
  const [selectionActive, setSelectionActive] = useState(false);
  const [verboseTranscript, setVerboseTranscript] = useState(false);
  const [suggestions, setSuggestions] = useState<readonly TuiSuggestion[]>([]);
  const [suggestionIndex, setSuggestionIndex] = useState(0);

  useEffect(() => {
    const subscription = controller.onState(next => setState(next));
    void controller.loadInputHistory().then(history => {
      setInput(current => ({ ...current, history: [...history] }));
    }).catch(error => controller.setStatus(errorMessage(error)));
    void controller.doctor().catch(() => undefined);
    return () => subscription.dispose();
  }, [controller]);

  useEffect(() => {
    const current = input.text;
    if (current.trimStart().startsWith("/")) {
      setSuggestions(getTuiSuggestions(current, TUI_COMMANDS, []));
      setSuggestionIndex(0);
      return;
    }
    const match = /(?:^|\s)@([^\s]*)$/.exec(current);
    if (match !== null) {
      void controller.getRuntime().suggestFiles(match[1] ?? "")
        .then(files => {
          setSuggestions(getTuiSuggestions(current, TUI_COMMANDS, files));
          setSuggestionIndex(0);
        })
        .catch(() => setSuggestions([]));
      return;
    }
    setSuggestions([]);
  }, [input.text, controller]);

  useSelectionHandler(selection => {
    setSelectionActive(selection.getSelectedText() !== "");
  });

  const turns = useMemo(
    () => buildTuiConversationTurns(state.activeSession, state.snapshot),
    [state.activeSession, state.snapshot],
  );
  const timelineLines = useMemo(
    () => layoutTuiLines(
      flattenTuiConversationTurns(turns, verboseTranscript),
      Math.max(24, width - 6),
      { verbose: verboseTranscript },
    ).lines,
    [turns, verboseTranscript, width],
  );
  const inputWindow = getTuiInputWindow(input.text, input.cursor, Math.max(12, width - 8));
  const permission = state.snapshot.pendingPermissions[0];
  const diff = state.snapshot.diffProposals.find(item => item.status === "proposed");
  const plan = state.snapshot.plans.find(item => item.status === "reviewing");
  const modalOpen = permission !== undefined || diff !== undefined || plan !== undefined || panel !== undefined || dialog !== undefined;

  useKeyboard(event => {
    const adapted = adaptOpenTuiKey(event);

    if (selectionActive || renderer.getSelection() !== null) {
      if (event.ctrl && event.name.toLocaleLowerCase() === "c") {
        event.preventDefault();
        event.stopPropagation();
        void copySelection(renderer, controller, setSelectionActive);
        return;
      }
      if (event.name === "escape") {
        renderer.clearSelection();
        setSelectionActive(false);
        event.preventDefault();
        event.stopPropagation();
        return;
      }
    }

    if (dialog?.kind === "config" || dialog?.kind === "planEditor" || dialog?.kind === "taskEditor") return;

    if (dialog !== undefined) {
      void handleDialogKey(dialog, adapted.value, adapted.key);
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    if (permission !== undefined) {
      if (adapted.key.escape || adapted.value.toLocaleLowerCase() === "r") {
        controller.resolvePermission(permission.requestId, "reject");
      } else if (adapted.value.toLocaleLowerCase() === "o") {
        controller.resolvePermission(permission.requestId, "once");
      } else if (adapted.value.toLocaleLowerCase() === "a") {
        controller.resolvePermission(permission.requestId, "always");
      }
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    if (diff !== undefined) {
      if (adapted.key.escape || adapted.value.toLocaleLowerCase() === "r") {
        void controller.resolveDiff(diff.proposalId, "rejected").catch(error => controller.setStatus(errorMessage(error)));
      } else if (adapted.value.toLocaleLowerCase() === "a") {
        void controller.resolveDiff(diff.proposalId, "accepted").catch(error => controller.setStatus(errorMessage(error)));
      }
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    if (plan !== undefined) {
      if (adapted.key.escape || adapted.value.toLocaleLowerCase() === "r") {
        void controller.resolvePlan(plan.planId, "rejected").catch(error => controller.setStatus(errorMessage(error)));
      } else if (adapted.value.toLocaleLowerCase() === "a") {
        void controller.resolvePlan(plan.planId, "approved").catch(error => controller.setStatus(errorMessage(error)));
      }
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    if (panel !== undefined) {
      if (adapted.key.escape) {
        setPanel(undefined);
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      const selectableCount = panelItemCount(panel);
      if (selectableCount > 0 && (adapted.key.up || adapted.key.upArrow)) {
        setPanel(updatePanelSelection(panel, cycleIndex(panelSelection(panel), selectableCount, -1)));
        event.preventDefault();
        return;
      }
      if (selectableCount > 0 && (adapted.key.down || adapted.key.downArrow)) {
        setPanel(updatePanelSelection(panel, cycleIndex(panelSelection(panel), selectableCount, 1)));
        event.preventDefault();
        return;
      }
      if (adapted.key.return && selectableCount > 0) {
        void activatePanelSelection(panel);
        event.preventDefault();
        return;
      }
      return;
    }

    if (event.ctrl && event.name.toLocaleLowerCase() === "c") {
      if (controller.abortActiveRun()) controller.setStatus("已请求取消当前 Agent 运行");
      else controller.setStatus("当前没有运行中的 Agent");
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (event.ctrl && event.name.toLocaleLowerCase() === "o") {
      setVerboseTranscript(current => !current);
      controller.setStatus(verboseTranscript ? "已关闭 Verbose Transcript" : "已开启 Verbose Transcript");
      event.preventDefault();
      return;
    }

    if (suggestions.length > 0) {
      if (adapted.key.escape) {
        setSuggestions([]);
        event.preventDefault();
        return;
      }
      if (adapted.key.upArrow) {
        setSuggestionIndex(current => cycleIndex(current, suggestions.length, -1));
        event.preventDefault();
        return;
      }
      if (adapted.key.downArrow) {
        setSuggestionIndex(current => cycleIndex(current, suggestions.length, 1));
        event.preventDefault();
        return;
      }
      if (adapted.key.tab) {
        const selected = suggestions[suggestionIndex];
        if (selected !== undefined) {
          const accepted = acceptTuiSuggestion(input.text, selected);
          setInput(current => ({ ...current, text: accepted, cursor: accepted.length }));
          setSuggestions([]);
        }
        event.preventDefault();
        return;
      }
    }

    // PageUp/PageDown/Home/End 交给 focused OpenTUI ScrollBox 原生处理。
    if (adapted.key.pageUp || adapted.key.pageDown || (adapted.key.ctrl && (adapted.key.home || adapted.key.end))) return;

    const transition = reduceTuiInput(input, adapted.value, adapted.key);
    setInput(transition.state);
    if (transition.submitted !== undefined) void submitInput(transition.submitted);
  });

  usePaste(event => {
    if (modalOpen) return;
    const pasted = decodePasteBytes(event.bytes);
    if (pasted === "") return;
    setInput(current => ({
      ...current,
      text: current.text.slice(0, current.cursor) + pasted + current.text.slice(current.cursor),
      cursor: current.cursor + pasted.length,
      historyIndex: -1,
    }));
    event.preventDefault();
    event.stopPropagation();
  });

  async function submitInput(value: string): Promise<void> {
    const command = parseTuiCommand(value);
    if (value.startsWith("/") && command === undefined) {
      controller.setStatus("未知或参数无效的命令；输入 /help 查看帮助");
      return;
    }
    if (command !== undefined) {
      await executeCommand(command);
      return;
    }

    const external = controller.getExternalPathCandidates(value);
    if (external.length > 0) {
      setDialog({ kind: "externalAccess", input: value, paths: external });
      return;
    }
    if (value.startsWith("!") && value.slice(1).trim() !== "") {
      setDialog({ kind: "shell", command: value.slice(1).trim() });
      return;
    }

    try {
      const prepared = await controller.prepareUserInput(value);
      if (isRunActive(state)) {
        setDialog({ kind: "queueChoice", input: value, prepared });
      } else {
        await controller.sendInput(prepared);
        await controller.recordInputHistory(value);
      }
    } catch (error: unknown) {
      controller.setStatus(errorMessage(error));
    }
  }

  async function activatePanelSelection(current: Panel): Promise<void> {
    try {
      if (current.kind === "sessions") {
        const selected = current.sessions[current.selected];
        if (selected !== undefined) {
          await controller.activateSession(selected.id);
          setPanel(undefined);
        }
        return;
      }
      if (current.kind === "tools") {
        const tool = current.tools[current.selected];
        if (tool === undefined) return;
        const detail = await controller.getToolResult(tool.toolCallId);
        setPanel({ kind: "text", title: `${tool.toolName} · ${tool.toolCallId}`, lines: toolDetailLines(tool, detail, state.runtime.workspaceRoot) });
        return;
      }
      if (current.kind === "diffs") {
        const selected = current.diffs[current.selected];
        if (selected === undefined) return;
        setPanel({ kind: "text", title: `Diff ${selected.id} · ${selected.status}`, lines: selected.changes.flatMap(change => [change.path, change.unifiedDiff, ""]) });
        return;
      }
      if (current.kind === "checkpoints") {
        const selected = current.checkpoints[current.selected];
        if (selected === undefined) return;
        setPanel({ kind: "text", title: `Checkpoint ${selected.id}`, lines: [
          `status=${selected.status}`,
          ...selected.files.map(file => `${file.path} · ${file.before.exists ? "exists" : "missing"}`),
        ] });
      }
    } catch (error: unknown) {
      controller.setStatus(errorMessage(error));
    }
  }

  async function handleDialogKey(dialogState: Exclude<ActionDialog, { readonly kind: "config" | "planEditor" | "taskEditor" }>, value: string, key: ReturnType<typeof adaptOpenTuiKey>["key"]): Promise<void> {
    const choice = value.toLocaleLowerCase();
    if (dialogState.kind === "externalAccess") {
      if (key.escape || choice === "r" || choice === "d") {
        setDialog(undefined);
        controller.setStatus("已拒绝外部目录访问");
        return;
      }
      if (choice !== "a") return;
      try {
        if (isRunActive(state)) {
          const prepared = await controller.authorizeAndPrepareExternalInput(dialogState.input, dialogState.paths);
          setDialog({ kind: "queueChoice", input: dialogState.input, prepared });
        } else {
          await controller.authorizeAndSendExternalInput(dialogState.input, dialogState.paths);
          await controller.recordInputHistory(dialogState.input);
          setDialog(undefined);
        }
      } catch (error: unknown) {
        setDialog(undefined);
        controller.setStatus(errorMessage(error));
      }
      return;
    }

    if (dialogState.kind === "shell") {
      if (key.escape || choice === "r" || choice === "d") {
        setDialog(undefined);
        controller.setStatus("已取消 Shell 命令");
        return;
      }
      if (choice !== "a") return;
      try {
        const prompt = `请通过 bash Tool（Windows Sandbox Broker）执行以下用户明确确认的命令：${dialogState.command}`;
        const prepared = await controller.prepareUserInput(prompt);
        if (isRunActive(state)) {
          setDialog({ kind: "queueChoice", input: `!${dialogState.command}`, prepared });
        } else {
          await controller.sendInput(prepared);
          await controller.recordInputHistory(`!${dialogState.command}`);
          setDialog(undefined);
        }
      } catch (error: unknown) {
        setDialog(undefined);
        controller.setStatus(errorMessage(error));
      }
      return;
    }

    if (key.escape || choice === "x") {
      setDialog(undefined);
      return;
    }
    const priority = choice === "i" ? "immediate" : choice === "g" ? "guide" : choice === "l" ? "next" : undefined;
    if (priority === undefined) return;
    try {
      await controller.queueInput(dialogState.prepared, priority);
      await controller.recordInputHistory(dialogState.input);
      setDialog(undefined);
      controller.setStatus(priority === "immediate" ? "已中断当前运行，准备立即发送" : priority === "guide" ? "已引导当前运行" : "已排队到下一轮");
    } catch (error: unknown) {
      setDialog(undefined);
      controller.setStatus(errorMessage(error));
    }
  }

  async function executeCommand(command: TuiCommand): Promise<void> {
    try {
      switch (command.kind) {
        case "help":
          setPanel({ kind: "help", title: "帮助", lines: TUI_HELP.split("\n") });
          return;
        case "home":
          setPanel(undefined);
          return;
        case "new":
          await controller.createSession();
          return;
        case "sessions": {
          const sessions = await controller.listSessions();
          setPanel({ kind: "sessions", title: "Sessions", sessions, selected: 0 });
          return;
        }
        case "resume":
          if (command.sessionId === undefined) {
            const sessions = await controller.listSessions();
            setPanel({ kind: "sessions", title: "Sessions", sessions, selected: 0 });
          } else {
            await controller.activateSession(command.sessionId);
          }
          return;
        case "workspace":
          await controller.switchWorkspace(command.path);
          return;
        case "model":
          setPanel({ kind: "text", title: "模型", lines: [
            `模型：${state.configuration.model.model}`,
            `Endpoint：${state.configuration.model.baseUrl}${state.configuration.model.chatCompletionsPath}`,
          ] });
          return;
        case "mode":
          await controller.createSession(command.mode);
          return;
        case "diffs": {
          const diffs = controller.listDiffs();
          setPanel({ kind: "diffs", title: "Diff 队列", diffs, selected: 0 });
          return;
        }
        case "permissions":
          setPanel({ kind: "text", title: "权限队列", lines: state.snapshot.pendingPermissions.map(item => `${item.toolName} · ${item.permission} · ${item.patterns.join(", ")}`) });
          return;
        case "checkpoints": {
          const checkpoints = await controller.listCheckpoints();
          setPanel({ kind: "checkpoints", title: "Checkpoints", checkpoints, selected: 0 });
          return;
        }
        case "restore":
          await controller.restoreCheckpoint(command.checkpointId);
          return;
        case "retry":
          await controller.retryActiveSession();
          return;
        case "doctor": {
          const health = await controller.doctor();
          setPanel({ kind: "text", title: "Doctor", lines: [...health.messages, `overall=${health.ok ? "ok" : "failed"}`] });
          return;
        }
        case "tools": {
          const tools = state.snapshot.tools.slice(-50);
          setPanel({ kind: "tools", title: "Tools", tools, selected: Math.max(0, tools.length - 1) });
          return;
        }
        case "rename":
          if (command.title === undefined) controller.setStatus("用法：/rename 新名称");
          else await controller.renameActiveSession(command.title);
          return;
        case "export":
          controller.setStatus(`已导出：${await controller.exportActiveSession(command.path)}`);
          return;
        case "compact":
          if (isRunActive(state)) throw new Error("运行期间不能压缩会话");
          await controller.compactActiveSession(command.instructions);
          return;
        case "context": {
          const report = await controller.getContextReport();
          setPanel({ kind: "text", title: "Context", lines: Object.entries(report).map(([key, value]) => `${key}: ${String(value)}`) });
          return;
        }
        case "usage":
          setPanel({ kind: "text", title: "Usage", lines: [
            `累计输入：${state.activeSession.usage.inputTokens}`,
            `累计输出：${state.activeSession.usage.outputTokens}`,
            `ToolCall：${state.activeSession.usage.toolCallCount ?? 0}`,
          ] });
          return;
        case "queue":
          setPanel({ kind: "text", title: "输入队列", lines: (await controller.listQueuedInputs()).map(item => `${item.id} · ${item.priority} · ${item.input.displayContent ?? item.input.content}`) });
          return;
        case "plans":
          setPanel({ kind: "text", title: "Plans", lines: controller.listPlans().map(item => `${item.title} · ${item.status} · ${item.confidence}%`) });
          return;
        case "plan":
          setDialog({ kind: "planEditor", ...(command.instruction === undefined ? {} : { instruction: command.instruction }) });
          return;
        case "tasks":
        case "subagents":
          setPanel({ kind: "text", title: "子 Agent", lines: controller.listTasks().map(item => `${item.id} · ${item.role} · ${item.status}`) });
          return;
        case "task":
          setDialog({ kind: "taskEditor", ...(command.instruction === undefined ? {} : { instruction: command.instruction }) });
          return;
        case "trash":
          setPanel({ kind: "text", title: "回收区", lines: (await controller.listTrash()).map(item => `${item.snapshot.title ?? "（未命名）"} · ${item.snapshot.id} · ${item.deletedAt}`) });
          return;
        case "transcript":
          setPanel({ kind: "text", title: "Transcript", lines: (await controller.listTranscriptEntries()).map(item => `[${item.kind}] ${item.text}`) });
          return;
        case "artifacts":
          setPanel({ kind: "text", title: "内部 Commit 产物", lines: (await controller.listArtifacts()).map(item => `${item.id} · ${item.taskId} · ${item.files.length} files`) });
          return;
        case "config":
          if (isRunActive(state)) throw new Error("运行期间不能修改配置，请先按 Ctrl+C");
          setDialog({ kind: "config" });
          return;
        case "clear":
          renderer.clearSelection();
          controller.markOutputRead();
          controller.setStatus("已重置当前 OpenTUI 选择/未读状态，会话未删除");
          return;
        case "exit":
          await onExit();
          return;
      }
    } catch (error: unknown) {
      controller.setStatus(errorMessage(error));
    }
  }

  const contextTokens = state.activeSession.usage.contextTokens ?? state.activeSession.usage.lastInputTokens ?? 0;
  const contextWindow = state.configuration.model.contextWindowTokens;
  const contextPercent = contextWindow <= 0 ? 0 : Math.min(100, Math.round(contextTokens / contextWindow * 100));

  return (
    <box
      flexDirection="column"
      width="100%"
      height="100%"
      backgroundColor="#0d1117"
      onMouseUp={() => { void copySelection(renderer, controller, setSelectionActive); }}
    >
      <box flexDirection="column" paddingX={1} paddingTop={1}>
        <text fg="#f4a261"><strong>Peru Agent</strong></text>
        <text fg="#8b949e">{state.runtime.workspaceRoot} · {state.configuration.model.model} · {state.activeSession.permissionMode} · {state.snapshot.sessionStatus}</text>
      </box>

      <scrollbox
        id="session-scroll"
        flexGrow={1}
        scrollY
        stickyScroll
        stickyStart="bottom"
        viewportCulling
        focused={!modalOpen}
        paddingX={1}
        marginTop={1}
        verticalScrollbarOptions={{ showArrows: false }}
      >
        {timelineLines.length === 0
          ? <text fg="#8b949e" selectable={false}>输入问题开始 Agent 运行。/help 查看帮助。</text>
          : timelineLines.map(line => <TimelineLine key={`${line.entryId}-${line.lineIndex}`} line={line} />)}
        {state.lastRunError !== undefined && (
          <box border borderColor="#f85149" paddingX={1} marginTop={1}>
            <text fg="#f85149">运行问题 [{state.lastRunError.code}]：{state.lastRunError.message}</text>
          </box>
        )}
      </scrollbox>

      {suggestions.length > 0 && (
        <box flexDirection="column" paddingX={2} maxHeight={9}>
          <text fg="#8b949e" selectable={false}>建议（↑/↓ 选择 · Tab 接受 · Esc 关闭）</text>
          {suggestions.slice(0, 8).map((item, index) => (
            <text key={`${item.kind}-${item.value}`} fg={index === suggestionIndex ? "#f4a261" : "#c9d1d9"} selectable={false}>
              {index === suggestionIndex ? "› " : "  "}{item.value}{item.description === undefined ? "" : ` · ${item.description}`}
            </text>
          ))}
        </box>
      )}
      <box border borderColor="#30363d" paddingX={1} marginX={1}>
        <text selectable={false}><span fg="#f4a261">› </span>{inputWindow.before}<span fg="#f4a261">▌</span>{inputWindow.after}</text>
      </box>
      <box flexDirection="row" justifyContent="space-between" paddingX={1}>
        <text fg="#8b949e" selectable={false}>{state.switching ? "正在切换工作区…" : state.status}</text>
        <text fg="#8b949e" selectable={false}>{state.snapshot.sessionStatus} · context {contextTokens}/{contextWindow} ({contextPercent}%) · wheel/PgUp/PgDn scroll · drag select/copy · Ctrl+C cancel</text>
      </box>

      {dialog?.kind === "externalAccess" && <ExternalAccessModal input={dialog.input} paths={dialog.paths} />}
      {dialog?.kind === "shell" && <ShellModal command={dialog.command} />}
      {dialog?.kind === "queueChoice" && <QueueChoiceModal input={dialog.input} />}
      {dialog?.kind === "config" && (
        <OpenTuiConfigurationEditor
          draft={configurationToTuiSetupDraft(state.configuration)}
          title="运行期配置"
          submitStatus="正在验证并切换 TUI 配置…"
          embedded
          onCancel={() => setDialog(undefined)}
          onSubmitDraft={async draft => {
            await controller.reconfigure(await configurationFromTuiSetupDraft(draft));
            setDialog(undefined);
          }}
        />
      )}
      {dialog?.kind === "planEditor" && (
        <OpenTuiPlanEditor
          {...(dialog.instruction === undefined ? {} : { instruction: dialog.instruction })}
          onCancel={() => setDialog(undefined)}
          onSubmit={async planInput => {
            await controller.createStructuredPlan(planInput);
            setDialog(undefined);
            controller.setStatus("Plan 已创建，等待审核");
          }}
        />
      )}
      {dialog?.kind === "taskEditor" && (
        <OpenTuiTaskEditor
          {...(dialog.instruction === undefined ? {} : { instruction: dialog.instruction })}
          onCancel={() => setDialog(undefined)}
          onSubmit={async taskInput => {
            await controller.dispatchStructuredTask(taskInput);
            setDialog(undefined);
            controller.setStatus(taskInput.role === "implementer" ? "Implementer 已排队，等待确认启动" : "只读子 Agent 已启动");
          }}
        />
      )}
      {permission !== undefined && <PermissionModal request={permission} />}
      {diff !== undefined && <DiffModal diff={controller.getDiff(diff.proposalId)} proposalId={diff.proposalId} />}
      {plan !== undefined && <PlanModal plan={plan} />}
      {panel !== undefined && <PanelModal panel={panel} height={height} />}
    </box>
  );
}

function TimelineLine({ line }: { readonly line: ReturnType<typeof layoutTuiLines>["lines"][number] }): ReactNode {
  if (line.spacer === true) return <text selectable={false}> </text>;
  const fg = line.kind === "tool"
    ? (line.text.includes("failed") ? "#f85149" : "#58a6ff")
    : line.role === "user" ? "#ffffff" : line.role === "summary" ? "#d29922" : "#c9d1d9";
  const accent = line.kind === "tool" ? "#58a6ff" : line.role === "user" ? "#39c5cf" : "#f4a261";
  return <text fg={fg} selectionBg="#264f78" selectionFg="#ffffff"><span fg={accent}>┃ </span>{line.text}</text>;
}

function ExternalAccessModal({ input, paths }: { readonly input: string; readonly paths: readonly string[] }): ReactNode {
  return (
    <Modal title="Authorize external paths">
      <text>Agent 请求访问工作区外路径：</text>
      {paths.map(path => <text key={path}>- {path}</text>)}
      <text fg="#8b949e">输入：{input}</text>
      <text fg="#f4a261">[A] Authorize for this Session   [R/Esc] Reject</text>
    </Modal>
  );
}

function ShellModal({ command }: { readonly command: string }): ReactNode {
  return (
    <Modal title="Confirm shell command">
      <text>该命令将通过 bash Tool + Windows Sandbox Broker 执行：</text>
      <text fg="#58a6ff">$ {command}</text>
      <text fg="#f4a261">[A] Confirm   [R/Esc] Cancel</text>
    </Modal>
  );
}

function QueueChoiceModal({ input }: { readonly input: string }): ReactNode {
  return (
    <Modal title="Active run input">
      <text>{input}</text>
      <text fg="#f4a261">[I] Interrupt/send   [G] Guide current run   [L] Queue next   [Esc] Cancel</text>
    </Modal>
  );
}

function PermissionModal({ request }: { readonly request: TuiControllerState["snapshot"]["pendingPermissions"][number] }): ReactNode {
  return (
    <Modal title="Permission">
      <text><strong>{request.toolName}</strong> · risk={request.riskLevel}</text>
      <text>permission: {request.permission}</text>
      <text>patterns: {request.patterns.join(", ") || "*"}</text>
      <text>always: {request.always.join(", ") || "-"}</text>
      <text>reason: {request.reason}</text>
      <text fg="#f4a261">[O] Allow once   [A] Always allow   [R/Esc] Reject</text>
    </Modal>
  );
}

function DiffModal({ diff, proposalId }: { readonly diff: DiffProposal | undefined; readonly proposalId: string }): ReactNode {
  return (
    <Modal title={`Diff ${proposalId}`}>
      {(diff?.changes ?? []).slice(0, 10).map(change => <text key={change.path}>{change.path} · {change.before.exists ? "修改" : "新增"}</text>)}
      <text fg="#f4a261">[A] Accept   [R/Esc] Reject</text>
    </Modal>
  );
}

function PlanModal({ plan }: { readonly plan: TuiControllerState["snapshot"]["plans"][number] }): ReactNode {
  return (
    <Modal title="Plan Review">
      <text><strong>{plan.title}</strong></text>
      <text>{plan.summary}</text>
      <text>confidence: {plan.confidence}% · steps: {plan.steps.length}</text>
      <text fg="#f4a261">[A] Approve   [R/Esc] Reject</text>
    </Modal>
  );
}

function PanelModal({ panel, height }: { readonly panel: Panel; readonly height: number }): ReactNode {
  const lines = panelLines(panel);
  const selectable = panelItemCount(panel) > 0;
  return (
    <Modal title={panel.title}>
      <scrollbox scrollY focused height={Math.max(6, Math.floor(height * 0.45))} viewportCulling>
        {lines.length === 0 ? <text fg="#8b949e">当前没有项目</text> : lines.map((line, index) => <text key={`${panel.title}-${index}`}>{line}</text>)}
      </scrollbox>
      <text fg="#8b949e">Esc 返回{selectable ? " · ↑/↓ 选择 · Enter 查看" : " · wheel/PgUp/PgDn 浏览"}</text>
    </Modal>
  );
}

function panelLines(panel: Panel): readonly string[] {
  if (panel.kind === "sessions") return panel.sessions.map((item, index) => `${index === panel.selected ? "›" : " "} ${item.title ?? "（未命名）"} · ${item.status} · ${item.updatedAt}`);
  if (panel.kind === "tools") return panel.tools.map((item, index) => `${index === panel.selected ? "›" : " "} ${item.toolName} · ${item.state} · ${item.toolCallId}`);
  if (panel.kind === "diffs") return panel.diffs.map((item, index) => `${index === panel.selected ? "›" : " "} ${formatDiff(item)}`);
  if (panel.kind === "checkpoints") return panel.checkpoints.map((item, index) => `${index === panel.selected ? "›" : " "} ${item.id} · ${item.status}`);
  return panel.lines;
}

function panelItemCount(panel: Panel): number {
  if (panel.kind === "sessions") return panel.sessions.length;
  if (panel.kind === "tools") return panel.tools.length;
  if (panel.kind === "diffs") return panel.diffs.length;
  if (panel.kind === "checkpoints") return panel.checkpoints.length;
  return 0;
}

function panelSelection(panel: Panel): number {
  return "selected" in panel ? panel.selected : 0;
}

function updatePanelSelection(panel: Panel, selected: number): Panel {
  if (panel.kind === "sessions") return { ...panel, selected };
  if (panel.kind === "tools") return { ...panel, selected };
  if (panel.kind === "diffs") return { ...panel, selected };
  if (panel.kind === "checkpoints") return { ...panel, selected };
  return panel;
}

function toolDetailLines(tool: ToolActivityView, detail: TuiToolResultDetail | undefined, workspaceRoot: string): readonly string[] {
  const metadata = [
    `Tool：${tool.toolName} · 状态：${tool.state}`,
    `脚本：${tool.commandText ?? "（无）"}`,
    `CWD：${workspaceRoot}`,
    `动态能力：${tool.capabilities.join(", ") || "无"}`,
    `网络目标：${tool.networkTargets.join(", ") || "无"}`,
    `影响文件：${tool.affectedFiles.join(", ") || "无"}`,
  ];
  if (detail === undefined) return [...metadata, "没有持久化 Tool 结果"];
  if (detail.powerShell === undefined) return [...metadata, detail.content];
  const result = detail.powerShell;
  return [
    ...metadata,
    `exitCode=${result.exitCode} timedOut=${result.timedOut} interrupted=${result.interrupted}`,
    `durationMs=${result.durationMs}`,
    `auditLogPath=${result.auditLogPath}`,
    "--- stdout ---",
    result.stdout || "（空）",
    "--- stderr ---",
    result.stderr || "（空）",
  ];
}

function Modal({ title, children }: { readonly title: string; readonly children: ReactNode }): ReactNode {
  return (
    <box
      position="absolute"
      left="10%"
      top="16%"
      width="80%"
      maxHeight="70%"
      flexDirection="column"
      border
      borderStyle="double"
      borderColor="#f4a261"
      backgroundColor="#161b22"
      padding={1}
      zIndex={100}
      title={title}
      titleColor="#f4a261"
    >
      {children}
    </box>
  );
}

async function copySelection(
  renderer: CliRenderer,
  controller: TuiController,
  setSelectionActive: (value: boolean) => void,
): Promise<void> {
  try {
    const copied = await copyRendererSelection(renderer);
    if (copied) controller.setStatus("已复制选中文本");
  } catch (error: unknown) {
    controller.setStatus(errorMessage(error));
  } finally {
    setSelectionActive(false);
  }
}

function cycleIndex(current: number, count: number, direction: -1 | 1): number {
  if (count <= 0) return 0;
  return (current + direction + count) % count;
}

function formatDiff(diff: DiffProposal): string {
  return `${diff.id} · ${diff.status} · ${diff.changes.map(change => change.path).join(", ")}`;
}

function isRunActive(state: TuiControllerState): boolean {
  return state.snapshot.sessionStatus === "running" || state.snapshot.sessionStatus === "awaitingPermission";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
