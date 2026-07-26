import { TypedIpcClient, TypedIpcServer } from "./ipc/channel.js";
import { IPC_PROTOCOL_VERSION } from "./ipc/protocol.js";
import { createInMemoryTransportPair } from "./ipc/transport.js";
import { CODE_OSS_SOURCE_PIN, validateCodeOssSourcePin } from "./product/code-oss-source.js";
import { PRODUCT_MANIFEST, validateProductManifest } from "./product/product-manifest.js";
import { validateWorkbenchContainers, WORKBENCH_CONTAINERS } from "./workbench/contributions.js";

validateCodeOssSourcePin(CODE_OSS_SOURCE_PIN);
validateProductManifest(PRODUCT_MANIFEST);
validateWorkbenchContainers(WORKBENCH_CONTAINERS);

const [clientTransport, serverTransport] = createInMemoryTransportPair();
const server = new TypedIpcServer(serverTransport);
server.registerHandler("runtime.initialize", request => {
  if (request.protocolVersion !== IPC_PROTOCOL_VERSION) {
    throw new Error("IPC 协议版本不匹配");
  }
  return {
    runtimeId: "phase-1-runtime",
    protocolVersion: IPC_PROTOCOL_VERSION,
    enabledCapabilities: ["workspace.read"],
  };
});

const client = new TypedIpcClient(clientTransport);
const result = await client.request("runtime.initialize", {
  protocolVersion: IPC_PROTOCOL_VERSION,
  clientId: "phase-1-smoke",
  locale: "zh-CN",
  permissionMode: "default",
  networkMode: "offline",
}, { timeoutMs: 1_000 });

if (result.runtimeId !== "phase-1-runtime") {
  throw new Error("Phase 1 IPC Smoke Test 失败");
}

client.dispose();
server.dispose();
console.log("AI IDE Phase 1 Product + Typed IPC Smoke Test 通过");
