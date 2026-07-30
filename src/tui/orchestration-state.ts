import type { SubagentReviewPolicy, SubagentRole } from "../subagent/types.js";

export interface TuiPlanEditorState {
  readonly title: string;
  readonly summary: string;
  readonly confidence: number;
  readonly affectedPaths: readonly string[];
  readonly steps: readonly { readonly title: string; readonly description: string; readonly affectedPaths: readonly string[]; readonly capabilities?: readonly string[] }[];
}

export interface TuiTaskEditorState {
  readonly role: SubagentRole;
  readonly instruction: string;
  readonly allowedPaths: readonly string[];
  readonly reviewPolicy: SubagentReviewPolicy;
  readonly planId?: string;
  readonly planStepId?: string;
}
