import type { AgentRuntime } from "../runtime/agent-runtime.js";
import type { SubagentExecutionResult, SubagentTaskRecord } from "./types.js";

export interface SubagentExecutionContext {
  readonly task: SubagentTaskRecord;
  readonly workspaceId: string;
  readonly signal: AbortSignal;
}

export interface SubagentExecutor {
  execute(context: SubagentExecutionContext): Promise<SubagentExecutionResult>;
}

// AgentRuntime 适配器使用独立会话执行子任务；工具能力仍由 AgentLoop 的运行策略硬限制。
export class AgentRuntimeSubagentExecutor implements SubagentExecutor {
  public constructor(private readonly runtime: AgentRuntime) {}

  public async execute(context: SubagentExecutionContext): Promise<SubagentExecutionResult> {
    const created = await this.runtime.createSession(context.workspaceId, "autoReview");
    const abort = () => this.runtime.abortSession(created.id);
    context.signal.addEventListener("abort", abort, { once: true });
    try {
      const started = await this.runtime.startSession(created.id, buildInstruction(context.task), {
        limits: {
          maxTurns: context.task.budget.maxTurns,
          maxToolCalls: context.task.budget.maxToolCalls,
          maxTotalTokens: context.task.budget.maxTotalTokens,
        },
        allowedCapabilities: context.task.allowedCapabilities,
      });
      const snapshot = await this.runtime.waitForRun(started.runId);
      if (snapshot.status !== "completed") {
        throw new Error(snapshot.lastError?.message ?? `子 Agent 会话未完成：${snapshot.status}`);
      }
      const lastAssistant = [...snapshot.messages].reverse().find(message => message.role === "assistant");
      const summary = lastAssistant?.role === "assistant" ? lastAssistant.content : "";
      return {
        summary,
        childSessionId: snapshot.id,
        usage: {
          inputTokens: snapshot.usage.inputTokens,
          outputTokens: snapshot.usage.outputTokens,
          turns: snapshot.messages.filter(message => message.role === "assistant").length,
          toolCalls: snapshot.messages.filter(message => message.role === "tool").length,
        },
        ...parseVerdict(context.task, summary),
      };
    } finally {
      context.signal.removeEventListener("abort", abort);
    }
  }
}

function buildInstruction(task: SubagentTaskRecord): string {
  const verdictInstruction = task.role === "reviewer" || task.role === "tester"
    ? "\n最终一行必须严格输出 VERDICT: APPROVED 或 VERDICT: REJECTED。"
    : "";
  return [
    `你是 ${task.role} 子 Agent。`,
    `允许路径：${task.allowedPaths.join(", ")}`,
    `可写路径：${task.writablePaths.join(", ") || "无"}`,
    `任务：${task.instruction}`,
    verdictInstruction,
  ].join("\n");
}

function parseVerdict(task: SubagentTaskRecord, summary: string): { readonly verdict?: "approved" | "rejected" } {
  if (task.role !== "reviewer" && task.role !== "tester") {
    return {};
  }
  const finalLine = summary.trim().split(/\r?\n/).at(-1);
  if (finalLine === "VERDICT: APPROVED") {
    return { verdict: "approved" };
  }
  if (finalLine === "VERDICT: REJECTED") {
    return { verdict: "rejected" };
  }
  throw new Error(`${task.role} 没有返回严格 Verdict`);
}
