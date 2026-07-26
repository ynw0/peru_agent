import test from "node:test";
import assert from "node:assert/strict";
import { TypedIpcClient, TypedIpcServer } from "../src/ipc/channel.js";
import { IpcError } from "../src/ipc/errors.js";
import { IPC_PROTOCOL_VERSION } from "../src/ipc/protocol.js";
import { createInMemoryTransportPair } from "../src/ipc/transport.js";
import { isIpcMessage } from "../src/ipc/validation.js";
import { CODE_OSS_SOURCE_PIN, validateCodeOssSourcePin } from "../src/product/code-oss-source.js";
import { PRODUCT_MANIFEST, validateProductManifest } from "../src/product/product-manifest.js";
import { validateWorkbenchContainers, WORKBENCH_CONTAINERS } from "../src/workbench/contributions.js";
import {
  EMPTY_WORKBENCH_SNAPSHOT,
  projectWorkbenchSnapshot,
} from "../src/workbench/workbench-state.js";

test("Code OSS 固定版本清单必须有效", () => {
  validateCodeOssSourcePin(CODE_OSS_SOURCE_PIN);
  assert.equal(CODE_OSS_SOURCE_PIN.tag, "1.130.0");
});

test("独立产品清单不能使用 Microsoft 产品品牌", () => {
  validateProductManifest(PRODUCT_MANIFEST);
  assert.throws(() => validateProductManifest({
    ...PRODUCT_MANIFEST,
    productName: "Visual Studio Code AI",
  }));
});

test("Workbench 四个容器 ID 和排序必须唯一", () => {
  validateWorkbenchContainers(WORKBENCH_CONTAINERS);
  assert.equal(WORKBENCH_CONTAINERS.length, 4);
});

test("Typed IPC 可以完成初始化请求", async () => {
  const [clientTransport, serverTransport] = createInMemoryTransportPair();
  const server = new TypedIpcServer(serverTransport);
  server.registerHandler("runtime.initialize", request => ({
    runtimeId: request.clientId,
    protocolVersion: IPC_PROTOCOL_VERSION,
    enabledCapabilities: ["workspace.read"],
  }));
  const client = new TypedIpcClient(clientTransport);

  const result = await client.request("runtime.initialize", {
    protocolVersion: IPC_PROTOCOL_VERSION,
    clientId: "test-client",
    locale: "zh-CN",
    permissionMode: "default",
    networkMode: "offline",
  }, { timeoutMs: 1_000 });

  assert.equal(result.runtimeId, "test-client");
  client.dispose();
  server.dispose();
});

test("未注册 IPC 方法返回稳定错误", async () => {
  const [clientTransport, serverTransport] = createInMemoryTransportPair();
  const server = new TypedIpcServer(serverTransport);
  const client = new TypedIpcClient(clientTransport);

  await assert.rejects(
    client.request("session.create", { workspaceId: "workspace" }, { timeoutMs: 1_000 }),
    (error: unknown) => error instanceof IpcError && error.code === "HANDLER_NOT_REGISTERED",
  );

  client.dispose();
  server.dispose();
});

test("IPC 边界拒绝未知方法", () => {
  assert.equal(isIpcMessage({
    kind: "request",
    id: "1",
    method: "unknown.method",
    params: {},
  }), false);
});

test("Workbench 状态可以通过事件重放恢复", () => {
  const created = projectWorkbenchSnapshot(EMPTY_WORKBENCH_SNAPSHOT, {
    type: "session.created",
    sessionId: "session-1",
  });
  const planned = projectWorkbenchSnapshot(created, {
    type: "plan.created",
    sessionId: "session-1",
    confidence: 92,
    affectedFiles: ["src/app.ts"],
  });
  const permission = projectWorkbenchSnapshot(planned, {
    type: "permission.requested",
    sessionId: "session-1",
    requestId: "permission-1",
    capabilities: ["workspace.write"],
  });
  const resolved = projectWorkbenchSnapshot(permission, {
    type: "permission.resolved",
    sessionId: "session-1",
    requestId: "permission-1",
    decision: "deny",
  });

  assert.equal(planned.lastPlanConfidence, 92);
  assert.equal(permission.pendingPermissions.length, 1);
  assert.equal(resolved.pendingPermissions.length, 0);
});

test("Typed IPC 请求超时后返回明确错误", async () => {
  const [clientTransport] = createInMemoryTransportPair();
  const client = new TypedIpcClient(clientTransport);

  await assert.rejects(
    client.request("session.create", { workspaceId: "workspace" }, { timeoutMs: 20 }),
    (error: unknown) => error instanceof IpcError && error.code === "REQUEST_TIMEOUT",
  );

  client.dispose();
});

test("Typed IPC 支持 AbortSignal 主动取消", async () => {
  const [clientTransport] = createInMemoryTransportPair();
  const client = new TypedIpcClient(clientTransport);
  const controller = new AbortController();

  const pending = client.request(
    "session.create",
    { workspaceId: "workspace" },
    { timeoutMs: 1_000, signal: controller.signal },
  );
  controller.abort();

  await assert.rejects(
    pending,
    (error: unknown) => error instanceof IpcError && error.code === "REQUEST_ABORTED",
  );

  client.dispose();
});
