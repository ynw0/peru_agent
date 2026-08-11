import type { AgentEvent } from "../agent-protocol.js";
import { decidePermission } from "../permission-engine.js";
import {
  evaluatePermission,
  type PermissionReply,
  type PermissionRule,
  type ToolPermissionRequest,
} from "../permission-rules.js";
import type { ToolManifest, ToolInspection } from "../tool-runtime.js";
import { AgentError } from "./errors.js";
import type { IdGenerator } from "./id-generator.js";
import type { AgentSession } from "./session.js";

export type AgentEventEmitter = (event: AgentEvent) => Promise<void>;

interface PendingPermission {
  readonly sessionId: string;
  readonly session: AgentSession;
  readonly requestId: string;
  readonly request: ToolPermissionRequest;
  readonly resolve: (reply: PermissionReply) => void;
  readonly reject: (error: Error) => void;
  readonly abortCleanup: () => void;
}

/**
 * 权限状态机采用 OpenCode 的 ask / once / always / reject 语义。
 * 规则求值和 pending 自动收敛逻辑改编自 anomalyco/opencode（MIT）。
 * Peru Agent 额外保留 Capability / Sandbox 硬安全门禁，用户批准不能覆盖硬 deny。
 */
export class PermissionCoordinator {
  private readonly pending = new Map<string, PendingPermission>();

  public constructor(private readonly idGenerator: IdGenerator) {}

  public async authorize(
    session: AgentSession,
    toolCallId: string,
    manifest: ToolManifest,
    inspection: ToolInspection,
    requests: readonly ToolPermissionRequest[],
    emit: AgentEventEmitter,
    signal: AbortSignal,
  ): Promise<"allow" | "deny"> {
    const capabilities = [...new Set([
      ...manifest.capabilities,
      ...(inspection.requestedCapabilities ?? []),
    ])];
    const decisions = capabilities.map(capability => decidePermission(
      session.permissionMode,
      capability,
      inspection.certifiedComputerApplication,
    ));
    if (decisions.includes("deny")) return "deny";
    if (decisions.includes("ask") && requests.length === 0) {
      throw new Error(`Tool ${manifest.name} 请求高权限能力，但没有声明 OpenCode-style permission request`);
    }

    const ruleset = rulesForMode(session.permissionMode);
    for (const request of requests) {
      const decision = await this.ask(
        session,
        toolCallId,
        manifest,
        inspection,
        request,
        ruleset,
        decisions.includes("ask"),
        emit,
        signal,
      );
      if (decision === "deny") return "deny";
    }
    return "allow";
  }

  public reply(requestId: string, reply: PermissionReply): boolean {
    const pending = this.pending.get(requestId);
    if (pending === undefined) return false;

    const resolvePending = (id: string, item: PendingPermission, resolved: PermissionReply): void => {
      this.pending.delete(id);
      item.abortCleanup();
      item.resolve(resolved);
    };

    if (reply === "reject") {
      for (const [id, item] of [...this.pending]) {
        if (item.sessionId !== pending.sessionId) continue;
        resolvePending(id, item, "reject");
      }
      return true;
    }

    if (reply === "once") {
      resolvePending(requestId, pending, "once");
      return true;
    }

    const approvedRules = pending.request.always.map(pattern => ({
      permission: pending.request.permission,
      pattern,
      action: "allow" as const,
    }));
    pending.session.addPermissionRules(approvedRules);
    resolvePending(requestId, pending, "always");

    for (const [id, item] of [...this.pending]) {
      if (item.sessionId !== pending.sessionId) continue;
      const sessionRules = item.session.getPermissionRules();
      const allowed = item.request.patterns.every(pattern =>
        evaluatePermission(item.request.permission, pattern, sessionRules).action === "allow");
      if (allowed) resolvePending(id, item, "always");
    }
    return true;
  }

  public rejectSession(sessionId: string): void {
    for (const [requestId, pending] of [...this.pending]) {
      if (pending.sessionId !== sessionId) continue;
      this.pending.delete(requestId);
      pending.abortCleanup();
      pending.reject(new AgentError("RUN_ABORTED", "权限请求所属运行已终止"));
    }
  }


  public listPending(): readonly ToolPermissionRequest[] {
    return [...this.pending.values()].map(item => ({
      permission: item.request.permission,
      patterns: [...item.request.patterns],
      always: [...item.request.always],
      metadata: structuredClone(item.request.metadata),
    }));
  }

  private async ask(
    session: AgentSession,
    toolCallId: string,
    manifest: ToolManifest,
    inspection: ToolInspection,
    request: ToolPermissionRequest,
    ruleset: readonly PermissionRule[],
    forceCapabilityAsk: boolean,
    emit: AgentEventEmitter,
    signal: AbortSignal,
  ): Promise<"allow" | "deny"> {
    let needsAsk = false;
    for (const pattern of request.patterns) {
      const sessionRules = session.getPermissionRules();
      const rule = evaluatePermission(request.permission, pattern, ruleset, sessionRules);
      if (rule.action === "deny") return "deny";
      const approved = evaluatePermission(request.permission, pattern, sessionRules).action === "allow";
      if (rule.action === "ask" || (forceCapabilityAsk && !approved)) needsAsk = true;
    }
    if (!needsAsk) return "allow";
    if (signal.aborted) throw new AgentError("RUN_ABORTED", "运行已取消");

    const requestId = this.idGenerator.next("permission");
    session.setAwaitingPermission();
    const decision = new Promise<PermissionReply>((resolve, reject) => {
      const abortListener = (): void => {
        this.pending.delete(requestId);
        reject(new AgentError("RUN_ABORTED", "等待权限期间运行被取消"));
      };
      signal.addEventListener("abort", abortListener, { once: true });
      this.pending.set(requestId, {
        sessionId: session.id,
        session,
        requestId,
        request,
        resolve,
        reject,
        abortCleanup: () => signal.removeEventListener("abort", abortListener),
      });
    });

    try {
      await emit({
        type: "permission.requested",
        sessionId: session.id,
        requestId,
        toolCallId,
        toolName: manifest.name,
        riskLevel: manifest.riskLevel,
        capabilities: [...new Set([...manifest.capabilities, ...(inspection.requestedCapabilities ?? [])])],
        affectedFiles: [...inspection.affectedFiles],
        networkTargets: [...(inspection.networkTargets ?? [])],
        commands: [...(inspection.commands ?? [])],
        ...(inspection.commandText === undefined ? {} : { commandText: inspection.commandText }),
        reason: inspection.reason ?? manifest.description ?? manifest.name,
        permission: request.permission,
        patterns: [...request.patterns],
        always: [...request.always],
        metadata: structuredClone(request.metadata),
      });
    } catch (error: unknown) {
      const pending = this.pending.get(requestId);
      this.pending.delete(requestId);
      pending?.abortCleanup();
      throw error;
    }

    try {
      const reply = await decision;
      await emit({
        type: "permission.resolved",
        sessionId: session.id,
        requestId,
        decision: reply === "reject" ? "deny" : "allow",
        reply,
      });
      if (session.getStatus() === "awaitingPermission"
        && ![...this.pending.values()].some(item => item.sessionId === session.id)) {
        session.resumeFromPermission();
      }
      return reply === "reject" ? "deny" : "allow";
    } catch (error: unknown) {
      if (session.getStatus() === "awaitingPermission"
        && ![...this.pending.values()].some(item => item.sessionId === session.id)) {
        session.resumeFromPermission();
      }
      throw error;
    }
  }
}

function rulesForMode(mode: AgentSession["permissionMode"]): readonly PermissionRule[] {
  if (mode === "fullAccess") return [{ permission: "*", pattern: "*", action: "allow" }];
  const common: PermissionRule[] = [
    { permission: "read", pattern: "*", action: "allow" },
    { permission: "glob", pattern: "*", action: "allow" },
    { permission: "grep", pattern: "*", action: "allow" },
    // Peru Agent 的 edit/write/apply_patch 只生成 Diff Proposal，因此可安全自动放行到 Diff 审核边界。
    { permission: "edit", pattern: "*", action: "allow" },
    { permission: "question", pattern: "*", action: "allow" },
  ];
  if (mode === "autoReview") {
    return [
      // OpenCode 规则是“最后匹配生效”，所以默认 deny 必须先放，具体 allow/deny 后放。
      { permission: "*", pattern: "*", action: "deny" },
      ...common,
      { permission: "task", pattern: "*", action: "allow" },
      { permission: "bash", pattern: "*", action: "deny" },
      { permission: "webfetch", pattern: "*", action: "deny" },
      { permission: "websearch", pattern: "*", action: "deny" },
      { permission: "browser", pattern: "*", action: "deny" },
      { permission: "computer_interact", pattern: "*", action: "deny" },
    ];
  }
  return [
    // OpenCode 规则是“最后匹配生效”，默认 ask 先放，具体规则覆盖它。
    { permission: "*", pattern: "*", action: "ask" },
    ...common,
    { permission: "computer_inspect", pattern: "*", action: "allow" },
  ];
}
