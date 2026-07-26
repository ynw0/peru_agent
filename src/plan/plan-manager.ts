import type { AgentEvent, Capability, PlanStatus, PlanStep } from "../agent-protocol.js";
import type { EventJournal } from "../agent/event-journal.js";
import type { IdGenerator } from "../agent/id-generator.js";

export interface PlanRecord {
  readonly id: string;
  readonly sessionId: string;
  readonly title: string;
  readonly summary: string;
  readonly confidence: number;
  readonly affectedFiles: readonly string[];
  readonly steps: readonly PlanStep[];
  readonly status: PlanStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly message?: string;
}

export interface CreatePlanInput {
  readonly sessionId: string;
  readonly title: string;
  readonly summary: string;
  readonly confidence: number;
  readonly affectedFiles: readonly string[];
  readonly steps: readonly {
    readonly title: string;
    readonly description: string;
    readonly affectedFiles?: readonly string[];
    readonly capabilities?: readonly Capability[];
  }[];
}

export interface PlanManagerListener {
  (event: AgentEvent): void | Promise<void>;
}

// PlanManager 是计划审核的唯一状态机；UI 不能直接修改 PlanRecord。
export class PlanManager {
  private readonly plans = new Map<string, PlanRecord>();
  private readonly listeners = new Set<PlanManagerListener>();

  public constructor(
    private readonly ids: IdGenerator,
    private readonly journal: EventJournal,
  ) {}

  public onEvent(listener: PlanManagerListener): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  public async create(input: CreatePlanInput): Promise<PlanRecord> {
    validateCreatePlanInput(input);
    const now = new Date().toISOString();
    const planId = this.ids.next("plan");
    const steps: PlanStep[] = input.steps.map((step, index) => ({
      id: `${planId}-step-${index + 1}`,
      title: step.title.trim(),
      description: step.description.trim(),
      affectedFiles: [...new Set(step.affectedFiles ?? [])],
      capabilities: [...new Set(step.capabilities ?? [])],
    }));
    const plan: PlanRecord = {
      id: planId,
      sessionId: input.sessionId,
      title: input.title.trim(),
      summary: input.summary.trim(),
      confidence: input.confidence,
      affectedFiles: [...new Set(input.affectedFiles)],
      steps,
      status: "reviewing",
      createdAt: now,
      updatedAt: now,
    };
    this.plans.set(plan.id, plan);
    await this.publish({
      type: "plan.created",
      sessionId: plan.sessionId,
      planId: plan.id,
      title: plan.title,
      summary: plan.summary,
      confidence: plan.confidence,
      affectedFiles: [...plan.affectedFiles],
      steps: plan.steps.map(step => ({ ...step, affectedFiles: [...step.affectedFiles], capabilities: [...step.capabilities] })),
      status: "reviewing",
      createdAt: plan.createdAt,
    });
    return structuredClone(plan);
  }

  public async resolve(planId: string, decision: "approved" | "rejected"): Promise<PlanRecord> {
    const current = this.require(planId);
    if (current.status !== "reviewing") {
      throw new Error(`Plan 当前状态不能审核：${current.status}`);
    }
    const updated = this.update(current, decision);
    await this.publish({
      type: "plan.resolved",
      sessionId: current.sessionId,
      planId,
      decision,
      updatedAt: updated.updatedAt,
    });
    return updated;
  }

  public async markExecuting(planId: string): Promise<PlanRecord> {
    return this.changeStatus(planId, "executing");
  }

  public async markCompleted(planId: string): Promise<PlanRecord> {
    return this.changeStatus(planId, "completed");
  }

  public async markFailed(planId: string, message: string): Promise<PlanRecord> {
    return this.changeStatus(planId, "failed", message);
  }

  public async cancel(planId: string, message?: string): Promise<PlanRecord> {
    return this.changeStatus(planId, "cancelled", message);
  }

  public get(planId: string): PlanRecord | undefined {
    const plan = this.plans.get(planId);
    return plan === undefined ? undefined : structuredClone(plan);
  }

  public list(sessionId?: string): readonly PlanRecord[] {
    return [...this.plans.values()]
      .filter(plan => sessionId === undefined || plan.sessionId === sessionId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map(plan => structuredClone(plan));
  }

  // 进程重启后从 EventJournal 恢复 Plan 状态，避免 UI 与运行时各自保存一份事实。
  public restoreFromEvents(events: readonly AgentEvent[]): readonly PlanRecord[] {
    this.plans.clear();
    for (const event of events) {
      if (event.type === "plan.created") {
        this.plans.set(event.planId, {
          id: event.planId,
          sessionId: event.sessionId,
          title: event.title,
          summary: event.summary,
          confidence: event.confidence,
          affectedFiles: [...event.affectedFiles],
          steps: event.steps.map(step => ({ ...step, affectedFiles: [...step.affectedFiles], capabilities: [...step.capabilities] })),
          status: "reviewing",
          createdAt: event.createdAt,
          updatedAt: event.createdAt,
        });
      } else if (event.type === "plan.resolved") {
        const plan = this.plans.get(event.planId);
        if (plan !== undefined) {
          this.plans.set(event.planId, { ...plan, status: event.decision, updatedAt: event.updatedAt });
        }
      } else if (event.type === "plan.status.changed") {
        const plan = this.plans.get(event.planId);
        if (plan !== undefined) {
          this.plans.set(event.planId, {
            ...plan,
            status: event.status,
            updatedAt: event.updatedAt,
            ...(event.message === undefined ? {} : { message: event.message }),
          });
        }
      }
    }
    return this.list();
  }

  private async changeStatus(
    planId: string,
    status: Exclude<PlanStatus, "reviewing" | "approved" | "rejected">,
    message?: string,
  ): Promise<PlanRecord> {
    const current = this.require(planId);
    validatePlanTransition(current.status, status);
    const updated = this.update(current, status, message);
    await this.publish({
      type: "plan.status.changed",
      sessionId: current.sessionId,
      planId,
      status,
      updatedAt: updated.updatedAt,
      ...(message === undefined ? {} : { message }),
    });
    return updated;
  }

  private require(planId: string): PlanRecord {
    const plan = this.plans.get(planId);
    if (plan === undefined) {
      throw new Error(`Plan 不存在：${planId}`);
    }
    return plan;
  }

  private update(plan: PlanRecord, status: PlanStatus, message?: string): PlanRecord {
    const updated: PlanRecord = {
      ...plan,
      status,
      updatedAt: new Date().toISOString(),
      ...(message === undefined ? {} : { message }),
    };
    this.plans.set(plan.id, updated);
    return structuredClone(updated);
  }

  private async publish(event: AgentEvent): Promise<void> {
    await this.journal.append(event);
    for (const listener of this.listeners) {
      await listener(event);
    }
  }
}

function validateCreatePlanInput(input: CreatePlanInput): void {
  if (input.sessionId.trim() === "" || input.title.trim() === "" || input.summary.trim() === "") {
    throw new Error("Plan 的 sessionId、title 和 summary 不能为空");
  }
  if (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 100) {
    throw new Error("Plan 置信度必须在 0~100 之间");
  }
  if (input.steps.length === 0) {
    throw new Error("Plan 至少需要一个步骤");
  }
  for (const step of input.steps) {
    if (step.title.trim() === "" || step.description.trim() === "") {
      throw new Error("Plan 步骤标题和说明不能为空");
    }
  }
}

function validatePlanTransition(from: PlanStatus, to: PlanStatus): void {
  const allowed: Readonly<Record<PlanStatus, readonly PlanStatus[]>> = {
    reviewing: ["cancelled"],
    approved: ["executing", "cancelled"],
    rejected: [],
    executing: ["completed", "failed", "cancelled"],
    completed: [],
    failed: [],
    cancelled: [],
  };
  if (!allowed[from].includes(to)) {
    throw new Error(`Plan 状态不能从 ${from} 变为 ${to}`);
  }
}
