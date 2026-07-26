import { isComputerInteractionAllowed } from "./computer-use.js";
import { validateCompletionCapability } from "./completion-engine.js";
import { isNetworkTargetAllowed } from "./network-policy.js";
import { canAutoPromoteTool } from "./tool-runtime.js";

validateCompletionCapability({
  fim: true,
  streaming: true,
  cancellation: true,
  maxPrefixTokens: 4096,
  maxSuffixTokens: 2048,
});

const toolDecision = canAutoPromoteTool({
  name: "ReadProjectManifest",
  version: "1.0.0",
  generated: true,
  riskLevel: "workspace-read",
  capabilities: ["workspace.read"],
});

const offlineAllowed = isNetworkTargetAllowed("offline", {
  hostname: "localhost",
  resolvedAddresses: ["127.0.0.1"],
});

const computerAllowed = isComputerInteractionAllowed(
  { executableName: "notepad.exe", publisher: "Microsoft Corporation", version: "11.0.1" },
  [{
    id: "windows-notepad",
    executableName: "notepad.exe",
    publisher: "Microsoft Corporation",
    supportedVersionPattern: /^11\./,
    interactive: true,
  }],
);

if (!toolDecision.allowed || !offlineAllowed || !computerAllowed) {
  throw new Error("Smoke Test 失败");
}

console.log("AI IDE Phase 0 Smoke Test 通过");
