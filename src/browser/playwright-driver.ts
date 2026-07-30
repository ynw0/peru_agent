import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type {
  BrowserActionResult,
  BrowserActionTarget,
  BrowserDomSnapshot,
  BrowserDriver,
  BrowserDriverCreateRequest,
  BrowserScreenshot,
} from "./types.js";

interface ElementEvidence {
  readonly index: number;
  readonly role: string;
  readonly name: string;
  readonly disabled: boolean;
}

interface PlaywrightSession {
  readonly browser: import("playwright-core").Browser;
  readonly context: import("playwright-core").BrowserContext;
  readonly page: import("playwright-core").Page;
  readonly controller: AbortController;
  readonly evidence: Map<string, ReadonlyMap<string, ElementEvidence>>;
  lastSnapshotId?: string;
}

export interface PlaywrightBrowserDriverOptions {
  readonly executablePath: string;
  readonly expectedSha256: string;
}

// Playwright 仅在运行时动态加载；缺少锁定依赖时明确失败，不降级到系统浏览器。
export class PlaywrightBrowserDriver implements BrowserDriver {
  public readonly kind = "playwright-chromium";
  public readonly egressEnforcement = "broker-proxy" as const;
  private readonly sessions = new Map<string, PlaywrightSession>();

  public constructor(private readonly options: PlaywrightBrowserDriverOptions) {
    if (!/^[A-Za-z]:\\/.test(options.executablePath)) throw new Error("Chromium executablePath 必须是绝对 Windows 路径");
    if (!/^[a-f0-9]{64}$/.test(options.expectedSha256)) throw new Error("Chromium SHA-256 无效");
  }

  public async create(request: BrowserDriverCreateRequest, signal: AbortSignal): Promise<void> {
    const playwright = await import("playwright-core").catch((error: unknown) => {
      throw new Error(`Playwright Runtime 不可用：${error instanceof Error ? error.message : "加载失败"}`);
    });
    if (signal.aborted) throw new Error("浏览器创建已取消");
    await this.verifyBundledChromium();
    const controller = new AbortController();
    const abortCreate = (): void => controller.abort();
    signal.addEventListener("abort", abortCreate, { once: true });
    try {
      const browser = await playwright.chromium.launch({
        headless: true,
        proxy: { server: request.proxyServerUrl },
        executablePath: this.options.executablePath,
      });
      if (controller.signal.aborted) {
        await browser.close();
        throw new Error("浏览器创建已取消");
      }
      const context = await browser.newContext({
        locale: request.locale,
        viewport: request.viewport,
        acceptDownloads: false,
      });
      await context.route("**/*", async route => {
        const resourceUrl = route.request().url();
        const protocol = safeProtocol(resourceUrl);
        if (protocol === "http:" || protocol === "https:") {
          await request.authorizeResource(resourceUrl, controller.signal);
          await route.continue();
          return;
        }
        if (protocol === "data:" || protocol === "blob:" || protocol === "about:") {
          await route.continue();
          return;
        }
        await route.abort("blockedbyclient");
      });
      const page = await context.newPage();
      this.sessions.set(request.sessionId, {
        browser,
        context,
        page,
        controller,
        evidence: new Map(),
      });
    } finally {
      signal.removeEventListener("abort", abortCreate);
    }
  }

  public async navigate(sessionId: string, url: string, signal: AbortSignal): Promise<BrowserDomSnapshot> {
    const session = this.require(sessionId);
    assertSignals(signal, session.controller.signal, "浏览器导航已取消");
    await session.page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    assertSignals(signal, session.controller.signal, "浏览器导航已取消");
    return this.snapshot(sessionId, signal);
  }

  public async snapshot(sessionId: string, signal: AbortSignal): Promise<BrowserDomSnapshot> {
    const session = this.require(sessionId);
    assertSignals(signal, session.controller.signal, "DOM Snapshot 已取消");
    const raw = await session.page.locator("body").ariaSnapshot({ timeout: 10_000 });
    const text = await session.page.locator("body").innerText({ timeout: 10_000 });
    const url = session.page.url();
    const title = await session.page.title();
    const elements = await session.page.locator(elementSelector).evaluateAll(nodes => nodes.slice(0, 500).map((node, index) => ({
      id: `element-${index + 1}`,
      role: node.getAttribute("role") ?? node.tagName.toLowerCase(),
      name: node.getAttribute("aria-label") ?? node.textContent?.trim().slice(0, 200) ?? "",
      ...(node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement ? { value: node.value } : {}),
      disabled: isDisabledElement(node),
    })));
    assertSignals(signal, session.controller.signal, "DOM Snapshot 已取消");
    const createdAt = new Date().toISOString();
    const payload = JSON.stringify({ url, title, raw, text, elements, createdAt });
    const snapshotId = `snapshot-${sha256(payload).slice(0, 24)}`;
    session.lastSnapshotId = snapshotId;
    session.evidence.set(snapshotId, new Map(elements.map((element, index) => [element.id, {
      index,
      role: element.role,
      name: element.name,
      disabled: element.disabled,
    }])));
    pruneEvidence(session);
    return {
      id: snapshotId,
      sessionId,
      url,
      title,
      text: `${raw}\n\n${text}`.slice(0, 200_000),
      elements,
      sha256: sha256(payload),
      createdAt,
    };
  }

  public async screenshot(sessionId: string, signal: AbortSignal): Promise<BrowserScreenshot> {
    const session = this.require(sessionId);
    assertSignals(signal, session.controller.signal, "截图已取消");
    const snapshotId = session.lastSnapshotId;
    if (snapshotId === undefined) throw new Error("截图前必须创建 DOM Snapshot");
    const bytes = await session.page.screenshot({ type: "png", fullPage: false });
    return {
      sessionId,
      snapshotId,
      mimeType: "image/png",
      base64: bytes.toString("base64"),
      byteLength: bytes.byteLength,
      sha256: sha256Bytes(bytes),
    };
  }

  public async click(sessionId: string, target: BrowserActionTarget, signal: AbortSignal): Promise<BrowserActionResult> {
    const session = this.require(sessionId);
    const locator = await this.verifyTarget(session, target);
    await locator.click({ timeout: 10_000 });
    assertSignals(signal, session.controller.signal, "点击已取消");
    return {
      verified: true,
      beforeSnapshotId: target.snapshotId,
      afterSnapshot: await this.snapshot(sessionId, signal),
      action: "click",
    };
  }

  public async type(sessionId: string, target: BrowserActionTarget, text: string, signal: AbortSignal): Promise<BrowserActionResult> {
    const session = this.require(sessionId);
    const locator = await this.verifyTarget(session, target);
    await locator.fill(text, { timeout: 10_000 });
    assertSignals(signal, session.controller.signal, "输入已取消");
    return {
      verified: true,
      beforeSnapshotId: target.snapshotId,
      afterSnapshot: await this.snapshot(sessionId, signal),
      action: "type",
    };
  }

  public async close(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session === undefined) return;
    this.sessions.delete(sessionId);
    session.controller.abort();
    await session.context.close();
    await session.browser.close();
  }

  private async verifyTarget(
    session: PlaywrightSession,
    target: BrowserActionTarget,
  ): Promise<import("playwright-core").Locator> {
    if (session.lastSnapshotId !== target.snapshotId) {
      throw new Error("Playwright 动作使用了过期 Snapshot");
    }
    const expected = session.evidence.get(target.snapshotId)?.get(target.elementId);
    if (expected === undefined || expected.disabled) {
      throw new Error("Playwright 动作目标缺少 Snapshot 证据");
    }
    const locator = session.page.locator(elementSelector).nth(expected.index);
    const current = await locator.evaluate(node => ({
      role: node.getAttribute("role") ?? node.tagName.toLowerCase(),
      name: node.getAttribute("aria-label") ?? node.textContent?.trim().slice(0, 200) ?? "",
      disabled: isDisabledElement(node),
    }));
    if (current.role !== expected.role || current.name !== expected.name || current.disabled) {
      throw new Error("Playwright 动作目标在 Snapshot 后发生变化");
    }
    return locator;
  }

  private require(sessionId: string): PlaywrightSession {
    const session = this.sessions.get(sessionId);
    if (session === undefined) throw new Error(`Playwright 会话不存在：${sessionId}`);
    return session;
  }

  private async verifyBundledChromium(): Promise<void> {
    let bytes: Uint8Array;
    try {
      bytes = await readFile(this.options.executablePath);
    } catch (error: unknown) {
      throw new Error(`Bundled Chromium missing：${error instanceof Error ? error.message : "读取失败"}`);
    }
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== this.options.expectedSha256) {
      throw new Error(`Bundled Chromium SHA-256 不匹配：${actual}`);
    }
  }
}

const elementSelector = "a,button,input,textarea,select,[role]";

function isDisabledElement(node: Element): boolean {
  return node instanceof HTMLButtonElement
    || node instanceof HTMLInputElement
    || node instanceof HTMLTextAreaElement
    || node instanceof HTMLSelectElement
    ? node.disabled
    : node.getAttribute("aria-disabled") === "true";
}

function pruneEvidence(session: PlaywrightSession): void {
  while (session.evidence.size > 5) {
    const oldest = session.evidence.keys().next().value;
    if (typeof oldest !== "string") break;
    session.evidence.delete(oldest);
  }
}

function safeProtocol(value: string): string {
  try {
    return new URL(value).protocol;
  } catch {
    return "invalid:";
  }
}

function assertSignals(requestSignal: AbortSignal, sessionSignal: AbortSignal, message: string): void {
  if (requestSignal.aborted || sessionSignal.aborted) throw new Error(message);
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function sha256Bytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
