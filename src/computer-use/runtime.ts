import { createHash } from "node:crypto";
import type { IdGenerator } from "../agent/id-generator.js";
import { evaluateComputerCertification, identityFingerprint } from "./certification.js";
import type { WindowsUiAutomationBrokerClient } from "./broker-client.js";
import type { BrokerComputerActionRequest } from "./broker-protocol.js";
import type { ComputerUseAuditStore } from "./audit.js";
import type {
  CertifiedApplicationManifest,
  ComputerActionResult,
  ComputerClickRequest,
  ComputerElementEvidence,
  ComputerInteractionAction,
  ComputerScreenshot,
  ComputerShortcutRequest,
  ComputerTypeRequest,
  ComputerUiSnapshot,
  ComputerUseAuditEntry,
  ComputerWindowRecord,
  PreparedComputerAction,
} from "./types.js";

const MAX_ELEMENTS = 2_000;
const ACTION_TTL_MS = 60_000;
const SENSITIVE_WINDOW = /(credential|password|sign in|login|登录|密码|凭据|windows security|user account control|uac)/i;
const SENSITIVE_ELEMENT = /(password|passcode|pin|secret|token|api key|密码|口令|密钥|验证码)/i;
const SHORTCUT_PATTERN = /^(CTRL|ALT|SHIFT|WIN)(\+(CTRL|ALT|SHIFT|WIN))*\+[A-Z0-9]$/;

export interface ComputerUseRuntimeListener {
  (event: { readonly type: "window.changed"; readonly window: ComputerWindowRecord }
    | { readonly type: "snapshot.changed"; readonly snapshot: ComputerUiSnapshot }
    | { readonly type: "action.prepared"; readonly action: PreparedComputerAction }
    | { readonly type: "action.completed"; readonly result: ComputerActionResult }): void;
}

export class ComputerUseRuntime {
  private readonly snapshots = new Map<string, ComputerUiSnapshot>();
  private readonly actions = new Map<string, PreparedComputerAction>();
  private readonly listeners = new Set<ComputerUseRuntimeListener>();

  public constructor(
    private readonly broker: WindowsUiAutomationBrokerClient,
    private readonly manifests: readonly CertifiedApplicationManifest[],
    private readonly audit: ComputerUseAuditStore,
    private readonly ids: IdGenerator,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public onEvent(listener: ComputerUseRuntimeListener): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  public initialize(signal?: AbortSignal) { return this.broker.initialize(signal); }

  public async listWindows(signal?: AbortSignal): Promise<readonly ComputerWindowRecord[]> {
    const identities = await this.broker.listWindows(signal);
    const records = identities.map(identity => ({ identity, certification: evaluateComputerCertification(identity, this.manifests) }));
    for (const window of records) await this.emit({ type: "window.changed", window });
    return records;
  }

  public async inspect(windowHandle: string, signal?: AbortSignal): Promise<ComputerUiSnapshot> {
    const raw = await this.broker.inspect(windowHandle, MAX_ELEMENTS, signal);
    if (raw.identity.windowHandle.toLowerCase() !== windowHandle.toLowerCase()) throw new Error("Broker 返回了其他窗口的 Snapshot");
    const certification = evaluateComputerCertification(raw.identity, this.manifests);
    const snapshot = { ...raw, certification };
    this.snapshots.set(snapshot.id, structuredClone(snapshot));
    await this.auditEntry("inspect", "completed", snapshot, undefined, certification.status === "certified" ? "认证应用检查完成" : "未认证应用仅检查");
    await this.emit({ type: "snapshot.changed", snapshot });
    return structuredClone(snapshot);
  }

  public async screenshot(snapshotId: string, signal?: AbortSignal): Promise<ComputerScreenshot> {
    const snapshot = this.requireSnapshot(snapshotId);
    const screenshot = await this.broker.screenshot(snapshotId, signal);
    if (screenshot.windowHandle.toLowerCase() !== snapshot.identity.windowHandle.toLowerCase()) throw new Error("截图窗口与 Snapshot 不匹配");
    await this.auditEntry("screenshot", "completed", snapshot, undefined, "截图证据已生成");
    return screenshot;
  }

  public prepareClick(request: ComputerClickRequest): PreparedComputerAction {
    return this.prepareElementAction("click", request.snapshotId, request.elementId, request.reason);
  }

  public prepareType(request: ComputerTypeRequest): PreparedComputerAction {
    if (request.text.length === 0 || request.text.length > 4_096) throw new Error("输入文本长度必须为 1~4096");
    const action = this.prepareElementAction("type", request.snapshotId, request.elementId, request.reason, request.text);
    return action;
  }

  public prepareShortcut(request: ComputerShortcutRequest): PreparedComputerAction {
    const snapshot = this.requireCertifiedSnapshot(request.snapshotId, "shortcut");
    const shortcut = request.shortcut.toUpperCase();
    if (!SHORTCUT_PATTERN.test(shortcut)) throw new Error("快捷键格式无效");
    if (!snapshot.certification.allowedShortcuts.map(item => item.toUpperCase()).includes(shortcut)) {
      throw new Error(`认证应用未允许快捷键：${shortcut}`);
    }
    this.assertWindowNotSensitive(snapshot);
    return this.storeAction({
      action: "shortcut",
      snapshot,
      reason: request.reason,
      shortcut,
    });
  }

  public async execute(actionId: string, signal?: AbortSignal): Promise<ComputerActionResult> {
    const action = this.actions.get(actionId);
    if (action === undefined) throw new Error(`Computer Use 动作不存在或已使用：${actionId}`);
    this.actions.delete(actionId);
    let pendingText: string | undefined;
    try {
      pendingText = action.textSha256 === undefined ? undefined : this.requirePendingText(action);
    } finally {
      this.pendingText.delete(action.id);
    }
    if (Date.parse(action.expiresAt) <= this.now().getTime()) throw new Error("Computer Use 动作授权已过期");
    const snapshot = this.requireCertifiedSnapshot(action.snapshotId, action.action);
    if (identityFingerprint(snapshot.identity) !== action.identityFingerprint) throw new Error("窗口身份在授权后发生变化");
    if (snapshot.certification.manifestSha256 !== action.manifestSha256) throw new Error("认证清单在授权后发生变化");
    const brokerRequest: BrokerComputerActionRequest = {
      actionId: action.id,
      action: action.action,
      identityFingerprint: action.identityFingerprint,
      manifestSha256: action.manifestSha256,
      snapshotId: snapshot.id,
      snapshotSha256: snapshot.sha256,
      windowHandle: snapshot.identity.windowHandle,
      processId: snapshot.identity.processId,
      ...(action.evidence === undefined ? {} : { evidence: action.evidence }),
      ...(action.shortcut === undefined ? {} : { shortcut: action.shortcut }),
      ...(pendingText === undefined ? {} : { text: pendingText }),
    };
    try {
      const result = await this.broker.act(brokerRequest, signal);
      const certification = evaluateComputerCertification(result.afterSnapshot.identity, this.manifests);
      if (certification.status !== "certified" || certification.applicationId !== action.applicationId) {
        throw new Error("动作后应用不再满足认证清单");
      }
      const afterSnapshot = { ...result.afterSnapshot, certification };
      const verified = { ...result, afterSnapshot };
      this.snapshots.set(afterSnapshot.id, structuredClone(afterSnapshot));
      await this.auditEntry(action.action, "completed", snapshot, action.evidence?.elementId, "Computer Use 动作完成并通过动作后验证");
      await this.emit({ type: "action.completed", result: verified });
      await this.emit({ type: "snapshot.changed", snapshot: afterSnapshot });
      return verified;
    } catch (error: unknown) {
      await this.auditEntry(action.action, "failed", snapshot, action.evidence?.elementId, error instanceof Error ? error.message : "未知动作错误");
      throw error;
    }
  }

  public listPreparedActions(): readonly PreparedComputerAction[] {
    return [...this.actions.values()].map(action => structuredClone(action));
  }

  public discardAction(actionId: string): boolean {
    this.pendingText.delete(actionId);
    return this.actions.delete(actionId);
  }

  public async listAudit(): Promise<readonly ComputerUseAuditEntry[]> { return this.audit.list(); }

  private readonly pendingText = new Map<string, string>();

  private prepareElementAction(
    action: "click" | "type",
    snapshotId: string,
    elementId: string,
    reason: string,
    text?: string,
  ): PreparedComputerAction {
    const snapshot = this.requireCertifiedSnapshot(snapshotId, action);
    this.assertWindowNotSensitive(snapshot);
    const element = snapshot.elements.find(item => item.id === elementId);
    if (element === undefined) throw new Error(`UI 元素不存在：${elementId}`);
    if (!element.enabled || element.offscreen) throw new Error("UI 元素当前不可操作");
    if (element.isPassword || SENSITIVE_ELEMENT.test(`${element.name} ${element.automationId}`)) throw new Error("敏感输入元素禁止 Computer Use");
    if (action === "click" && !element.patterns.some(pattern => pattern === "invoke" || pattern === "selection" || pattern === "toggle")) throw new Error("元素不支持安全点击 Pattern");
    if (action === "type" && !element.patterns.includes("value")) throw new Error("元素不支持 ValuePattern 输入");
    const evidence: ComputerElementEvidence = {
      snapshotId: snapshot.id,
      snapshotSha256: snapshot.sha256,
      elementId: element.id,
      runtimeId: [...element.runtimeId],
      role: element.role,
      name: element.name,
      automationId: element.automationId,
      className: element.className,
      bounds: { ...element.bounds },
    };
    return this.storeAction({ action, snapshot, reason, evidence, ...(text === undefined ? {} : { text }) });
  }

  private storeAction(input: {
    readonly action: ComputerInteractionAction;
    readonly snapshot: ComputerUiSnapshot;
    readonly reason: string;
    readonly evidence?: ComputerElementEvidence;
    readonly shortcut?: string;
    readonly text?: string;
  }): PreparedComputerAction {
    if (input.reason.trim() === "") throw new Error("Computer Use 动作必须提供人类可读原因");
    const applicationId = input.snapshot.certification.applicationId;
    const manifestHash = input.snapshot.certification.manifestSha256;
    if (applicationId === undefined || manifestHash === undefined) throw new Error("认证应用缺少清单绑定");
    const created = this.now();
    const id = this.ids.next("computer-action");
    const action: PreparedComputerAction = {
      id,
      action: input.action,
      applicationId,
      identityFingerprint: identityFingerprint(input.snapshot.identity),
      manifestSha256: manifestHash,
      snapshotId: input.snapshot.id,
      ...(input.evidence === undefined ? {} : { evidence: input.evidence }),
      ...(input.shortcut === undefined ? {} : { shortcut: input.shortcut }),
      ...(input.text === undefined ? {} : { textSha256: createHash("sha256").update(input.text, "utf8").digest("hex") }),
      reason: input.reason,
      requestedCapabilities: ["computer.interact"],
      createdAt: created.toISOString(),
      expiresAt: new Date(created.getTime() + ACTION_TTL_MS).toISOString(),
    };
    if (input.text !== undefined) this.pendingText.set(id, input.text);
    this.actions.set(id, structuredClone(action));
    this.emit({ type: "action.prepared", action });
    return structuredClone(action);
  }

  private requireSnapshot(snapshotId: string): ComputerUiSnapshot {
    const snapshot = this.snapshots.get(snapshotId);
    if (snapshot === undefined) throw new Error(`Computer Use Snapshot 不存在：${snapshotId}`);
    return snapshot;
  }

  private requireCertifiedSnapshot(snapshotId: string, action: ComputerInteractionAction): ComputerUiSnapshot {
    const snapshot = this.requireSnapshot(snapshotId);
    if (snapshot.certification.status !== "certified") throw new Error("未认证应用只允许检查，禁止交互");
    if (!snapshot.certification.allowedActions.includes(action)) throw new Error(`认证应用未允许动作：${action}`);
    return snapshot;
  }

  private assertWindowNotSensitive(snapshot: ComputerUiSnapshot): void {
    if (snapshot.identity.secureDesktop || SENSITIVE_WINDOW.test(snapshot.identity.windowTitle)) {
      throw new Error("敏感或安全窗口禁止 Computer Use 交互");
    }
  }

  private requirePendingText(action: PreparedComputerAction): string {
    const text = this.pendingText.get(action.id);
    if (text === undefined || action.textSha256 === undefined) {
      throw new Error("Computer Use 输入文本已丢失");
    }
    const hash = createHash("sha256").update(text, "utf8").digest("hex");
    if (hash !== action.textSha256) {
      throw new Error("Computer Use 输入文本在授权后发生变化");
    }
    return text;
  }

  private async auditEntry(
    action: ComputerUseAuditEntry["action"],
    decision: ComputerUseAuditEntry["decision"],
    snapshot: ComputerUiSnapshot,
    elementId: string | undefined,
    reason: string,
  ): Promise<void> {
    await this.audit.append({
      id: this.ids.next("computer-audit"),
      timestamp: this.now().toISOString(),
      action,
      decision,
      processId: snapshot.identity.processId,
      windowHandle: snapshot.identity.windowHandle,
      ...(snapshot.certification.applicationId === undefined ? {} : { applicationId: snapshot.certification.applicationId }),
      snapshotId: snapshot.id,
      ...(elementId === undefined ? {} : { elementId }),
      reason,
    });
  }

  private emit(event: Parameters<ComputerUseRuntimeListener>[0]): void {
    for (const listener of this.listeners) listener(structuredClone(event));
  }
}
