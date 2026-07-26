import type { AgentRuntime } from "./agent-runtime.js";
import type { WorkspaceRuntime } from "./workspace-runtime.js";
import type { PlanManager } from "../plan/plan-manager.js";
import type { WorkbenchRuntime } from "./workbench-runtime.js";

// WorkbenchEventConnector 统一把三个领域 Runtime 的事件送入同一 UI 投影器。
export class WorkbenchEventConnector {
  private readonly disposables: { dispose(): void }[] = [];

  public constructor(
    private readonly agent: AgentRuntime,
    private readonly workspace: WorkspaceRuntime,
    private readonly plans: PlanManager,
    private readonly workbench: WorkbenchRuntime,
  ) {}

  public start(): void {
    this.disposables.push(
      this.agent.onEvent(async event => { await this.workbench.handleEvent(event); }),
      this.workspace.onEvent(async event => { await this.workbench.handleEvent(event); }),
      this.plans.onEvent(async event => { await this.workbench.handleEvent(event); }),
    );
  }

  public dispose(): void {
    for (const disposable of this.disposables.splice(0)) {
      disposable.dispose();
    }
  }
}
