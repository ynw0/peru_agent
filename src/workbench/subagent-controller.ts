import type { TypedIpcClient } from "../ipc/channel.js";
import type { SubagentTaskRecord, SubagentTaskRequest } from "../subagent/types.js";

// Workbench 只能通过 Typed IPC 控制子 Agent，不持有 Executor、Workspace 或 Tool 引用。
export class SubagentController {
  public constructor(
    private readonly client: TypedIpcClient,
    private readonly timeoutMs = 10_000,
  ) {}

  public dispatch(request: SubagentTaskRequest): Promise<SubagentTaskRecord> {
    return this.client.request("subagent.dispatch", request, { timeoutMs: this.timeoutMs });
  }

  public async start(taskId: string): Promise<void> {
    await this.client.request("subagent.start", { taskId }, { timeoutMs: this.timeoutMs });
  }

  public async abort(taskId: string): Promise<boolean> {
    return (await this.client.request("subagent.abort", { taskId }, {
      timeoutMs: this.timeoutMs,
    })).aborted;
  }

  public get(taskId: string): Promise<SubagentTaskRecord> {
    return this.client.request("subagent.get", { taskId }, { timeoutMs: this.timeoutMs });
  }

  public async list(parentSessionId?: string): Promise<readonly SubagentTaskRecord[]> {
    return (await this.client.request("subagent.list", {
      ...(parentSessionId === undefined ? {} : { parentSessionId }),
    }, { timeoutMs: this.timeoutMs })).tasks;
  }

  public proposeMerge(taskId: string, gateTaskIds: readonly string[]): Promise<SubagentTaskRecord> {
    return this.client.request("subagent.proposeMerge", { taskId, gateTaskIds }, {
      timeoutMs: this.timeoutMs,
    });
  }

  public finalizeMerge(taskId: string): Promise<SubagentTaskRecord> {
    return this.client.request("subagent.finalizeMerge", { taskId }, {
      timeoutMs: this.timeoutMs,
    });
  }
}
