import type { IdGenerator } from "../agent/id-generator.js";
import { EgressBroker } from "../egress/broker.js";
import type { WebDownloadArtifact } from "../web/types.js";
import type { BrowserProxyVerifier } from "./proxy-verifier.js";
import type { WebDownloadService } from "../web/web-download-service.js";
import type {
  BrowserActionResult,
  BrowserActionTarget,
  BrowserCreateRequest,
  BrowserDomSnapshot,
  BrowserDriver,
  BrowserScreenshot,
  BrowserSessionRecord,
} from "./types.js";

export interface BrowserRuntimeOptions {
  readonly proxyServerUrl: string;
  readonly maxSessions: number;
  readonly viewport: { readonly width: number; readonly height: number };
  readonly proxyVerifier: BrowserProxyVerifier;
}

export class BrowserRuntime {
  private readonly sessions = new Map<string, BrowserSessionRecord>();
  private readonly snapshots = new Map<string, BrowserDomSnapshot>();

  public constructor(
    private readonly driver: BrowserDriver,
    private readonly broker: EgressBroker,
    private readonly ids: IdGenerator,
    private readonly options: BrowserRuntimeOptions,
    private readonly downloadService?: WebDownloadService,
  ) {
    if (driver.egressEnforcement !== "broker-proxy") {
      throw new Error("Browser Driver 必须使用 Broker Proxy，禁止直接联网");
    }
    const proxy = new URL(options.proxyServerUrl);
    const proxyHostname = canonicalProxyHostname(proxy.hostname);
    if (proxy.protocol !== "http:" || (proxyHostname !== "127.0.0.1" && proxyHostname !== "::1" && proxyHostname !== "localhost")) {
      throw new Error("Browser Broker Proxy 必须是本机 HTTP 地址");
    }
    if (!Number.isInteger(options.maxSessions) || options.maxSessions <= 0 || options.maxSessions > 20) {
      throw new Error("maxSessions 必须是 1~20 的整数");
    }
  }

  public async create(request: BrowserCreateRequest, signal: AbortSignal): Promise<BrowserSessionRecord> {
    validateCreateRequest(request);
    const active = [...this.sessions.values()].filter(session => session.status !== "closed").length;
    if (active >= this.options.maxSessions) {
      throw new Error(`浏览器会话超过限制 ${this.options.maxSessions}`);
    }
    const verification = await this.options.proxyVerifier.verify(this.options.proxyServerUrl, signal);
    if (verification.enforcement !== "egress-broker" || verification.serverUrl !== new URL(this.options.proxyServerUrl).toString()) {
      throw new Error("Browser Proxy 能力握手不匹配");
    }
    const now = new Date().toISOString();
    const id = this.ids.next("browser-session");
    const starting: BrowserSessionRecord = {
      id,
      workspaceId: request.workspaceId,
      networkMode: request.networkMode,
      status: "starting",
      createdAt: now,
      updatedAt: now,
    };
    this.sessions.set(id, starting);
    try {
      await this.driver.create({
        sessionId: id,
        locale: request.locale,
        proxyServerUrl: this.options.proxyServerUrl,
        viewport: this.options.viewport,
        authorizeResource: async (url, resourceSignal) => {
          const lease = await this.broker.authorize({
            url,
            mode: request.networkMode,
            purpose: "browser.resource",
            method: "GET",
          }, resourceSignal);
          this.broker.discardAuthorization(lease.id);
        },
      }, signal);
      return this.update(id, { status: "ready" });
    } catch (error: unknown) {
      this.update(id, {
        status: "failed",
        error: { code: "BROWSER_CREATE_FAILED", message: errorMessage(error) },
      });
      throw error;
    }
  }

  public async navigate(sessionId: string, url: string, signal: AbortSignal): Promise<BrowserDomSnapshot> {
    const session = this.requireActive(sessionId);
    const lease = await this.broker.authorize({
      url,
      mode: session.networkMode,
      purpose: "browser.navigation",
      method: "GET",
    }, signal);
    this.update(sessionId, { status: "navigating" });
    try {
      const snapshot = await this.driver.navigate(sessionId, lease.normalizedUrl, signal);
      this.broker.discardAuthorization(lease.id);
      this.acceptSnapshot(sessionId, snapshot);
      this.update(sessionId, {
        status: "ready",
        currentUrl: snapshot.url,
        title: snapshot.title,
        lastSnapshotId: snapshot.id,
      });
      return structuredClone(snapshot);
    } catch (error: unknown) {
      this.broker.discardAuthorization(lease.id);
      this.update(sessionId, {
        status: "failed",
        error: { code: "BROWSER_NAVIGATION_FAILED", message: errorMessage(error) },
      });
      throw error;
    }
  }

  public async snapshot(sessionId: string, signal: AbortSignal): Promise<BrowserDomSnapshot> {
    this.requireActive(sessionId);
    const snapshot = await this.driver.snapshot(sessionId, signal);
    this.acceptSnapshot(sessionId, snapshot);
    this.update(sessionId, {
      currentUrl: snapshot.url,
      title: snapshot.title,
      lastSnapshotId: snapshot.id,
    });
    return structuredClone(snapshot);
  }

  public async screenshot(sessionId: string, signal: AbortSignal): Promise<BrowserScreenshot> {
    const session = this.requireActive(sessionId);
    if (session.lastSnapshotId === undefined) {
      throw new Error("截图前必须先创建 DOM Snapshot");
    }
    const screenshot = await this.driver.screenshot(sessionId, signal);
    if (screenshot.sessionId !== sessionId || screenshot.snapshotId !== session.lastSnapshotId
      || screenshot.byteLength > 10 * 1024 * 1024 || screenshot.base64.length > 16 * 1024 * 1024) {
      throw new Error("截图证据与当前浏览器 Snapshot 不一致");
    }
    return structuredClone(screenshot);
  }

  public async click(sessionId: string, target: BrowserActionTarget, signal: AbortSignal): Promise<BrowserActionResult> {
    this.assertTargetCurrent(sessionId, target);
    const result = await this.driver.click(sessionId, target, signal);
    return this.acceptActionResult(sessionId, target, result, "click");
  }

  public async type(
    sessionId: string,
    target: BrowserActionTarget,
    text: string,
    signal: AbortSignal,
  ): Promise<BrowserActionResult> {
    if (text.length === 0 || text.length > 10_000 || /[\u0000]/.test(text)) {
      throw new Error("输入文本必须是 1~10000 个非 NUL 字符");
    }
    this.assertTargetCurrent(sessionId, target);
    const result = await this.driver.type(sessionId, target, text, signal);
    return this.acceptActionResult(sessionId, target, result, "type");
  }


  public async download(
    sessionId: string,
    url: string,
    maxBytes: number,
    signal: AbortSignal,
  ): Promise<WebDownloadArtifact> {
    const session = this.requireActive(sessionId);
    if (this.downloadService === undefined) throw new Error("受控下载服务未配置");
    const prepared = await this.downloadService.prepare(
      session.workspaceId,
      url,
      session.networkMode,
      maxBytes,
      signal,
    );
    try {
      return await this.downloadService.execute(prepared, signal);
    } catch (error) {
      this.downloadService.discard(prepared);
      throw error;
    }
  }

  public async close(sessionId: string): Promise<BrowserSessionRecord> {
    const session = this.requireSession(sessionId);
    if (session.status !== "closed") {
      await this.driver.close(sessionId);
    }
    return this.update(sessionId, { status: "closed" });
  }

  public get(sessionId: string): BrowserSessionRecord {
    return structuredClone(this.requireSession(sessionId));
  }

  public list(workspaceId?: string): readonly BrowserSessionRecord[] {
    return [...this.sessions.values()]
      .filter(session => workspaceId === undefined || session.workspaceId === workspaceId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map(session => structuredClone(session));
  }

  private acceptActionResult(
    sessionId: string,
    target: BrowserActionTarget,
    result: BrowserActionResult,
    action: BrowserActionResult["action"],
  ): BrowserActionResult {
    if (!result.verified || result.action !== action || result.beforeSnapshotId !== target.snapshotId
      || result.afterSnapshot.id === target.snapshotId) {
      throw new Error("浏览器动作缺少目标证据或动作后验证");
    }
    this.acceptSnapshot(sessionId, result.afterSnapshot);
    this.update(sessionId, {
      currentUrl: result.afterSnapshot.url,
      title: result.afterSnapshot.title,
      lastSnapshotId: result.afterSnapshot.id,
      status: "ready",
    });
    return structuredClone(result);
  }

  private assertTargetCurrent(sessionId: string, target: BrowserActionTarget): void {
    const session = this.requireActive(sessionId);
    if (session.lastSnapshotId !== target.snapshotId) {
      throw new Error("浏览器动作目标使用了过期 Snapshot");
    }
    const snapshot = this.snapshots.get(target.snapshotId);
    if (snapshot === undefined || !snapshot.elements.some(element => element.id === target.elementId && !element.disabled)) {
      throw new Error("浏览器动作目标不存在或不可操作");
    }
  }

  private acceptSnapshot(sessionId: string, snapshot: BrowserDomSnapshot): void {
    if (snapshot.sessionId !== sessionId || snapshot.id.trim() === "" || snapshot.url.trim() === ""
      || snapshot.text.length > 200_000 || snapshot.elements.length > 500
      || new Set(snapshot.elements.map(element => element.id)).size !== snapshot.elements.length
      || !/^[a-f0-9]{64}$/.test(snapshot.sha256)) {
      throw new Error("Browser Driver 返回的 Snapshot 无效");
    }
    this.snapshots.set(snapshot.id, structuredClone(snapshot));
  }

  private requireActive(sessionId: string): BrowserSessionRecord {
    const session = this.requireSession(sessionId);
    if (session.status === "closed" || session.status === "failed") {
      throw new Error(`浏览器会话不可用：${session.status}`);
    }
    return session;
  }

  private requireSession(sessionId: string): BrowserSessionRecord {
    const session = this.sessions.get(sessionId);
    if (session === undefined) throw new Error(`浏览器会话不存在：${sessionId}`);
    return session;
  }

  private update(
    sessionId: string,
    changes: Partial<Omit<BrowserSessionRecord, "id" | "workspaceId" | "networkMode" | "createdAt" | "updatedAt">>,
  ): BrowserSessionRecord {
    const current = this.requireSession(sessionId);
    const next: BrowserSessionRecord = {
      ...current,
      ...changes,
      updatedAt: new Date().toISOString(),
    };
    this.sessions.set(sessionId, next);
    return structuredClone(next);
  }
}

function validateCreateRequest(request: BrowserCreateRequest): void {
  if (request.workspaceId.trim() === "") throw new Error("workspaceId 不能为空");
  if (request.locale !== "zh-CN" && request.locale !== "en-US") throw new Error("locale 无效");
}

function canonicalProxyHostname(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1).toLowerCase()
    : hostname.toLowerCase();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "未知浏览器错误";
}
