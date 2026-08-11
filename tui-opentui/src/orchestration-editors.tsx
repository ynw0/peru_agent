import { useState, type ReactNode } from "react";
import { useKeyboard } from "@opentui/react";
import type { CreatePlanInput } from "../../src/plan/plan-manager.js";
import type { SubagentTaskRequest } from "../../src/subagent/types.js";
import { adaptOpenTuiKey } from "../../src/tui/opentui-key-adapter.js";
import {
  TUI_PLAN_EDITOR_FIELDS,
  TUI_TASK_EDITOR_FIELDS,
  addTuiPlanStep,
  buildTuiPlanEditorSubmission,
  buildTuiTaskEditorSubmission,
  createTuiPlanEditorState,
  createTuiTaskEditorState,
  removeTuiPlanStep,
  toggleTuiTaskEnum,
  tuiPlanFieldValue,
  tuiTaskFieldValue,
  updateTuiPlanField,
  updateTuiTaskField,
  type TuiPlanEditorState,
  type TuiTaskEditorState,
} from "../../src/tui/orchestration-state.js";

export interface OpenTuiPlanEditorProps {
  readonly instruction?: string;
  readonly onSubmit: (input: Omit<CreatePlanInput, "sessionId">) => Promise<void>;
  readonly onCancel: () => void;
}

export function OpenTuiPlanEditor({ instruction, onSubmit, onCancel }: OpenTuiPlanEditorProps): ReactNode {
  const [state, setState] = useState<TuiPlanEditorState>(() => createTuiPlanEditorState(instruction));
  const [fieldIndex, setFieldIndex] = useState(0);
  const [stepIndex, setStepIndex] = useState(0);
  const [buffer, setBuffer] = useState(() => tuiPlanFieldValue(state, TUI_PLAN_EDITOR_FIELDS[0], 0));

  const commit = (value: string): TuiPlanEditorState => updateTuiPlanField(
    state,
    TUI_PLAN_EDITOR_FIELDS[fieldIndex] ?? "title",
    value,
    stepIndex,
  );

  useKeyboard(event => {
    const input = adaptOpenTuiKey(event);
    if (input.key.escape) {
      onCancel();
      consume(event);
      return;
    }
    if (input.key.ctrl && input.value === "n") {
      const next = addTuiPlanStep(commit(buffer));
      setState(next);
      setStepIndex(next.steps.length - 1);
      setFieldIndex(4);
      setBuffer("");
      consume(event);
      return;
    }
    if (input.key.ctrl && input.value === "w" && state.steps.length > 1) {
      const next = removeTuiPlanStep(commit(buffer), stepIndex);
      const nextStepIndex = Math.min(stepIndex, next.steps.length - 1);
      setState(next);
      setStepIndex(nextStepIndex);
      setBuffer(tuiPlanFieldValue(next, TUI_PLAN_EDITOR_FIELDS[fieldIndex] ?? "title", nextStepIndex));
      consume(event);
      return;
    }
    if (input.key.ctrl && input.key.upArrow) {
      const nextStep = Math.max(0, stepIndex - 1);
      const next = commit(buffer);
      setState(next);
      setStepIndex(nextStep);
      setBuffer(tuiPlanFieldValue(next, TUI_PLAN_EDITOR_FIELDS[fieldIndex] ?? "title", nextStep));
      consume(event);
      return;
    }
    if (input.key.ctrl && input.key.downArrow) {
      const nextStep = Math.min(state.steps.length - 1, stepIndex + 1);
      const next = commit(buffer);
      setState(next);
      setStepIndex(nextStep);
      setBuffer(tuiPlanFieldValue(next, TUI_PLAN_EDITOR_FIELDS[fieldIndex] ?? "title", nextStep));
      consume(event);
      return;
    }
    if (input.key.tab || input.key.downArrow || input.key.return) {
      const next = commit(buffer);
      if (input.key.return && fieldIndex === TUI_PLAN_EDITOR_FIELDS.length - 1) {
        consume(event);
        void onSubmit(buildTuiPlanEditorSubmission(next));
        return;
      }
      const nextIndex = (fieldIndex + 1) % TUI_PLAN_EDITOR_FIELDS.length;
      setState(next);
      setFieldIndex(nextIndex);
      setBuffer(tuiPlanFieldValue(next, TUI_PLAN_EDITOR_FIELDS[nextIndex] ?? "title", stepIndex));
      consume(event);
      return;
    }
    if (input.key.upArrow) {
      const nextIndex = (fieldIndex - 1 + TUI_PLAN_EDITOR_FIELDS.length) % TUI_PLAN_EDITOR_FIELDS.length;
      const next = commit(buffer);
      setState(next);
      setFieldIndex(nextIndex);
      setBuffer(tuiPlanFieldValue(next, TUI_PLAN_EDITOR_FIELDS[nextIndex] ?? "title", stepIndex));
      consume(event);
      return;
    }
    if (input.key.backspace || input.key.delete) {
      setBuffer(current => current.slice(0, -1));
      consume(event);
      return;
    }
    if (!input.key.ctrl && !input.key.meta && input.value !== "") {
      setBuffer(current => current + input.value);
      consume(event);
    }
  });

  return (
    <EditorFrame
      title={`创建 Plan · Step ${stepIndex + 1}/${state.steps.length}`}
      fields={TUI_PLAN_EDITOR_FIELDS.map(field => [
        field,
        field === TUI_PLAN_EDITOR_FIELDS[fieldIndex] ? buffer : tuiPlanFieldValue(state, field, stepIndex),
      ] as const)}
      footer="Tab/↓ 下一个字段 · Ctrl+N 新增步骤 · Ctrl+W 删除步骤 · Ctrl+↑/↓ 切换步骤 · Enter 提交 · Esc 取消"
    />
  );
}

export interface OpenTuiTaskEditorProps {
  readonly instruction?: string;
  readonly onSubmit: (input: Omit<SubagentTaskRequest, "parentSessionId" | "baseWorkspaceId">) => Promise<void>;
  readonly onCancel: () => void;
}

export function OpenTuiTaskEditor({ instruction, onSubmit, onCancel }: OpenTuiTaskEditorProps): ReactNode {
  const [state, setState] = useState<TuiTaskEditorState>(() => createTuiTaskEditorState(instruction));
  const [fieldIndex, setFieldIndex] = useState(0);
  const [buffer, setBuffer] = useState(() => tuiTaskFieldValue(state, TUI_TASK_EDITOR_FIELDS[0]));
  const commit = (value: string): TuiTaskEditorState => updateTuiTaskField(
    state,
    TUI_TASK_EDITOR_FIELDS[fieldIndex] ?? "instruction",
    value,
  );

  useKeyboard(event => {
    const input = adaptOpenTuiKey(event);
    if (input.key.escape) {
      onCancel();
      consume(event);
      return;
    }
    const currentField = TUI_TASK_EDITOR_FIELDS[fieldIndex] ?? "role";
    if (input.value === " " && (currentField === "role" || currentField === "reviewPolicy")) {
      const next = toggleTuiTaskEnum(state, currentField);
      setState(next);
      setBuffer(tuiTaskFieldValue(next, currentField));
      consume(event);
      return;
    }
    if (input.key.tab || input.key.downArrow || input.key.return) {
      const next = commit(buffer);
      if (input.key.return && fieldIndex === TUI_TASK_EDITOR_FIELDS.length - 1) {
        consume(event);
        void onSubmit(buildTuiTaskEditorSubmission(next));
        return;
      }
      const nextIndex = (fieldIndex + 1) % TUI_TASK_EDITOR_FIELDS.length;
      setState(next);
      setFieldIndex(nextIndex);
      setBuffer(tuiTaskFieldValue(next, TUI_TASK_EDITOR_FIELDS[nextIndex] ?? "role"));
      consume(event);
      return;
    }
    if (input.key.upArrow) {
      const nextIndex = (fieldIndex - 1 + TUI_TASK_EDITOR_FIELDS.length) % TUI_TASK_EDITOR_FIELDS.length;
      const next = commit(buffer);
      setState(next);
      setFieldIndex(nextIndex);
      setBuffer(tuiTaskFieldValue(next, TUI_TASK_EDITOR_FIELDS[nextIndex] ?? "role"));
      consume(event);
      return;
    }
    if (input.key.backspace || input.key.delete) {
      setBuffer(current => current.slice(0, -1));
      consume(event);
      return;
    }
    if (!input.key.ctrl && !input.key.meta && input.value !== "") {
      setBuffer(current => current + input.value);
      consume(event);
    }
  });

  return (
    <EditorFrame
      title="创建子 Agent 任务"
      fields={TUI_TASK_EDITOR_FIELDS.map(field => [
        field,
        field === TUI_TASK_EDITOR_FIELDS[fieldIndex] ? buffer : tuiTaskFieldValue(state, field),
      ] as const)}
      footer="Space 切换角色/门禁 · Tab/↓ 下一个字段 · Enter 提交 · Esc 取消"
    />
  );
}

function EditorFrame({
  title,
  fields,
  footer,
}: {
  readonly title: string;
  readonly fields: readonly (readonly [string, string])[];
  readonly footer: string;
}): ReactNode {
  return (
    <box
      position="absolute"
      left="5%"
      top="5%"
      width="90%"
      height="90%"
      zIndex={210}
      flexDirection="column"
      border
      borderStyle="double"
      borderColor="#f4a261"
      backgroundColor="#0d1117"
      padding={2}
    >
      <text fg="#f4a261"><strong>{title}</strong></text>
      <scrollbox flexGrow={1} scrollY viewportCulling>
        {fields.map(([name, value]) => <text key={name}>{name}: {value || "（空）"}</text>)}
      </scrollbox>
      <text fg="#8b949e">{footer}</text>
    </box>
  );
}

function consume(event: { preventDefault(): void; stopPropagation(): void }): void {
  event.preventDefault();
  event.stopPropagation();
}
