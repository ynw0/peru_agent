import type { AgentRuntime } from "../runtime/agent-runtime.js";
import type { SubagentExecutionResult, SubagentTaskRecord } from "./types.js";
import type { GateReportStore } from "../orchestration/gate-report-store.js";

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
  public constructor(private readonly runtime: AgentRuntime, private readonly gateReports?: GateReportStore) {}

  public async execute(context: SubagentExecutionContext): Promise<SubagentExecutionResult> {
    const created = await this.runtime.createSession(context.workspaceId, "fullAccess");
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
        allowedToolNames: roleToolNames(context.task.role),
        workspaceWriteMode: "isolatedAutoApply",
      });
      const snapshot = await this.runtime.waitForRun(started.runId);
      if (snapshot.status !== "completed") {
        throw new Error(snapshot.lastError?.message ?? `子 Agent 会话未完成：${snapshot.status}`);
      }
      const lastAssistant = [...snapshot.messages].reverse().find(message => message.role === "assistant");
      const summary = lastAssistant?.role === "assistant" ? lastAssistant.content : "";
      const gateReport = this.gateReports?.get(snapshot.id);
      if ((context.task.role === "reviewer" || context.task.role === "tester") && gateReport === undefined) {
        throw new Error(`${context.task.role} 未提交有效 GateReport`);
      }
      return {
        summary,
        childSessionId: snapshot.id,
        usage: {
          inputTokens: snapshot.usage.inputTokens,
          outputTokens: snapshot.usage.outputTokens,
          turns: snapshot.messages.filter(message => message.role === "assistant").length,
          toolCalls: snapshot.messages.filter(message => message.role === "tool").length,
        },
        ...(gateReport === undefined ? {} : { gateReport }),
        ...(gateReport === undefined ? {} : { verdict: gateReport.verdict }),
      };
    } finally {
      context.signal.removeEventListener("abort", abort);
    }
  }
}

export class DeferredAgentRuntimeSubagentExecutor implements SubagentExecutor {
  private runtime: AgentRuntime | undefined;
  public constructor(private readonly gateReports?: GateReportStore) {}
  public bind(runtime: AgentRuntime): void { this.runtime = runtime; }
  public execute(context: SubagentExecutionContext): Promise<SubagentExecutionResult> {
    if (this.runtime === undefined) throw new Error("子 Agent 执行器尚未绑定 AgentRuntime");
    return new AgentRuntimeSubagentExecutor(this.runtime, this.gateReports).execute(context);
  }
}

function roleToolNames(role: SubagentTaskRecord["role"]): readonly string[] {
  const read = ["Read", "Glob", "Grep"];
  if (role === "implementer") return [...read, "Write", "Edit", "ApplyPatch", "FileDiff"];
  if (role === "reviewer") return [...read, "FileDiff", "GateReport"];
  if (role === "tester") return [...read, "PowerShell", "GateReport"];
  return read;
}

function buildInstruction(task: SubagentTaskRecord): string {
  const verdictInstruction = task.role === "reviewer" || task.role === "tester"
    ? "\n必须调用 GateReport Tool 提交结构化结论；不得通过自然语言替代。"
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
  void summary;
  return {};
}
