import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { IncrementingIdGenerator } from "../src/agent/id-generator.js";
import { InMemoryComputerUseAuditStore } from "../src/computer-use/audit.js";
import { WindowsUiAutomationBrokerClient } from "../src/computer-use/broker-client.js";
import { validateComputerUiSnapshot } from "../src/computer-use/broker-validation.js";
import type { ComputerUseBrokerTransport } from "../src/computer-use/broker-transport.js";
import type { ComputerBrokerMethod, ComputerBrokerRequestMap } from "../src/computer-use/broker-protocol.js";
import {
  evaluateComputerCertification,
  identityFingerprint,
  validateCertifiedApplicationManifest,
} from "../src/computer-use/certification.js";
import { createComputerUseTools } from "../src/computer-use/computer-tools.js";
import { ComputerUseRuntime } from "../src/computer-use/runtime.js";
import type {
  CertifiedApplicationManifest,
  ComputerActionResult,
  ComputerUiSnapshot,
  RunningApplicationIdentity,
} from "../src/computer-use/types.js";
import { TypedIpcClient, TypedIpcServer } from "../src/ipc/channel.js";
import { IPC_PROTOCOL_VERSION } from "../src/ipc/protocol.js";
import { createInMemoryTransportPair } from "../src/ipc/transport.js";
import { isIpcMessage } from "../src/ipc/validation.js";
import { decidePermission } from "../src/permission-engine.js";
import { ComputerUseIpcBridge } from "../src/runtime/computer-use-ipc-bridge.js";
import { WorkbenchController } from "../src/workbench/workbench-controller.js";

const APP_HASH = "a".repeat(64);
const MANIFEST: CertifiedApplicationManifest = {
  id: "certified-editor",
  displayName: "Certified Editor",
  executableNames: ["editor.exe"],
  allowedPathRoots: ["C:\\Program Files\\Certified Editor"],
  publisherSubjects: ["CN=Certified Publisher"],
  signerThumbprints: ["A".repeat(40)],
  allowedFileSha256: [APP_HASH],
  versionPattern: "^1\\.2\\.[0-9]+$",
  allowedWindowClasses: ["CertifiedEditorWindow"],
  allowedActions: ["click", "type", "shortcut"],
  allowedShortcuts: ["CTRL+S", "CTRL+F"],
};

const IDENTITY: RunningApplicationIdentity = {
  processId: 4242,
  executablePath: "C:\\Program Files\\Certified Editor\\editor.exe",
  executableName: "editor.exe",
  publisherSubject: "CN=Certified Publisher",
  signerThumbprint: "A".repeat(40),
  version: "1.2.3",
  fileSha256: APP_HASH,
  windowHandle: "0x1234",
  windowTitle: "notes.txt - Certified Editor",
  windowClass: "CertifiedEditorWindow",
  integrityLevel: "medium",
  secureDesktop: false,
};

function snapshot(id: string, identity: RunningApplicationIdentity = IDENTITY): ComputerUiSnapshot {
  return {
    id,
    identity,
    certification: { status: "inspect-only", allowedActions: [], allowedShortcuts: [], reasons: ["Broker placeholder"] },
    elements: [
      {
        id: "button-save",
        runtimeId: [1, 2, 3],
        controlType: "ControlType.Button",
        role: "button",
        name: "Save",
        automationId: "saveButton",
        className: "Button",
        bounds: { x: 10, y: 10, width: 80, height: 24 },
        enabled: true,
        offscreen: false,
        focusable: true,
        hasKeyboardFocus: false,
        isPassword: false,
        patterns: ["invoke"],
      },
      {
        id: "editor-text",
        runtimeId: [1, 2, 4],
        controlType: "ControlType.Edit",
        role: "edit",
        name: "Document",
        automationId: "documentText",
        className: "Edit",
        bounds: { x: 10, y: 50, width: 500, height: 300 },
        enabled: true,
        offscreen: false,
        focusable: true,
        hasKeyboardFocus: true,
        isPassword: false,
        patterns: ["value", "text"],
      },
      {
        id: "password",
        runtimeId: [1, 2, 5],
        controlType: "ControlType.Edit",
        role: "edit",
        name: "Password",
        automationId: "passwordBox",
        className: "Edit",
        bounds: { x: 10, y: 360, width: 200, height: 24 },
        enabled: true,
        offscreen: false,
        focusable: true,
        hasKeyboardFocus: false,
        isPassword: true,
        patterns: ["value"],
      },
    ],
    focusedElementId: "editor-text",
    sha256: id === "snapshot-after" ? "c".repeat(64) : "b".repeat(64),
    createdAt: "2026-07-27T00:00:00.000Z",
  };
}

class FakeComputerBrokerTransport implements ComputerUseBrokerTransport {
  public readonly requests: { method: ComputerBrokerMethod; params: unknown }[] = [];
  public features = {
    uiAutomationTree: true,
    authenticodeIdentity: true,
    windowProcessBinding: true,
    screenshotEvidence: true,
    invokePattern: true,
    valuePattern: true,
    keyboardInput: true,
    secureDesktopDetection: true,
    postActionVerification: true,
    utf8Protocol: true,
  };
  public windows: RunningApplicationIdentity[] = [IDENTITY];
  public currentSnapshot = snapshot("snapshot-before");

  public async request<Method extends ComputerBrokerMethod>(
    method: Method,
    params: ComputerBrokerRequestMap[Method]["params"],
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (signal?.aborted === true) throw new Error("aborted");
    this.requests.push({ method, params });
    switch (method) {
      case "hello": return { protocolVersion: 1, brokerVersion: "test", platform: "windows", architecture: "x64", features: this.features };
      case "computer.list-windows": return structuredClone(this.windows);
      case "computer.inspect": return structuredClone(this.currentSnapshot);
      case "computer.screenshot": return {
        snapshotId: this.currentSnapshot.id,
        windowHandle: this.currentSnapshot.identity.windowHandle,
        mimeType: "image/png",
        base64: "cG5n",
        byteLength: 3,
        sha256: "d".repeat(64),
      };
      case "computer.action": {
        const request = params as ComputerBrokerRequestMap["computer.action"]["params"];
        const after = snapshot("snapshot-after");
        const result: ComputerActionResult = {
          actionId: request.actionId,
          action: request.action,
          verified: true,
          beforeSnapshotId: request.snapshotId,
          afterSnapshot: after,
          receiptSha256: "e".repeat(64),
        };
        this.currentSnapshot = after;
        return result;
      }
    }
  }

  public dispose(): void {}
}

async function runtime(transport = new FakeComputerBrokerTransport(), manifests = [MANIFEST]) {
  const broker = new WindowsUiAutomationBrokerClient(transport);
  const audit = new InMemoryComputerUseAuditStore();
  const value = new ComputerUseRuntime(broker, manifests, audit, new IncrementingIdGenerator());
  await value.initialize();
  return { value, transport, audit };
}

test("认证清单必须绑定路径、签名、文件哈希和完整版本正则", () => {
  validateCertifiedApplicationManifest(MANIFEST);
  assert.throws(() => validateCertifiedApplicationManifest({ ...MANIFEST, versionPattern: "1\\.2" }));
  assert.throws(() => validateCertifiedApplicationManifest({ ...MANIFEST, allowedFileSha256: [] }));
});

test("同名应用只要签名、路径或哈希不匹配就只能检查", () => {
  const certified = evaluateComputerCertification(IDENTITY, [MANIFEST]);
  const lookalike = evaluateComputerCertification({ ...IDENTITY, signerThumbprint: "B".repeat(40) }, [MANIFEST]);
  assert.equal(certified.status, "certified");
  assert.equal(lookalike.status, "inspect-only");
});

test("安全桌面与高完整性窗口不能获得交互认证", () => {
  assert.equal(evaluateComputerCertification({ ...IDENTITY, secureDesktop: true }, [MANIFEST]).status, "blocked");
  assert.equal(evaluateComputerCertification({ ...IDENTITY, integrityLevel: "high" }, [MANIFEST]).status, "inspect-only");
});

test("未认证应用仍可检查 UI Tree，但不能准备点击", async () => {
  const fake = new FakeComputerBrokerTransport();
  fake.windows = [{ ...IDENTITY, fileSha256: "f".repeat(64) }];
  fake.currentSnapshot = snapshot("snapshot-before", fake.windows[0]!);
  const { value } = await runtime(fake);
  const inspected = await value.inspect("0x1234");
  assert.equal(inspected.certification.status, "inspect-only");
  assert.throws(() => value.prepareClick({ snapshotId: inspected.id, elementId: "button-save", reason: "保存" }));
});

test("认证点击绑定身份、Snapshot 和元素证据，并且动作只能执行一次", async () => {
  const { value, transport } = await runtime();
  const inspected = await value.inspect("0x1234");
  const action = value.prepareClick({ snapshotId: inspected.id, elementId: "button-save", reason: "保存文档" });
  assert.equal(action.identityFingerprint, identityFingerprint(IDENTITY));
  const result = await value.execute(action.id);
  assert.equal(result.verified, true);
  assert.equal(transport.requests.some(item => item.method === "computer.action"), true);
  await assert.rejects(value.execute(action.id));
});

test("密码元素、敏感窗口和未批准快捷键被拒绝", async () => {
  const { value } = await runtime();
  const inspected = await value.inspect("0x1234");
  assert.throws(() => value.prepareType({ snapshotId: inspected.id, elementId: "password", text: "secret", reason: "登录" }));
  assert.throws(() => value.prepareShortcut({ snapshotId: inspected.id, shortcut: "CTRL+P", reason: "打印" }));

  const sensitiveTransport = new FakeComputerBrokerTransport();
  sensitiveTransport.windows = [{ ...IDENTITY, windowTitle: "Windows Security - Password" }];
  sensitiveTransport.currentSnapshot = snapshot("sensitive", sensitiveTransport.windows[0]!);
  const sensitive = await runtime(sensitiveTransport);
  const sensitiveSnapshot = await sensitive.value.inspect("0x1234");
  assert.throws(() => sensitive.value.prepareClick({ snapshotId: sensitiveSnapshot.id, elementId: "button-save", reason: "操作" }));
});

test("Broker 缺少任一强制能力时 Computer Use 不启用", async () => {
  const transport = new FakeComputerBrokerTransport();
  transport.features.postActionVerification = false;
  const client = new WindowsUiAutomationBrokerClient(transport);
  await assert.rejects(client.initialize());
});

test("Broker Snapshot 边界拒绝非有限坐标和负尺寸", () => {
  const invalidCoordinate = structuredClone(snapshot("invalid-coordinate")) as unknown as { elements: { bounds: { x: number } }[] };
  invalidCoordinate.elements[0]!.bounds.x = Number.NaN;
  assert.throws(() => validateComputerUiSnapshot(invalidCoordinate));

  const invalidSize = structuredClone(snapshot("invalid-size")) as unknown as { elements: { bounds: { width: number } }[] };
  invalidSize.elements[0]!.bounds.width = -1;
  assert.throws(() => validateComputerUiSnapshot(invalidSize));
});

test("Computer Use 交互 Tool 必须声明 computer.interact 并在拒绝时释放动作", async () => {
  const { value } = await runtime();
  const inspected = await value.inspect("0x1234");
  const click = createComputerUseTools(value).find(tool => tool.manifest.name === "ComputerClick");
  assert.ok(click !== undefined);
  assert.deepEqual(click!.manifest.capabilities, ["computer.interact"]);
  assert.equal(decidePermission("default", "computer.interact", true), "ask");
  const input = click!.validate({ snapshotId: inspected.id, elementId: "button-save", reason: "保存" });
  const context = { sessionId: "session", workspaceId: "workspace", toolCallId: "tool-1", signal: new AbortController().signal };
  const inspection = await click!.inspect(input, context);
  assert.equal(inspection.certifiedComputerApplication, true);
  assert.equal(value.listPreparedActions().length, 1);
  await click!.releaseInspection?.(input, context);
  assert.equal(value.listPreparedActions().length, 0);
});

test("Computer Use Typed IPC 只开放检查、截图和审计", async () => {
  const environment = await runtime();
  const [clientTransport, serverTransport] = createInMemoryTransportPair();
  const server = new TypedIpcServer(serverTransport);
  const bridge = new ComputerUseIpcBridge(environment.value, server);
  bridge.start();
  const client = new TypedIpcClient(clientTransport);

  const windows = await client.request("computer.windows", {}, { timeoutMs: 1_000 });
  const inspected = await client.request("computer.inspect", { windowHandle: windows.windows[0]!.identity.windowHandle }, { timeoutMs: 1_000 });
  const screenshotResult = await client.request("computer.screenshot", { snapshotId: inspected.id }, { timeoutMs: 1_000 });
  const audit = await client.request("computer.audit.list", {}, { timeoutMs: 1_000 });

  assert.equal(windows.windows[0]?.certification.status, "certified");
  assert.equal(screenshotResult.snapshotId, inspected.id);
  assert.equal(audit.entries.length >= 2, true);
  assert.equal(isIpcMessage({ kind: "request", id: "x", method: "computer.action.execute", params: {} }), false);
  client.dispose();
  bridge.dispose();
  server.dispose();
});

test("Workbench Controller 接收 Computer Use 窗口和 Snapshot 事件", async () => {
  const environment = await runtime();
  const [clientTransport, serverTransport] = createInMemoryTransportPair();
  const server = new TypedIpcServer(serverTransport);
  const bridge = new ComputerUseIpcBridge(environment.value, server);
  bridge.start();
  const client = new TypedIpcClient(clientTransport);
  const controller = new WorkbenchController(client, 1_000);
  controller.start();

  const windows = await controller.listComputerWindows();
  const inspected = await controller.inspectComputerWindow(windows[0]!.identity.windowHandle);
  assert.equal(controller.getState().computerWindows.length, 1);
  assert.equal(controller.getState().computerSnapshot?.id, inspected.id);

  controller.dispose();
  client.dispose();
  bridge.dispose();
  server.dispose();
});

test("IPC Version 6 和 Overlay 不暴露 Computer Use 直接交互按钮", async () => {
  assert.ok(IPC_PROTOCOL_VERSION >= 6);
  const view = await readFile("overlays/code-oss/src/vs/workbench/contrib/independentAiIde/browser/independentAiIdeView.ts", "utf8");
  const bridge = await readFile("overlays/code-oss/src/vs/workbench/contrib/independentAiIde/common/independentAiIdeWorkbenchBridge.ts", "utf8");
  assert.equal(view.includes("clickComputer"), false);
  assert.equal(view.includes("typeComputer"), false);
  assert.equal(bridge.includes("executeComputer"), false);
  assert.equal(view.includes("经权限中心批准"), true);
});
