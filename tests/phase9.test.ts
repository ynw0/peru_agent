import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import assert from "node:assert/strict";
import { IncrementingIdGenerator } from "../src/agent/id-generator.js";
import { BrowserRuntime } from "../src/browser/browser-runtime.js";
import { HttpBrowserProxyVerifier, type BrowserProxyVerifier } from "../src/browser/proxy-verifier.js";
import type {
  BrowserActionResult,
  BrowserActionTarget,
  BrowserDomSnapshot,
  BrowserDriver,
  BrowserDriverCreateRequest,
  BrowserScreenshot,
} from "../src/browser/types.js";
import { classifyNetworkAddress } from "../src/egress/address-policy.js";
import { InMemoryEgressAuditStore } from "../src/egress/audit.js";
import { EgressBroker } from "../src/egress/broker.js";
import { NodePinnedHttpTransport } from "../src/egress/node-http-transport.js";
import { NodeDnsResolver } from "../src/egress/resolver.js";
import type {
  EgressResolver,
  PinnedHttpRequest,
  PinnedHttpResponse,
  PinnedHttpTransport,
} from "../src/egress/types.js";
import { TypedIpcClient, TypedIpcServer } from "../src/ipc/channel.js";
import { createInMemoryTransportPair } from "../src/ipc/transport.js";
import { isIpcMessage } from "../src/ipc/validation.js";
import { BrowserIpcBridge } from "../src/runtime/browser-ipc-bridge.js";
import { WebIpcBridge } from "../src/runtime/web-ipc-bridge.js";
import type { ToolExecutionContext, ToolInspectionContext } from "../src/tool-runtime.js";
import { createWebTools } from "../src/web/web-tools.js";
import { WebFetchService, WebSearchService } from "../src/web/web-services.js";
import { FileSystemDownloadArtifactStore } from "../src/web/download-store.js";
import { WebDownloadService } from "../src/web/web-download-service.js";
import { SearxngJsonSearchProvider } from "../src/web/searxng-provider.js";
import type { WebSearchProvider } from "../src/web/types.js";
import { WorkbenchController } from "../src/workbench/workbench-controller.js";

const acceptingProxyVerifier: BrowserProxyVerifier = {
  async verify(serverUrl) {
    return { protocolVersion: 1, healthy: true, enforcement: "egress-broker", serverUrl: new URL(serverUrl).toString() };
  },
};

class StaticResolver implements EgressResolver {
  public constructor(private readonly records: Readonly<Record<string, readonly string[]>>) {}

  public async resolve(hostname: string): Promise<readonly { address: string; family: 4 | 6 }[]> {
    const values = this.records[hostname];
    if (values === undefined) throw new Error(`没有 DNS 记录：${hostname}`);
    return values.map(address => ({ address, family: classifyNetworkAddress(address).family }));
  }
}

class ScriptedTransport implements PinnedHttpTransport {
  public readonly requests: PinnedHttpRequest[] = [];
  private index = 0;

  public constructor(private readonly responses: readonly (PinnedHttpResponse | Error)[]) {}

  public async request(request: PinnedHttpRequest, signal: AbortSignal): Promise<PinnedHttpResponse> {
    if (signal.aborted) throw new Error("aborted");
    this.requests.push(structuredClone(request));
    const response = this.responses[this.index++];
    if (response === undefined) throw new Error("没有更多传输响应");
    if (response instanceof Error) throw response;
    return response;
  }
}

function response(status: number, body: string, headers: Readonly<Record<string, string>> = {}): PinnedHttpResponse {
  return { status, headers, body: new TextEncoder().encode(body) };
}

function broker(
  resolver: EgressResolver,
  transport: PinnedHttpTransport,
  audit = new InMemoryEgressAuditStore(),
): { broker: EgressBroker; audit: InMemoryEgressAuditStore } {
  return {
    broker: new EgressBroker(resolver, transport, audit, new IncrementingIdGenerator(), {
      allowedPorts: [80, 443, 3000],
    }),
    audit,
  };
}

class JsonSearchProvider implements WebSearchProvider {
  public readonly name = "test-search";

  public prepare(query: string, maxResults: number) {
    return {
      url: `https://search.example/api?q=${encodeURIComponent(query)}&count=${maxResults}`,
      method: "GET" as const,
      headers: { accept: "application/json" },
    };
  }

  public parse(body: string, maxResults: number) {
    const parsed = JSON.parse(body) as { results: { title: string; url: string; snippet: string }[] };
    return parsed.results.slice(0, maxResults);
  }
}

class FakeBrowserDriver implements BrowserDriver {
  public readonly kind = "fake-proxy-browser";
  public readonly egressEnforcement = "broker-proxy" as const;
  private readonly authorizers = new Map<string, BrowserDriverCreateRequest["authorizeResource"]>();
  private readonly current = new Map<string, BrowserDomSnapshot>();
  private sequence = 0;

  public async create(request: BrowserDriverCreateRequest): Promise<void> {
    this.authorizers.set(request.sessionId, request.authorizeResource);
  }

  public async navigate(sessionId: string, url: string, signal: AbortSignal): Promise<BrowserDomSnapshot> {
    await this.authorizers.get(sessionId)?.(url, signal);
    return this.makeSnapshot(sessionId, url);
  }

  public async snapshot(sessionId: string): Promise<BrowserDomSnapshot> {
    const current = this.current.get(sessionId);
    if (current === undefined) throw new Error("no snapshot");
    return current;
  }

  public async screenshot(sessionId: string): Promise<BrowserScreenshot> {
    const current = await this.snapshot(sessionId);
    return {
      sessionId,
      snapshotId: current.id,
      mimeType: "image/png",
      base64: "cG5n",
      byteLength: 3,
      sha256: "b".repeat(64),
    };
  }

  public async click(sessionId: string, target: BrowserActionTarget): Promise<BrowserActionResult> {
    return {
      verified: true,
      beforeSnapshotId: target.snapshotId,
      afterSnapshot: this.makeSnapshot(sessionId, this.current.get(sessionId)?.url ?? "https://site.example/"),
      action: "click",
    };
  }

  public async type(sessionId: string, target: BrowserActionTarget): Promise<BrowserActionResult> {
    return {
      verified: true,
      beforeSnapshotId: target.snapshotId,
      afterSnapshot: this.makeSnapshot(sessionId, this.current.get(sessionId)?.url ?? "https://site.example/"),
      action: "type",
    };
  }

  public async close(sessionId: string): Promise<void> {
    this.authorizers.delete(sessionId);
  }

  private makeSnapshot(sessionId: string, url: string): BrowserDomSnapshot {
    this.sequence += 1;
    const snapshot: BrowserDomSnapshot = {
      id: `snapshot-${this.sequence}`,
      sessionId,
      url,
      title: "Test Page",
      text: "Hello",
      elements: [{ id: "button-1", role: "button", name: "Run", disabled: false }],
      sha256: this.sequence.toString(16).padStart(64, "0"),
      createdAt: new Date().toISOString(),
    };
    this.current.set(sessionId, snapshot);
    return snapshot;
  }
}

function browserEnvironment(): { runtime: BrowserRuntime; broker: EgressBroker; driver: FakeBrowserDriver } {
  const resolver = new StaticResolver({ "site.example": ["93.184.216.34"] });
  const transport = new ScriptedTransport([]);
  const egress = broker(resolver, transport).broker;
  const driver = new FakeBrowserDriver();
  return {
    runtime: new BrowserRuntime(driver, egress, new IncrementingIdGenerator(), {
      proxyServerUrl: "http://127.0.0.1:7777",
      maxSessions: 3,
      viewport: { width: 1280, height: 720 },
      proxyVerifier: acceptingProxyVerifier,
    }),
    broker: egress,
    driver,
  };
}

test("地址分类与三种网络模式拒绝混合或越权地址", async () => {
  const transport = new ScriptedTransport([]);
  await assert.rejects(broker(new StaticResolver({ "private.example": ["10.0.0.2"] }), transport).broker.authorize({
    url: "https://private.example/",
    mode: "internet",
    purpose: "web.fetch",
  }, new AbortController().signal));
  await broker(new StaticResolver({ "private.example": ["10.0.0.2"] }), transport).broker.authorize({
    url: "https://private.example/",
    mode: "lan",
    purpose: "web.fetch",
  }, new AbortController().signal);
  await assert.rejects(broker(new StaticResolver({ "mixed.example": ["93.184.216.34", "127.0.0.1"] }), transport).broker.authorize({
    url: "https://mixed.example/",
    mode: "internet",
    purpose: "web.fetch",
  }, new AbortController().signal));
});

test("Egress Broker 拒绝凭据、非白名单端口并绑定单次授权", async () => {
  const env = broker(new StaticResolver({ "public.example": ["93.184.216.34"] }), new ScriptedTransport([
    response(200, "ok", { "content-type": "text/plain" }),
  ])).broker;
  await assert.rejects(env.authorize({ url: "https://user:pass@public.example/", mode: "internet", purpose: "web.fetch" }, new AbortController().signal));
  await assert.rejects(env.authorize({ url: "https://public.example:8443/", mode: "internet", purpose: "web.fetch" }, new AbortController().signal));
  const lease = await env.authorize({ url: "https://public.example/a", mode: "internet", purpose: "web.fetch" }, new AbortController().signal);
  await assert.rejects(env.fetchAuthorized(lease.id, {
    url: "https://public.example/b",
    mode: "internet",
    purpose: "web.fetch",
  }, new AbortController().signal));
  await assert.rejects(env.fetchAuthorized(lease.id, {
    url: "https://public.example/a",
    mode: "internet",
    purpose: "web.fetch",
  }, new AbortController().signal));
});

test("每个重定向重新审核并在跨源时删除 Authorization", async () => {
  const transport = new ScriptedTransport([
    response(302, "", { location: "https://b.example/final" }),
    response(200, "done", { "content-type": "text/plain" }),
  ]);
  const env = broker(new StaticResolver({
    "a.example": ["93.184.216.34"],
    "b.example": ["93.184.216.35"],
  }), transport).broker;
  const lease = await env.authorize({ url: "https://a.example/start", mode: "internet", purpose: "web.fetch" }, new AbortController().signal);
  const result = await env.fetchAuthorized(lease.id, {
    url: lease.normalizedUrl,
    mode: "internet",
    purpose: "web.fetch",
    headers: { authorization: "Bearer secret" },
  }, new AbortController().signal);
  assert.equal(result.finalUrl, "https://b.example/final");
  assert.equal(transport.requests.length, 2);
  assert.equal(transport.requests[0]?.headers.authorization, "Bearer secret");
  assert.equal(transport.requests[1]?.headers.authorization, undefined);
});

test("Egress 审计不记录查询参数并记录传输失败", async () => {
  const audit = new InMemoryEgressAuditStore();
  const env = broker(
    new StaticResolver({ "public.example": ["93.184.216.34"] }),
    new ScriptedTransport([new Error("network down")]),
    audit,
  ).broker;
  const lease = await env.authorize({
    url: "https://public.example/search?q=sensitive",
    mode: "internet",
    purpose: "web.fetch",
  }, new AbortController().signal);
  await assert.rejects(env.fetchAuthorized(lease.id, {
    url: lease.normalizedUrl,
    mode: "internet",
    purpose: "web.fetch",
  }, new AbortController().signal));
  const entries = await env.listAudit();
  assert.ok(entries.every(entry => !entry.redactedUrl.includes("sensitive")));
  assert.equal(entries.some(entry => entry.decision === "failed"), true);
});

test("WebFetch 提取 HTML 文本并限制输出长度", async () => {
  const env = broker(new StaticResolver({ "page.example": ["93.184.216.34"] }), new ScriptedTransport([
    response(200, "<html><head><title>Example</title><style>x</style></head><body><script>bad()</script><h1>Hello &amp; World</h1></body></html>", {
      "content-type": "text/html; charset=utf-8",
    }),
  ])).broker;
  const service = new WebFetchService(env);
  const prepared = await service.prepare("https://page.example/", "internet", 8, new AbortController().signal);
  const result = await service.execute(prepared, new AbortController().signal);
  assert.equal(result.title, "Example");
  assert.equal(result.text, "Hello & ");
  assert.equal(result.truncated, true);
});

test("WebSearch 使用受控 Provider 且验证结果数量", async () => {
  const env = broker(new StaticResolver({ "search.example": ["93.184.216.34"] }), new ScriptedTransport([
    response(200, JSON.stringify({ results: [{ title: "A", url: "https://a.example/", snippet: "S" }] }), {
      "content-type": "application/json; charset=utf-8",
    }),
  ])).broker;
  const service = new WebSearchService(env, new JsonSearchProvider());
  const prepared = await service.prepare("agent", 5, "internet", new AbortController().signal);
  const result = await service.execute(prepared, new AbortController().signal);
  assert.equal(result.provider, "test-search");
  assert.equal(result.results[0]?.title, "A");
});

test("Web Tool 权限拒绝路径会释放单次出口授权", async () => {
  const env = broker(new StaticResolver({ "page.example": ["93.184.216.34"] }), new ScriptedTransport([])).broker;
  const tools = createWebTools({
    fetch: new WebFetchService(env),
    search: new WebSearchService(env, new JsonSearchProvider()),
    getNetworkMode: () => "internet",
  });
  const tool = tools.find(item => item.manifest.name === "webfetch");
  if (tool === undefined) throw new Error("WebFetch Tool 未注册");
  const input = tool.validate({ url: "https://page.example/" });
  const context: ToolInspectionContext = {
    sessionId: "session",
    workspaceId: "workspace",
    toolCallId: "call",
    signal: new AbortController().signal,
  };
  await tool.inspect(input, context);
  await tool.releaseInspection?.(input, context);
  const execution: ToolExecutionContext = {
    ...context,
    reportProgress: async () => {},
  };
  await assert.rejects(tool.execute(input, execution));
});

test("Browser Runtime 拒绝不经过 Broker Proxy 的驱动", () => {
  const env = browserEnvironment();
  const directDriver = { ...env.driver, egressEnforcement: "direct" } as unknown as BrowserDriver;
  assert.throws(() => new BrowserRuntime(directDriver, env.broker, new IncrementingIdGenerator(), {
    proxyServerUrl: "http://127.0.0.1:7777",
    maxSessions: 1,
    viewport: { width: 800, height: 600 },
    proxyVerifier: acceptingProxyVerifier,
  }));
});

test("Browser 动作绑定当前 Snapshot 并要求动作后证据", async () => {
  const env = browserEnvironment();
  const session = await env.runtime.create({ workspaceId: "workspace", networkMode: "internet", locale: "zh-CN" }, new AbortController().signal);
  const snapshot = await env.runtime.navigate(session.id, "https://site.example/", new AbortController().signal);
  await assert.rejects(env.runtime.click(session.id, { snapshotId: "stale", elementId: "button-1" }, new AbortController().signal));
  const result = await env.runtime.click(session.id, { snapshotId: snapshot.id, elementId: "button-1" }, new AbortController().signal);
  assert.equal(result.verified, true);
  assert.equal(result.afterSnapshot.id === snapshot.id, false);
  const screenshot = await env.runtime.screenshot(session.id, new AbortController().signal);
  assert.equal(screenshot.snapshotId, result.afterSnapshot.id);
});

test("Browser 与 Web Typed IPC 发布经过验证的会话和 Snapshot", async () => {
  const browserEnv = browserEnvironment();
  const fetchBroker = broker(new StaticResolver({
    "page.example": ["93.184.216.34"],
    "search.example": ["93.184.216.35"],
  }), new ScriptedTransport([
    response(200, "hello", { "content-type": "text/plain; charset=utf-8" }),
  ])).broker;
  const [clientTransport, serverTransport] = createInMemoryTransportPair();
  const client = new TypedIpcClient(clientTransport);
  const server = new TypedIpcServer(serverTransport);
  const browserBridge = new BrowserIpcBridge(server, browserEnv.runtime);
  const webBridge = new WebIpcBridge(
    server,
    fetchBroker,
    new WebFetchService(fetchBroker),
    new WebSearchService(fetchBroker, new JsonSearchProvider()),
  );
  browserBridge.start();
  webBridge.start();
  const changed: string[] = [];
  client.onEvent("browser.session.changed", session => changed.push(session.status));
  const created = await client.request("browser.create", {
    workspaceId: "workspace",
    networkMode: "internet",
    locale: "zh-CN",
  });
  const snapshot = await client.request("browser.navigate", {
    browserSessionId: created.id,
    url: "https://site.example/",
  });
  const fetched = await client.request("web.fetch", {
    url: "https://page.example/",
    mode: "internet",
    maxChars: 100,
  });
  assert.equal(snapshot.title, "Test Page");
  assert.equal(fetched.text, "hello");
  assert.deepEqual(changed, ["ready", "ready"]);
  browserBridge.dispose();
  webBridge.dispose();
  client.dispose();
  server.dispose();
});

test("WorkbenchController 只通过 Typed IPC 管理浏览器", async () => {
  const env = browserEnvironment();
  const [clientTransport, serverTransport] = createInMemoryTransportPair();
  const client = new TypedIpcClient(clientTransport);
  const server = new TypedIpcServer(serverTransport);
  const bridge = new BrowserIpcBridge(server, env.runtime);
  bridge.start();
  const controller = new WorkbenchController(client);
  controller.start();
  const session = await controller.createBrowser("workspace", "internet", "zh-CN");
  await controller.navigateBrowser(session.id, "https://site.example/");
  assert.equal(controller.getState().browserSessions[0]?.status, "ready");
  assert.equal(controller.getState().browserSnapshot?.title, "Test Page");
  controller.dispose();
  bridge.dispose();
  client.dispose();
  server.dispose();
});

test("IPC 边界拒绝缺少动作证据的 Browser 消息", () => {
  assert.equal(isIpcMessage({
    kind: "request",
    id: "request-1",
    method: "browser.click",
    params: { browserSessionId: "browser-1", elementId: "button-1" },
  }), false);
  assert.equal(isIpcMessage({
    kind: "event",
    method: "browser.snapshot.changed",
    payload: { id: "snapshot", sessionId: "browser", url: "https://example.com", title: "x", text: "x", elements: [], sha256: "bad", createdAt: "now" },
  }), false);
});


test("IPv6 字面量去除 URL 方括号并拒绝云元数据地址", async () => {
  const loopbackResolver = new StaticResolver({ "::1": ["::1"] });
  const offline = broker(loopbackResolver, new ScriptedTransport([])).broker;
  const lease = await offline.authorize({
    url: "http://[::1]/health",
    mode: "offline",
    purpose: "web.fetch",
  }, new AbortController().signal);
  assert.equal(lease.hostname, "::1");

  const metadata = broker(new StaticResolver({ "metadata.example": ["169.254.169.254"] }), new ScriptedTransport([])).broker;
  await assert.rejects(metadata.authorize({
    url: "http://metadata.example/latest/meta-data/",
    mode: "internet",
    purpose: "web.fetch",
  }, new AbortController().signal));
});

test("SearXNG Provider 生成固定 JSON 请求并严格解析结果", () => {
  const provider = new SearxngJsonSearchProvider({
    endpoint: "https://search.example/search",
    language: "zh-CN",
    categories: ["general", "it"],
  });
  const request = provider.prepare("agent runtime", 3);
  const url = new URL(request.url);
  assert.equal(url.searchParams.get("format"), "json");
  assert.equal(url.searchParams.get("q"), "agent runtime");
  const results = provider.parse(JSON.stringify({
    results: [{ title: "Result", url: "https://example.com/a", content: "Snippet", engine: "engine" }],
  }), 3);
  assert.equal(results[0]?.source, "engine");
  assert.throws(() => provider.parse('{"results":[{"title":"x","url":"javascript:alert(1)","content":"x"}]}', 3));
});

test("受控下载清理文件名并只写入 Artifact 根目录", async () => {
  const root = await mkdtemp(join(tmpdir(), "ai-ide-download-"));
  try {
    const transport = new ScriptedTransport([
      response(200, "artifact-content", {
        "content-type": "application/octet-stream",
        "content-disposition": "attachment; filename=../../escape.txt",
      }),
    ]);
    const env = broker(new StaticResolver({ "download.example": ["93.184.216.34"] }), transport).broker;
    const service = new WebDownloadService(
      env,
      new FileSystemDownloadArtifactStore(root, new IncrementingIdGenerator()),
    );
    const prepared = await service.prepare(
      "workspace-1",
      "https://download.example/file.bin",
      "internet",
      1024,
      new AbortController().signal,
    );
    const artifact = await service.execute(prepared, new AbortController().signal);
    assert.equal(artifact.fileName, "escape.txt");
    assert.equal(artifact.relativePath.startsWith("workspace-1/"), true);
    assert.equal(await readFile(join(root, artifact.relativePath), "utf8"), "artifact-content");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("下载 IPC 在未配置 Store 时明确拒绝，不静默写入", async () => {
  const fetchBroker = broker(new StaticResolver({
    "page.example": ["93.184.216.34"],
    "search.example": ["93.184.216.35"],
  }), new ScriptedTransport([])).broker;
  const [clientTransport, serverTransport] = createInMemoryTransportPair();
  const client = new TypedIpcClient(clientTransport);
  const server = new TypedIpcServer(serverTransport);
  const bridge = new WebIpcBridge(
    server,
    fetchBroker,
    new WebFetchService(fetchBroker),
    new WebSearchService(fetchBroker, new JsonSearchProvider()),
  );
  bridge.start();
  await assert.rejects(client.request("web.download", {
    workspaceId: "workspace",
    url: "https://page.example/file",
    mode: "internet",
    maxBytes: 1024,
  }), error => error instanceof Error && error.message.includes("受控下载服务未配置"));
  bridge.dispose();
  client.dispose();
  server.dispose();
});

test("Browser Runtime 拒绝重复元素 ID 和未验证动作结果", async () => {
  const resolver = new StaticResolver({ "site.example": ["93.184.216.34"] });
  const egress = broker(resolver, new ScriptedTransport([])).broker;
  const duplicateDriver: BrowserDriver = {
    kind: "duplicate-driver",
    egressEnforcement: "broker-proxy",
    async create() {},
    async navigate(sessionId, url) {
      return {
        id: "snapshot-duplicate",
        sessionId,
        url,
        title: "x",
        text: "x",
        elements: [
          { id: "same", role: "button", name: "A", disabled: false },
          { id: "same", role: "button", name: "B", disabled: false },
        ],
        sha256: "a".repeat(64),
        createdAt: new Date().toISOString(),
      };
    },
    async snapshot() { throw new Error("unused"); },
    async screenshot() { throw new Error("unused"); },
    async click() { throw new Error("unused"); },
    async type() { throw new Error("unused"); },
    async close() {},
  };
  const runtime = new BrowserRuntime(duplicateDriver, egress, new IncrementingIdGenerator(), {
    proxyServerUrl: "http://127.0.0.1:7777",
    maxSessions: 1,
    viewport: { width: 800, height: 600 },
    proxyVerifier: acceptingProxyVerifier,
  });
  const session = await runtime.create({ workspaceId: "workspace", networkMode: "internet", locale: "zh-CN" }, new AbortController().signal);
  await assert.rejects(
    runtime.navigate(session.id, "https://site.example/", new AbortController().signal),
    error => error instanceof Error && error.message.includes("Snapshot 无效"),
  );
});


test("Node 固定 IP 传输执行真实本机请求并强制大小与取消限制", async () => {
  const server = createServer((request, response) => {
    if (request.url === "/large") {
      response.statusCode = 200;
      response.setHeader("content-type", "text/plain");
      response.end("x".repeat(256));
      return;
    }
    if (request.url === "/slow") {
      setTimeout(() => {
        response.statusCode = 200;
        response.end("late");
      }, 100);
      return;
    }
    response.statusCode = 200;
    response.setHeader("content-type", "text/plain");
    response.end("pinned-ok");
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("本机测试服务地址无效");
  const egress = new EgressBroker(
    new NodeDnsResolver(),
    new NodePinnedHttpTransport(),
    new InMemoryEgressAuditStore(),
    new IncrementingIdGenerator(),
    { allowedPorts: [address.port] },
  );
  try {
    const okUrl = `http://127.0.0.1:${address.port}/ok`;
    const okLease = await egress.authorize({ url: okUrl, mode: "offline", purpose: "web.fetch" }, new AbortController().signal);
    const ok = await egress.fetchAuthorized(okLease.id, {
      url: okUrl,
      mode: "offline",
      purpose: "web.fetch",
      maxResponseBytes: 64,
    }, new AbortController().signal);
    assert.equal(new TextDecoder().decode(ok.body), "pinned-ok");

    const largeUrl = `http://127.0.0.1:${address.port}/large`;
    const largeLease = await egress.authorize({ url: largeUrl, mode: "offline", purpose: "web.fetch" }, new AbortController().signal);
    await assert.rejects(egress.fetchAuthorized(largeLease.id, {
      url: largeUrl,
      mode: "offline",
      purpose: "web.fetch",
      maxResponseBytes: 32,
    }, new AbortController().signal));

    const slowUrl = `http://127.0.0.1:${address.port}/slow`;
    const slowLease = await egress.authorize({ url: slowUrl, mode: "offline", purpose: "web.fetch" }, new AbortController().signal);
    const controller = new AbortController();
    const pending = egress.fetchAuthorized(slowLease.id, {
      url: slowUrl,
      mode: "offline",
      purpose: "web.fetch",
      timeoutMs: 1000,
    }, controller.signal);
    controller.abort();
    await assert.rejects(pending);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error === undefined ? resolve() : reject(error)));
  }
});


test("Browser Runtime 在代理能力握手失败时不启动 Driver", async () => {
  const env = browserEnvironment();
  let createCalls = 0;
  const baseDriver: BrowserDriver = env.driver;
  const driver: BrowserDriver = {
    kind: baseDriver.kind,
    egressEnforcement: baseDriver.egressEnforcement,
    async create(request) {
      createCalls += 1;
      await baseDriver.create(request, new AbortController().signal);
    },
    navigate: (sessionId, url, signal) => baseDriver.navigate(sessionId, url, signal),
    snapshot: (sessionId, signal) => baseDriver.snapshot(sessionId, signal),
    screenshot: (sessionId, signal) => baseDriver.screenshot(sessionId, signal),
    click: (sessionId, target, signal) => baseDriver.click(sessionId, target, signal),
    type: (sessionId, target, text, signal) => baseDriver.type(sessionId, target, text, signal),
    close: sessionId => baseDriver.close(sessionId),
  };
  const runtime = new BrowserRuntime(driver, env.broker, new IncrementingIdGenerator(), {
    proxyServerUrl: "http://127.0.0.1:7777",
    maxSessions: 1,
    viewport: { width: 800, height: 600 },
    proxyVerifier: { async verify() { throw new Error("proxy unavailable"); } },
  });
  await assert.rejects(runtime.create(
    { workspaceId: "workspace", networkMode: "internet", locale: "zh-CN" },
    new AbortController().signal,
  ));
  assert.equal(createCalls, 0);
});


test("Browser Proxy 验证器校验本机能力握手", async () => {
  let serverUrl = "";
  const server = createServer((_request, response) => {
    response.statusCode = 200;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      protocolVersion: 1,
      healthy: true,
      enforcement: "egress-broker",
      serverUrl,
    }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("代理握手测试地址无效");
  serverUrl = `http://127.0.0.1:${address.port}/`;
  try {
    const verification = await new HttpBrowserProxyVerifier().verify(serverUrl, new AbortController().signal);
    assert.equal(verification.serverUrl, serverUrl);
    assert.equal(verification.enforcement, "egress-broker");
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error === undefined ? resolve() : reject(error)));
  }
});

test("Browser Runtime 接受方括号形式的本机 IPv6 Proxy URL", () => {
  const env = browserEnvironment();
  const runtime = new BrowserRuntime(env.driver, env.broker, new IncrementingIdGenerator(), {
    proxyServerUrl: "http://[::1]:7777",
    maxSessions: 1,
    viewport: { width: 800, height: 600 },
    proxyVerifier: acceptingProxyVerifier,
  });
  assert.ok(runtime instanceof BrowserRuntime);
});
