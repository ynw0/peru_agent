import { evaluateComputerCertification } from "./computer-use/certification.js";
import { IPC_PROTOCOL_VERSION } from "./ipc/protocol.js";

const hash = "a".repeat(64);
const decision = evaluateComputerCertification({
  processId: 1,
  executablePath: "C:\\Program Files\\Certified App\\app.exe",
  executableName: "app.exe",
  publisherSubject: "CN=Publisher",
  signerThumbprint: "A".repeat(40),
  version: "1.0.0",
  fileSha256: hash,
  windowHandle: "0x1",
  windowTitle: "Certified App",
  windowClass: "CertifiedWindow",
  integrityLevel: "medium",
  secureDesktop: false,
}, [{
  id: "certified-app",
  displayName: "Certified App",
  executableNames: ["app.exe"],
  allowedPathRoots: ["C:\\Program Files\\Certified App"],
  publisherSubjects: ["CN=Publisher"],
  signerThumbprints: ["A".repeat(40)],
  allowedFileSha256: [hash],
  versionPattern: "^1\\.0\\.0$",
  allowedWindowClasses: ["CertifiedWindow"],
  allowedActions: ["click"],
  allowedShortcuts: [],
}]);

if (decision.status !== "certified") throw new Error("Phase 10 认证应用 Smoke 失败");
if (Number(IPC_PROTOCOL_VERSION) < 6) throw new Error("Phase 10 IPC 协议版本未升级");
console.log("AI IDE Phase 10 Smoke Test 通过");
