import type { Capability } from "../agent-protocol.js";
import type { CreatePlanInput } from "../plan/plan-manager.js";
import type { SubagentReviewPolicy, SubagentRole, SubagentTaskRequest } from "../subagent/types.js";

export const TUI_PLAN_EDITOR_FIELDS = [
  "title",
  "summary",
  "confidence",
  "affectedFiles",
  "stepTitle",
  "stepDescription",
  "stepFiles",
  "stepCapabilities",
] as const;
export type TuiPlanEditorField = typeof TUI_PLAN_EDITOR_FIELDS[number];

export const TUI_TASK_EDITOR_FIELDS = [
  "role",
  "instruction",
  "allowedPaths",
  "planId",
  "planStepId",
  "reviewPolicy",
] as const;
export type TuiTaskEditorField = typeof TUI_TASK_EDITOR_FIELDS[number];

export interface TuiPlanEditorState {
  readonly title: string;
  readonly summary: string;
  readonly confidence: number;
  readonly affectedPaths: readonly string[];
  readonly steps: readonly {
    readonly title: string;
    readonly description: string;
    readonly affectedPaths: readonly string[];
    readonly capabilities?: readonly string[];
  }[];
}

export interface TuiTaskEditorState {
  readonly role: SubagentRole;
  readonly instruction: string;
  readonly allowedPaths: readonly string[];
  readonly reviewPolicy: SubagentReviewPolicy;
  readonly planId?: string;
  readonly planStepId?: string;
}

export function createTuiPlanEditorState(instruction?: string): TuiPlanEditorState {
  return {
    title: instruction?.slice(0, 80) ?? "",
    summary: instruction ?? "",
    confidence: 80,
    affectedPaths: ["."],
    steps: [{
      title: "执行计划",
      description: instruction ?? "",
      affectedPaths: ["."],
      capabilities: ["workspace.read"],
    }],
  };
}

export function createTuiTaskEditorState(instruction?: string): TuiTaskEditorState {
  return {
    role: "explorer",
    instruction: instruction ?? "",
    allowedPaths: ["."],
    reviewPolicy: "reviewerAndTester",
  };
}

export function tuiPlanFieldValue(state: TuiPlanEditorState, field: TuiPlanEditorField, stepIndex: number): string {
  if (field.startsWith("step")) {
    const step = state.steps[stepIndex] ?? state.steps[0];
    if (step === undefined) return "";
    if (field === "stepTitle") return step.title;
    if (field === "stepDescription") return step.description;
    if (field === "stepFiles") return step.affectedPaths.join(",");
    if (field === "stepCapabilities") return (step.capabilities ?? []).join(",");
  }
  return tuiEditorFieldValue(state, field);
}

export function updateTuiPlanField(
  state: TuiPlanEditorState,
  field: TuiPlanEditorField,
  value: string,
  stepIndex: number,
): TuiPlanEditorState {
  if (field === "confidence") return { ...state, confidence: Number(value) || 0 };
  if (field === "affectedFiles") return { ...state, affectedPaths: splitEditorList(value) };
  const steps = [...state.steps];
  const step = steps[stepIndex] ?? { title: "", description: "", affectedPaths: ["."], capabilities: ["workspace.read"] };
  if (field === "stepTitle") steps[stepIndex] = { ...step, title: value };
  if (field === "stepDescription") steps[stepIndex] = { ...step, description: value };
  if (field === "stepFiles") steps[stepIndex] = { ...step, affectedPaths: splitEditorList(value) };
  if (field === "stepCapabilities") steps[stepIndex] = { ...step, capabilities: splitEditorList(value) };
  if (field.startsWith("step")) return { ...state, steps };
  return { ...state, [field]: value } as TuiPlanEditorState;
}

export function addTuiPlanStep(state: TuiPlanEditorState): TuiPlanEditorState {
  return {
    ...state,
    steps: [...state.steps, { title: "", description: "", affectedPaths: ["."], capabilities: ["workspace.read"] }],
  };
}

export function removeTuiPlanStep(state: TuiPlanEditorState, stepIndex: number): TuiPlanEditorState {
  if (state.steps.length <= 1) return state;
  return { ...state, steps: state.steps.filter((_, index) => index !== stepIndex) };
}

export function buildTuiPlanEditorSubmission(state: TuiPlanEditorState): Omit<CreatePlanInput, "sessionId"> {
  return {
    title: state.title,
    summary: state.summary,
    confidence: state.confidence,
    affectedFiles: [...state.affectedPaths],
    steps: state.steps.map(step => ({
      title: step.title,
      description: step.description,
      affectedFiles: [...step.affectedPaths],
      capabilities: (step.capabilities ?? ["workspace.read"]) as Capability[],
    })),
  };
}

export function tuiTaskFieldValue(state: TuiTaskEditorState, field: TuiTaskEditorField): string {
  return tuiEditorFieldValue(state, field);
}

export function updateTuiTaskField(state: TuiTaskEditorState, field: TuiTaskEditorField, value: string): TuiTaskEditorState {
  if (field === "allowedPaths") return { ...state, allowedPaths: splitEditorList(value) };
  return { ...state, [field]: value } as TuiTaskEditorState;
}

export function toggleTuiTaskEnum(state: TuiTaskEditorState, field: "role" | "reviewPolicy"): TuiTaskEditorState {
  if (field === "role") {
    const roles: readonly SubagentRole[] = ["planner", "explorer", "implementer"];
    return { ...state, role: roles[(roles.indexOf(state.role) + 1) % roles.length] ?? "explorer" };
  }
  const policies: readonly SubagentReviewPolicy[] = ["none", "reviewer", "reviewerAndTester"];
  return {
    ...state,
    reviewPolicy: policies[(policies.indexOf(state.reviewPolicy) + 1) % policies.length] ?? "reviewerAndTester",
  };
}

export function buildTuiTaskEditorSubmission(
  state: TuiTaskEditorState,
): Omit<SubagentTaskRequest, "parentSessionId" | "baseWorkspaceId"> {
  const implementer = state.role === "implementer";
  return {
    role: state.role,
    instruction: state.instruction,
    depth: 1,
    allowedPaths: [...state.allowedPaths],
    writablePaths: implementer ? [...state.allowedPaths] : [],
    allowedCapabilities: implementer
      ? ["workspace.read", "workspace.propose", "workspace.write"]
      : ["workspace.read"],
    budget: implementer
      ? { maxTurns: 24, maxToolCalls: 48, maxTotalTokens: 80_000, maxDurationMs: 20 * 60_000 }
      : { maxTurns: 12, maxToolCalls: 24, maxTotalTokens: 40_000, maxDurationMs: 10 * 60_000 },
    reviewPolicy: state.reviewPolicy,
    ...(state.planId === undefined || state.planId === "" ? {} : { planId: state.planId }),
    ...(state.planStepId === undefined || state.planStepId === "" ? {} : { planStepId: state.planStepId }),
  };
}

function tuiEditorFieldValue(value: TuiPlanEditorState | TuiTaskEditorState, field: string): string {
  const item = value as unknown as Record<string, unknown>;
  const raw = item[field];
  if (Array.isArray(raw)) return raw.join(",");
  return raw === undefined ? "" : String(raw);
}

function splitEditorList(value: string): readonly string[] {
  return value.split(",").map(item => item.trim()).filter(Boolean);
}
