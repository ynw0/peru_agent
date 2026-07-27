import { BROWSER_PROXY_PROTOCOL_VERSION } from "./browser/proxy-verifier.js";
import { classifyNetworkAddress, isAddressAllowedForMode } from "./egress/address-policy.js";
import { chooseDownloadFileName } from "./web/download-store.js";
import { IPC_PROTOCOL_VERSION } from "./ipc/protocol.js";

if (IPC_PROTOCOL_VERSION !== 5) {
  throw new Error("Phase 9 需要 IPC Protocol Version 5");
}
if (BROWSER_PROXY_PROTOCOL_VERSION !== 1) {
  throw new Error("Phase 9 需要 Browser Proxy Protocol Version 1");
}
if (!isAddressAllowedForMode("internet", classifyNetworkAddress("93.184.216.34"))) {
  throw new Error("internet 模式应允许公网地址");
}
if (isAddressAllowedForMode("internet", classifyNetworkAddress("127.0.0.1"))) {
  throw new Error("internet 模式不应绕过到 Loopback");
}
if (chooseDownloadFileName("https://example.com/file.bin", 'attachment; filename="../escape.txt"') !== "escape.txt") {
  throw new Error("受控下载必须清理远端文件名");
}
console.log("AI IDE Phase 9 Smoke Test 通过");
