import { identityFingerprint } from "./certification.js";
import type { ComputerUseBrokerTransport } from "./broker-transport.js";
import type { BrokerComputerActionRequest, ComputerBrokerHelloResult, WindowsUiAutomationFeatures } from "./broker-protocol.js";
import {
  validateComputerActionResult,
  validateComputerBrokerHello,
  validateComputerScreenshot,
  validateComputerUiSnapshot,
  validateRunningApplicationIdentity,
} from "./broker-validation.js";
import type { ComputerActionResult, ComputerScreenshot, ComputerUiSnapshot, RunningApplicationIdentity } from "./types.js";

const REQUIRED: readonly (keyof WindowsUiAutomationFeatures)[] = [
  "uiAutomationTree", "authenticodeIdentity", "windowProcessBinding", "screenshotEvidence",
  "invokePattern", "valuePattern", "keyboardInput", "secureDesktopDetection",
  "postActionVerification", "utf8Protocol",
];

export class WindowsUiAutomationBrokerClient {
  private helloResult: ComputerBrokerHelloResult | undefined;

  public constructor(private readonly transport: ComputerUseBrokerTransport) {}

  public async initialize(signal?: AbortSignal): Promise<ComputerBrokerHelloResult> {
    const result = validateComputerBrokerHello(await this.transport.request("hello", {}, signal));
    const missing = REQUIRED.filter(feature => !result.features[feature]);
    if (missing.length > 0) throw new Error(`UI Automation Broker 缺少强制能力：${missing.join(", ")}`);
    this.helloResult = result;
    return result;
  }

  public status(): ComputerBrokerHelloResult | undefined { return this.helloResult; }

  public async listWindows(signal?: AbortSignal): Promise<readonly RunningApplicationIdentity[]> {
    this.assertInitialized();
    const result = await this.transport.request("computer.list-windows", {}, signal);
    if (!Array.isArray(result)) throw new Error("Broker 窗口列表必须是数组");
    return result.map(validateRunningApplicationIdentity);
  }

  public async inspect(windowHandle: string, maxElements: number, signal?: AbortSignal): Promise<ComputerUiSnapshot> {
    this.assertInitialized();
    return validateComputerUiSnapshot(await this.transport.request("computer.inspect", { windowHandle, maxElements }, signal));
  }

  public async screenshot(snapshotId: string, signal?: AbortSignal): Promise<ComputerScreenshot> {
    this.assertInitialized();
    const result = validateComputerScreenshot(await this.transport.request("computer.screenshot", { snapshotId }, signal));
    if (result.snapshotId !== snapshotId) throw new Error("Broker 截图与请求 Snapshot 不匹配");
    return result;
  }

  public async act(request: BrokerComputerActionRequest, signal?: AbortSignal): Promise<ComputerActionResult> {
    this.assertInitialized();
    const result = validateComputerActionResult(await this.transport.request("computer.action", request, signal));
    if (result.actionId !== request.actionId || result.action !== request.action || result.beforeSnapshotId !== request.snapshotId) {
      throw new Error("Broker 动作结果与当前请求不匹配");
    }
    if (identityFingerprint(result.afterSnapshot.identity) !== request.identityFingerprint) {
      throw new Error("Broker 动作后窗口身份发生变化");
    }
    return result;
  }

  public dispose(): void { this.transport.dispose(); }

  private assertInitialized(): void {
    if (this.helloResult === undefined) throw new Error("UI Automation Broker 尚未初始化");
  }
}
