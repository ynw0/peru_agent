import type { AgentEvent, Capability } from "../agent-protocol.js";
import { decidePermission } from "../permission-engine.js";
import type { ToolManifest, ToolInspection } from "../tool-runtime.js";
import { AgentError } from "./errors.js";
import type { IdGenerator } from "./id-generator.js";
import type { AgentSession } from "./session.js";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type PermissionGrantScope = "once" | "session" | "project";

export type AgentEventEmitter = (event: AgentEvent) => Promise<void>;

interface PendingPermission {
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly fingerprint: string;
  readonly resolve: (decision: "allow" | "deny") => void;
  readonly reject: (error: Error) => void;
  readonly abortCleanup: () => void;
}

// PermissionCoordinator 负责把规则判断和用户交互连接起来。
export class PermissionCoordinator {
  private readonly pending = new Map<string, PendingPermission>();
  private readonly sessionGrants = new Set<string>();
  private readonly projectGrants = new Set<string>();

  public constructor(private readonly idGenerator: IdGenerator, private readonly projectGrantFile?: string) {
    if (projectGrantFile !== undefined && existsSync(projectGrantFile)) {
      try {
        const parsed = JSON.parse(readFileSync(projectGrantFile, "utf8")) as unknown;
        if (Array.isArray(parsed)) for (const item of parsed) if (typeof item === "string") this.projectGrants.add(item);
      } catch { /* invalid grant store is ignored; no permission is broadened */ }
    }
  }

  public async authorize(
    session: AgentSession,
    toolCallId: string,
    manifest: ToolManifest,
    inspection: ToolInspection,
    emit: AgentEventEmitter,
    signal: AbortSignal,
  ): Promise<"allow" | "deny"> {
    const capabilities = [...new Set([
      ...manifest.capabilities,
      ...(inspection.requestedCapabilities ?? []),
    ])];
    const decisions = capabilities.map(capability => ({
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

    const fingerprint = permissionFingerprint(session, manifest, inspection, askedCapabilities);
    if (this.sessionGrants.has(`${session.id}:${fingerprint}`) || this.projectGrants.has(`${session.workspaceId}:${fingerprint}`)) return "allow";

    return this.waitForUserDecision(
      session,
      toolCallId,
      manifest,
      inspection,
      askedCapabilities,
      emit,
      signal,
    );
  }

  public resolve(requestId: string, decision: "allow" | "deny"): boolean {
    return this.resolveWithScope(requestId, decision === "allow" ? "once" : "deny");
  }

  public resolveWithScope(requestId: string, scope: PermissionGrantScope | "deny"): boolean {
    const pending = this.pending.get(requestId);
    if (pending === undefined) {
      return false;
    }
    this.pending.delete(requestId);
    pending.abortCleanup();
    if (scope === "session") this.sessionGrants.add(`${pending.sessionId}:${pending.fingerprint}`);
    if (scope === "project") {
      this.projectGrants.add(`${pending.workspaceId}:${pending.fingerprint}`);
      this.persistProjectGrants();
    }
    pending.resolve(scope === "deny" ? "deny" : "allow");
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

  public clearSession(sessionId: string): void {
    for (const key of this.sessionGrants) if (key.startsWith(`${sessionId}:`)) this.sessionGrants.delete(key);
  }

  private async waitForUserDecision(
    session: AgentSession,
    toolCallId: string,
    manifest: ToolManifest,
    inspection: ToolInspection,
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
        workspaceId: session.workspaceId,
        fingerprint: permissionFingerprint(session, manifest, inspection, capabilities),
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
        toolCallId,
        toolName: manifest.name,
        riskLevel: manifest.riskLevel,
        capabilities: [...capabilities],
        affectedFiles: [...inspection.affectedFiles],
        networkTargets: [...(inspection.networkTargets ?? [])],
        commands: [...(inspection.commands ?? [])],
        ...(inspection.commandText === undefined ? {} : { commandText: inspection.commandText }),
        reason: inspection.reason ?? manifest.description ?? manifest.name,
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

  private persistProjectGrants(): void {
    if (this.projectGrantFile === undefined) return;
    mkdirSync(dirname(this.projectGrantFile), { recursive: true });
    const temporary = `${this.projectGrantFile}.tmp-${Date.now()}`;
    writeFileSync(temporary, `${JSON.stringify([...this.projectGrants].sort(), null, 2)}\n`, "utf8");
    renameSync(temporary, this.projectGrantFile);
  }
}

function permissionFingerprint(session: AgentSession, manifest: ToolManifest, inspection: ToolInspection, capabilities: readonly Capability[]): string {
  return createHash("sha256").update(JSON.stringify({
    workspaceId: session.workspaceId,
    tool: `${manifest.name}@${manifest.version}`,
    capabilities: [...capabilities].sort(),
    commandText: inspection.commandText ?? "",
    files: [...inspection.affectedFiles].sort(),
    network: [...(inspection.networkTargets ?? [])].sort(),
  }), "utf8").digest("hex");
}
