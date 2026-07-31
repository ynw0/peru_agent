import { useState, type ReactElement } from "react";
import { Box, Text, useInput } from "ink";
import type { Capability } from "../agent-protocol.js";
import type { SubagentReviewPolicy, SubagentRole } from "../subagent/types.js";
import type { CreatePlanInput } from "../plan/plan-manager.js";
import type { TuiPlanEditorState, TuiTaskEditorState } from "./orchestration-state.js";

const PLAN_FIELDS = ["title", "summary", "confidence", "affectedFiles", "stepTitle", "stepDescription", "stepFiles", "stepCapabilities"] as const;
const TASK_FIELDS = ["role", "instruction", "allowedPaths", "planId", "planStepId", "reviewPolicy"] as const;

export function TuiPlanEditor({ instruction, onSubmit, onCancel }: { readonly instruction?: string; readonly onSubmit: (input: Omit<CreatePlanInput, "sessionId">) => Promise<void>; readonly onCancel: () => void }): ReactElement {
  const [state, setState] = useState<TuiPlanEditorState>({ title: instruction?.slice(0, 80) ?? "", summary: instruction ?? "", confidence: 80, affectedPaths: ["."], steps: [{ title: "执行计划", description: instruction ?? "", affectedPaths: ["."], capabilities: ["workspace.read"] }] });
  const [fieldIndex, setFieldIndex] = useState(0);
  const [stepIndex, setStepIndex] = useState(0);
  const [buffer, setBuffer] = useState(() => planFieldValue(state, PLAN_FIELDS[0], 0));
  const commit = (value: string): TuiPlanEditorState => updatePlanField(state, PLAN_FIELDS[fieldIndex] ?? "title", value, stepIndex);
  useInput((value, key) => {
    if (key.escape) { onCancel(); return; }
    if (key.ctrl && value.toLocaleLowerCase() === "n") { const next = { ...state, steps: [...state.steps, { title: "", description: "", affectedPaths: ["."], capabilities: ["workspace.read"] }] }; setState(next); setStepIndex(next.steps.length - 1); setFieldIndex(4); setBuffer(""); return; }
    if (key.ctrl && value.toLocaleLowerCase() === "w" && state.steps.length > 1) { const next = { ...state, steps: state.steps.filter((_, index) => index !== stepIndex) }; setState(next); setStepIndex(Math.min(stepIndex, next.steps.length - 1)); return; }
    if (key.ctrl && key.upArrow) { setStepIndex(current => Math.max(0, current - 1)); return; }
    if (key.ctrl && key.downArrow) { setStepIndex(current => Math.min(state.steps.length - 1, current + 1)); return; }
    if (key.tab || key.downArrow || key.return) {
      const next = commit(buffer);
      if (key.return && fieldIndex === PLAN_FIELDS.length - 1) {
        void onSubmit({ title: next.title, summary: next.summary, confidence: next.confidence, affectedFiles: [...next.affectedPaths], steps: next.steps.map(step => ({ title: step.title, description: step.description, affectedFiles: [...step.affectedPaths], capabilities: (step.capabilities ?? ["workspace.read"]) as Capability[] })) });
        return;
      }
      setState(next); setFieldIndex(index => (index + 1) % PLAN_FIELDS.length); setBuffer(planFieldValue(next, PLAN_FIELDS[(fieldIndex + 1) % PLAN_FIELDS.length] ?? "title", stepIndex)); return;
    }
    if (key.upArrow) { const nextIndex = (fieldIndex - 1 + PLAN_FIELDS.length) % PLAN_FIELDS.length; const next = commit(buffer); setState(next); setFieldIndex(nextIndex); setBuffer(planFieldValue(next, PLAN_FIELDS[nextIndex] ?? "title", stepIndex)); return; }
    if (key.backspace || key.delete) { setBuffer(current => key.delete ? current.slice(0, -1) : current.slice(0, -1)); return; }
    if (!key.ctrl && !key.meta && value !== "") setBuffer(current => current + value);
  });
  return <EditorFrame title={`创建 Plan · Step ${stepIndex + 1}/${state.steps.length}`} fields={PLAN_FIELDS.map(field => [field, field === PLAN_FIELDS[fieldIndex] ? buffer : planFieldValue(state, field, stepIndex)] as const)} footer="Tab/↓ 下一个字段 · Ctrl+N 新增步骤 · Ctrl+W 删除步骤 · Ctrl+↑/↓ 切换步骤 · Enter 提交 · Esc 取消" />;
}

export function TuiTaskEditor({ instruction, onSubmit, onCancel }: { readonly instruction?: string; readonly onSubmit: (input: Omit<SubagentTaskRequestForEditor, "parentSessionId" | "baseWorkspaceId">) => Promise<void>; readonly onCancel: () => void }): ReactElement {
  const initial: TuiTaskEditorState = { role: "explorer", instruction: instruction ?? "", allowedPaths: ["."], reviewPolicy: "reviewerAndTester" };
  const [state, setState] = useState<TuiTaskEditorState>(initial);
  const [fieldIndex, setFieldIndex] = useState(0);
  const [buffer, setBuffer] = useState(() => fieldValue(state, TASK_FIELDS[0]));
  const commit = (value: string): TuiTaskEditorState => updateTaskField(state, TASK_FIELDS[fieldIndex] ?? "instruction", value);
  useInput((value, key) => {
    if (key.escape) { onCancel(); return; }
    if (value === " " && (TASK_FIELDS[fieldIndex] === "role" || TASK_FIELDS[fieldIndex] === "reviewPolicy")) { const next = toggleTaskEnum(state, TASK_FIELDS[fieldIndex] ?? "role"); setState(next); setBuffer(fieldValue(next, TASK_FIELDS[fieldIndex] ?? "role")); return; }
    if (key.tab || key.downArrow || key.return) {
      const next = commit(buffer);
      if (key.return && fieldIndex === TASK_FIELDS.length - 1) {
        void onSubmit({ role: next.role, instruction: next.instruction, depth: 1, allowedPaths: [...next.allowedPaths], writablePaths: next.role === "implementer" ? [...next.allowedPaths] : [], allowedCapabilities: next.role === "implementer" ? ["workspace.read", "workspace.propose", "workspace.write"] : ["workspace.read"], budget: next.role === "implementer" ? { maxTurns: 24, maxToolCalls: 48, maxTotalTokens: 80_000, maxDurationMs: 20 * 60_000 } : { maxTurns: 12, maxToolCalls: 24, maxTotalTokens: 40_000, maxDurationMs: 10 * 60_000 }, reviewPolicy: next.reviewPolicy, ...(next.planId === undefined || next.planId === "" ? {} : { planId: next.planId }), ...(next.planStepId === undefined || next.planStepId === "" ? {} : { planStepId: next.planStepId }) }); return;
      }
      setState(next); setFieldIndex(index => (index + 1) % TASK_FIELDS.length); setBuffer(fieldValue(next, TASK_FIELDS[(fieldIndex + 1) % TASK_FIELDS.length] ?? "role")); return;
    }
    if (key.upArrow) { const nextIndex = (fieldIndex - 1 + TASK_FIELDS.length) % TASK_FIELDS.length; setState(commit(buffer)); setFieldIndex(nextIndex); setBuffer(fieldValue(state, TASK_FIELDS[nextIndex] ?? "role")); return; }
    if (key.backspace || key.delete) { setBuffer(current => current.slice(0, -1)); return; }
    if (!key.ctrl && !key.meta && value !== "") setBuffer(current => current + value);
  });
  return <EditorFrame title="创建子 Agent 任务" fields={TASK_FIELDS.map(field => [field, field === TASK_FIELDS[fieldIndex] ? buffer : fieldValue(state, field)] as const)} footer="Space 切换角色/门禁 · Tab/↓ 下一个字段 · Enter 提交 · Esc 取消" />;
}

type SubagentTaskRequestForEditor = { readonly role: SubagentRole; readonly instruction: string; readonly depth: number; readonly allowedPaths: readonly string[]; readonly writablePaths: readonly string[]; readonly allowedCapabilities: readonly Capability[]; readonly budget: { readonly maxTurns: number; readonly maxToolCalls: number; readonly maxTotalTokens: number; readonly maxDurationMs: number }; readonly reviewPolicy: SubagentReviewPolicy; readonly planId?: string; readonly planStepId?: string };

function EditorFrame({ title, fields, footer }: { readonly title: string; readonly fields: readonly (readonly [string, string])[]; readonly footer: string }): ReactElement { return <Box paddingX={2} paddingY={1} flexDirection="column" borderStyle="single" borderColor="gray" backgroundColor="black" width="90%" overflow="hidden"><Text bold color="#f4a261">{title}</Text>{fields.map(([name, value]) => <Text key={name}>{name}: {value || "（空）"}</Text>)}<Text dimColor>{footer}</Text></Box>; }
function fieldValue(value: TuiPlanEditorState | TuiTaskEditorState, field: string): string { const item = value as unknown as Record<string, unknown>; const raw = item[field]; if (Array.isArray(raw)) return raw.join(","); return raw === undefined ? "" : String(raw); }
function planFieldValue(state: TuiPlanEditorState, field: string, stepIndex: number): string { if (field.startsWith("step")) { const step = state.steps[stepIndex] ?? state.steps[0]; if (step === undefined) return ""; if (field === "stepTitle") return step.title; if (field === "stepDescription") return step.description; if (field === "stepFiles") return step.affectedPaths.join(","); if (field === "stepCapabilities") return (step.capabilities ?? []).join(","); } return fieldValue(state, field); }
function updatePlanField(state: TuiPlanEditorState, field: string, value: string, stepIndex: number): TuiPlanEditorState { const next = { ...state }; if (field === "confidence") return { ...next, confidence: Number(value) || 0 }; if (field === "affectedFiles") return { ...next, affectedPaths: split(value) }; const steps = [...next.steps]; const step = steps[stepIndex] ?? { title: "", description: "", affectedPaths: ["."], capabilities: ["workspace.read"] }; if (field === "stepTitle") steps[stepIndex] = { ...step, title: value }; if (field === "stepDescription") steps[stepIndex] = { ...step, description: value }; if (field === "stepFiles") steps[stepIndex] = { ...step, affectedPaths: split(value) }; if (field === "stepCapabilities") steps[stepIndex] = { ...step, capabilities: split(value) }; return field.startsWith("step") ? { ...next, steps } : { ...next, [field]: value } as TuiPlanEditorState; }
function updateTaskField(state: TuiTaskEditorState, field: string, value: string): TuiTaskEditorState { if (field === "allowedPaths") return { ...state, allowedPaths: split(value) }; return { ...state, [field]: value } as TuiTaskEditorState; }
function toggleTaskEnum(state: TuiTaskEditorState, field: string): TuiTaskEditorState { if (field === "role") { const roles: readonly SubagentRole[] = ["planner", "explorer", "implementer"]; return { ...state, role: roles[(roles.indexOf(state.role) + 1) % roles.length] ?? "explorer" }; } const policies: readonly SubagentReviewPolicy[] = ["none", "reviewer", "reviewerAndTester"]; return { ...state, reviewPolicy: policies[(policies.indexOf(state.reviewPolicy) + 1) % policies.length] ?? "reviewerAndTester" }; }
function split(value: string): readonly string[] { return value.split(",").map(item => item.trim()).filter(Boolean); }
