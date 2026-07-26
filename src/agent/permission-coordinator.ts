import type { AgentEvent, Capability } from "../agent-protocol.js";
import { decidePermission } from "../permission-engine.js";
import type { ToolManifest, ToolInspection } from "../tool-runtime.js";
import { AgentError } from "./errors.js";
import type { IdGenerator } from "./id-generator.js";
import type { AgentSession } from "./session.js";

export type AgentEventEmitter = (event: AgentEvent) => Promise<void>;

interface PendingPermission {
  readonly sessionId: string;
  readonly resolve: (decision: "allow" | "deny") => void;
  readonly reject: (error: Error) => void;
  readonly abortCleanup: () => void;
}

// PermissionCoordinator 负责把规则判断和用户交互连接起来。
export class PermissionCoordinator {
  private readonly pending = new Map<string, PendingPermission>();

  public constructor(private readonly idGenerator: IdGenerator) {}

  public async authorize(
    session: AgentSession,
    manifest: ToolManifest,
    inspection: ToolInspection,
    emit: AgentEventEmitter,
    signal: AbortSignal,
  ): Promise<"allow" | "deny"> {
    const decisions = manifest.capabilities.map(capability => ({
      capability,
      decision: decidePermission(
        session.permissionMode,
        capability,
        inspection.certifiedComputerApplication,
      ),
    }));

    if (decisions.some(item => item.decision === "deny")) {
      return "deny";
    }

    const askedCapabilities = decisions
      .filter(item => item.decision === "ask")
      .map(item => item.capability);
    if (askedCapabilities.length === 0) {
      return "allow";
    }

    return this.waitForUserDecision(session, askedCapabilities, emit, signal);
  }

  public resolve(requestId: string, decision: "allow" | "deny"): boolean {
    const pending = this.pending.get(requestId);
    if (pending === undefined) {
      return false;
    }
    this.pending.delete(requestId);
    pending.abortCleanup();
    pending.resolve(decision);
    return true;
  }

  public rejectSession(sessionId: string): void {
    for (const [requestId, pending] of this.pending) {
      if (pending.sessionId !== sessionId) {
        continue;
      }
      this.pending.delete(requestId);
      pending.abortCleanup();
      pending.reject(new AgentError("RUN_ABORTED", "权限请求所属运行已终止"));
    }
  }

  private async waitForUserDecision(
    session: AgentSession,
    capabilities: readonly Capability[],
    emit: AgentEventEmitter,
    signal: AbortSignal,
  ): Promise<"allow" | "deny"> {
    if (signal.aborted) {
      throw new AgentError("RUN_ABORTED", "运行已取消");
    }

    const requestId = this.idGenerator.next("permission");
    session.setAwaitingPermission();
    const decisionPromise = new Promise<"allow" | "deny">((resolve, reject) => {
      const abortListener = (): void => {
        this.pending.delete(requestId);
        reject(new AgentError("RUN_ABORTED", "等待权限期间运行被取消"));
      };
      signal.addEventListener("abort", abortListener, { once: true });
      this.pending.set(requestId, {
        sessionId: session.id,
        resolve,
        reject,
        abortCleanup: () => signal.removeEventListener("abort", abortListener),
      });
    });

    // 先登记 pending，再发事件，避免 UI 立即批准时找不到请求。
    try {
      await emit({
        type: "permission.requested",
        sessionId: session.id,
        requestId,
        capabilities: [...capabilities],
      });
    } catch (error: unknown) {
      const pending = this.pending.get(requestId);
      this.pending.delete(requestId);
      pending?.abortCleanup();
      throw error;
    }
    const decision = await decisionPromise;

    session.resumeFromPermission();
    await emit({
      type: "permission.resolved",
      sessionId: session.id,
      requestId,
      decision,
    });
    return decision;
  }
}
