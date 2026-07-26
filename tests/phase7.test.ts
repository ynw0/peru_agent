import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  CompletionEngine,
  validateCompletionCapability,
  type CompletionCapability,
} from "../src/completion-engine.js";
import { buildCompletionRequest, estimateTokens } from "../src/completion/context-builder.js";
import { CompletionCache } from "../src/completion/cache.js";
import { CompletionContextCache } from "../src/completion/context-cache.js";
import { CompletionController } from "../src/completion/completion-controller.js";
import { benchmarkCompletion, evaluateCompletionPerformance } from "../src/completion/benchmark.js";
import { OpenAiFimProvider, type FetchLike } from "../src/completion/openai-fim-provider.js";
import type {
  CompletionProvider,
  CompletionProviderEvent,
  CompletionProviderProbeResult,
  CompletionRequest,
} from "../src/completion/types.js";
import { TypedIpcClient, TypedIpcServer } from "../src/ipc/channel.js";
import { createInMemoryTransportPair } from "../src/ipc/transport.js";
import { CompletionRuntimeIpcBridge } from "../src/runtime/completion-ipc-bridge.js";

const CAPABILITY: CompletionCapability = {
  fim: true,
  streaming: true,
  cancellation: true,
  maxPrefixTokens: 128,
  maxSuffixTokens: 64,
};

class FixedCompletionProvider implements CompletionProvider {
  public readonly id = "fixed-fim";
  public readonly capability = CAPABILITY;
  public calls = 0;
  public aborted = 0;

  public constructor(private readonly output = "value") {}

  public async *stream(_request: CompletionRequest, signal: AbortSignal): AsyncIterable<CompletionProviderEvent> {
    this.calls += 1;
    if (this.output === "WAIT") {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 5_000);
        signal.addEventListener("abort", () => {
          clearTimeout(timer);
          this.aborted += 1;
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        }, { once: true });
      });
      return;
    }
    if (signal.aborted) {
      const error = new Error("aborted");
      error.name = "AbortError";
      throw error;
    }
    yield { type: "text.delta", delta: this.output };
    yield { type: "response.completed", finishReason: "stop", outputTokens: 1 };
  }

  public async probe(_signal: AbortSignal): Promise<CompletionProviderProbeResult> {
    return {
      capability: this.capability,
      modelId: this.id,
      firstTokenLatencyMs: 1,
      totalLatencyMs: 2,
      cancellationLatencyMs: 1,
    };
  }
}

function input(text = "const result = ;\n", offset = 15) {
  return {
    documentUri: "file:///workspace/app.ts",
    languageId: "typescript",
    version: 1,
    offset,
    text,
    enrichment: {
      imports: ["import { value } from './value';"],
      diagnostics: ["缺少表达式"],
      projectRules: ["使用严格类型"],
    },
  } as const;
}

test("Completion Capability 拒绝不支持 FIM、流式或取消的模型", () => {
  assert.throws(() => validateCompletionCapability({ ...CAPABILITY, fim: false }));
  assert.throws(() => validateCompletionCapability({ ...CAPABILITY, streaming: false }));
  assert.throws(() => validateCompletionCapability({ ...CAPABILITY, cancellation: false }));
});

test("Completion Context 只保留预算内 Prefix、Suffix 与受限元数据", () => {
  const source = `${"a".repeat(1_000)}CURSOR${"b".repeat(1_000)}`;
  const request = buildCompletionRequest("request", {
    documentUri: "file:///large.ts",
    languageId: "typescript",
    version: 3,
    offset: 1_006,
    text: source,
    enrichment: { imports: Array.from({ length: 50 }, (_, index) => `import-${index}`) },
  }, { ...CAPABILITY, maxPrefixTokens: 40, maxSuffixTokens: 30 }, {
    reservedMetadataTokens: 10,
    maxOutputTokens: 16,
  });

  assert.ok(estimateTokens(request.prefix) <= 30);
  assert.ok(estimateTokens(request.suffix) <= 20);
  assert.ok(request.metadata.imports.length <= 32);
  assert.ok(estimateTokens(request.metadata.imports.join("")) <= 10);
  assert.equal(request.prefix.endsWith("CURSOR"), true);
});


test("Completion Context Cache 只复用精确文档版本", () => {
  const cache = new CompletionContextCache(1_000, 4);
  cache.set("file:///app.ts", 1, { diagnostics: ["version-1"] }, 100);
  assert.deepEqual(cache.get("file:///app.ts", 1, 200)?.diagnostics, ["version-1"]);
  assert.equal(cache.get("file:///app.ts", 2, 200), undefined);
});

test("Completion Engine 未探测前拒绝启用，探测后缓存候选并记录接受率", async () => {
  const provider = new FixedCompletionProvider("42");
  const engine = new CompletionEngine(provider, {
    requestTimeoutMs: 1_000,
    cache: new CompletionCache(8, 5_000),
  });
  await assert.rejects(engine.complete(input()));
  await engine.probeAndEnable(new AbortController().signal);

  const first = await engine.complete(input());
  const second = await engine.complete(input());
  const acceptedRequestId = first?.requestId ?? "missing";
  engine.recordAccepted(acceptedRequestId);
  engine.recordAccepted(acceptedRequestId);
  assert.throws(() => engine.recordAccepted("unknown-request"));

  assert.equal(first?.text, "42");
  assert.equal(first?.cacheHit, false);
  assert.equal(second?.cacheHit, true);
  assert.equal(provider.calls, 1);
  assert.equal(engine.getMetrics().cacheHits, 1);
  assert.equal(engine.getMetrics().accepted, 1);
});

test("Completion Engine 对同一文档采用 latest-wins 并终止旧请求", async () => {
  class LatestProvider extends FixedCompletionProvider {
    private index = 0;
    public override async *stream(request: CompletionRequest, signal: AbortSignal): AsyncIterable<CompletionProviderEvent> {
      this.index += 1;
      if (this.index === 1) {
        yield* new FixedCompletionProvider("WAIT").stream(request, signal);
        return;
      }
      yield { type: "text.delta", delta: "newValue" };
      yield { type: "response.completed", finishReason: "stop" };
    }
  }
  const provider = new LatestProvider();
  const engine = new CompletionEngine(provider, { requestTimeoutMs: 2_000 });
  await engine.probeAndEnable(new AbortController().signal);
  const first = engine.complete(input("const x = ;", 10));
  await Promise.resolve();
  const second = engine.complete({ ...input("const x = ;", 10), version: 2 });

  await assert.rejects(first, error => error instanceof Error && error.name === "AbortError");
  assert.equal((await second)?.text, "newValue");
  assert.equal(engine.getMetrics().cancellations, 1);
});

test("Typed IPC 的 AbortSignal 会传播到 Completion Server Handler", async () => {
  const provider = new FixedCompletionProvider("WAIT");
  const engine = new CompletionEngine(provider, { requestTimeoutMs: 10_000 });
  await engine.probeAndEnable(new AbortController().signal);
  const [clientTransport, serverTransport] = createInMemoryTransportPair();
  const client = new TypedIpcClient(clientTransport);
  const server = new TypedIpcServer(serverTransport);
  const bridge = new CompletionRuntimeIpcBridge(engine, server);
  bridge.start();
  const controller = new AbortController();
  const pending = client.request("completion.request", { input: input() }, {
    timeoutMs: 5_000,
    signal: controller.signal,
  });
  await Promise.resolve();
  controller.abort();

  await assert.rejects(pending, error => error instanceof Error && error.message.includes("已取消"));
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(provider.aborted, 1);

  bridge.dispose();
  client.dispose();
  server.dispose();
});

test("Completion IPC 提供探测、请求、指标、接受和清缓存", async () => {
  const engine = new CompletionEngine(new FixedCompletionProvider("done"), { requestTimeoutMs: 1_000 });
  const [clientTransport, serverTransport] = createInMemoryTransportPair();
  const client = new TypedIpcClient(clientTransport);
  const server = new TypedIpcServer(serverTransport);
  const bridge = new CompletionRuntimeIpcBridge(engine, server);
  bridge.start();

  const probe = await client.request("completion.probe", {}, { timeoutMs: 1_000 });
  const result = await client.request("completion.request", { input: input() }, { timeoutMs: 1_000 });
  await client.request("completion.accepted", { requestId: result.candidate?.requestId ?? "missing" }, { timeoutMs: 1_000 });
  const metrics = await client.request("completion.metrics", {}, { timeoutMs: 1_000 });
  const cleared = await client.request("completion.clearCache", {}, { timeoutMs: 1_000 });

  assert.equal(probe.modelId, "fixed-fim");
  assert.equal(result.candidate?.text, "done");
  assert.equal(metrics.accepted, 1);
  assert.equal(cleared.cleared, true);

  bridge.dispose();
  client.dispose();
  server.dispose();
});


test("CompletionController 只通过 Typed IPC 访问补全 Runtime", async () => {
  const engine = new CompletionEngine(new FixedCompletionProvider("controller"), { requestTimeoutMs: 1_000 });
  const [clientTransport, serverTransport] = createInMemoryTransportPair();
  const client = new TypedIpcClient(clientTransport);
  const server = new TypedIpcServer(serverTransport);
  const bridge = new CompletionRuntimeIpcBridge(engine, server);
  bridge.start();
  const controller = new CompletionController(client, 1_000);
  await controller.probe();
  const candidate = await controller.provideCompletion(input(), new AbortController().signal);
  await controller.recordAccepted(candidate?.requestId ?? "missing");
  assert.equal(candidate?.text, "controller");
  assert.equal((await controller.metrics()).accepted, 1);
  bridge.dispose();
  client.dispose();
  server.dispose();
});

test("OpenAI FIM Provider 使用 suffix 协议并解析 SSE", async () => {
  let requestBody: Record<string, unknown> | undefined;
  const fetcher: FetchLike = async (_url, init) => {
    requestBody = JSON.parse(String(init.body)) as Record<string, unknown>;
    const encoder = new TextEncoder();
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"choices":[{"text":"42","finish_reason":null}]}\n\n'));
        controller.enqueue(encoder.encode('data: {"choices":[{"text":"","finish_reason":"stop"}],"usage":{"completion_tokens":1}}\n\n'));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    }), { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  const provider = new OpenAiFimProvider({
    baseUrl: "http://localhost:1234/v1",
    completionsPath: "/completions",
    apiKeyReference: "credential/local-completion",
    model: "fim-model",
    capability: CAPABILITY,
    requestFormat: { kind: "openai-suffix" },
    temperature: 0,
    stop: ["<END>"],
  }, { resolve: async () => "credential-value" }, fetcher);
  const events: CompletionProviderEvent[] = [];
  for await (const event of provider.stream(buildCompletionRequest("request", input(), CAPABILITY), new AbortController().signal)) {
    events.push(event);
  }

  assert.equal(requestBody?.suffix, ";\n");
  assert.equal(requestBody?.stream, true);
  assert.equal(events[0]?.type, "text.delta");
  assert.equal(events[1]?.type, "response.completed");
});

test("Completion Benchmark 输出确定的 P50/P95 结构", async () => {
  const engine = new CompletionEngine(new FixedCompletionProvider("x"), { requestTimeoutMs: 1_000 });
  await engine.probeAndEnable(new AbortController().signal);
  const result = await benchmarkCompletion(engine, [input(), { ...input(), version: 2 }]);
  assert.equal(result.iterations, 2);
  assert.ok(result.p50Ms >= 0);
  assert.ok(result.p95Ms >= result.p50Ms);
  assert.equal(evaluateCompletionPerformance(result, 1, { p50Ms: 10_000, p95Ms: 10_000, cancellationMs: 20 }).passed, true);
});

test("Code OSS Inline Completion 只通过 Bridge 请求并限制文档上下文窗口", async () => {
  const provider = await readFile(
    "overlays/code-oss/src/vs/workbench/contrib/independentAiIde/browser/independentAiIdeInlineCompletion.ts",
    "utf8",
  );
  const bridge = await readFile(
    "overlays/code-oss/src/vs/workbench/contrib/independentAiIde/common/independentAiIdeCompletionBridge.ts",
    "utf8",
  );
  assert.match(provider, /inlineCompletionsProvider\.register/);
  assert.match(provider, /PREFIX_LINE_LIMIT = 200/);
  assert.match(provider, /token\.onCancellationRequested/);
  assert.match(provider, /recordAccepted/);
  assert.equal(/node:fs|node:child_process|fetch\(/.test(provider), false);
  assert.equal(/node:fs|node:child_process|fetch\(/.test(bridge), false);
});
