import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentSessionSnapshot } from "../agent/types.js";
import { loadTuiConfiguration, checkTuiHealth, discoverBrokerExecutablePath, type TuiConfiguration } from "./config.js";
import { TuiController } from "./controller.js";
import { createTuiRuntime, type TuiRuntime } from "./runtime.js";

export interface TuiE2eStepResult {
  readonly name: string;
  readonly status: "passed" | "failed";
  readonly startedAt: string;
  readonly durationMs: number;
  readonly message?: string;
  readonly details?: Readonly<Record<string, string | number | boolean>>;
}

export interface TuiE2eReport {
  readonly ok: boolean;
  readonly workspaceRoot: string;
  readonly dataDirectory: string;
  readonly steps: readonly TuiE2eStepResult[];
  readonly failureReportPath?: string;
}

class TuiE2eFailure extends Error {
  public constructor(
    message: string,
    public readonly details: Readonly<Record<string, string | number | boolean>>,
  ) {
    super(message);
    this.name = "TuiE2eFailure";
  }
}

const EXPECTED_COMMAND = "Get-Content -LiteralPath 'note.txt' -Raw";

export async function runTuiRealE2e(): Promise<TuiE2eReport> {
  const steps: TuiE2eStepResult[] = [];
  let root = "";
  let workspaceRoot = "";
  let dataDirectory = "";
  let activeController: TuiController | undefined;
  let activeRuntime: TuiRuntime | undefined;
  try {
    await step(steps, "加载并检查现有配置", async () => {
      const configuration = await loadTuiConfiguration();
      const brokerPath = await discoverBrokerExecutablePath();
      if (brokerPath.trim() === "") throw new Error("当前 peru_agent 安装包未发现 Windows Sandbox Broker");
      const health = await checkTuiHealth({
        configPath: configuration.configPath,
        baseUrl: configuration.model.baseUrl,
        chatCompletionsPath: configuration.model.chatCompletionsPath,
        model: configuration.model.model,
        apiKey: configuration.model.apiKey,
        contextWindowTokens: String(configuration.model.contextWindowTokens),
        sandboxBrokerExecutablePath: brokerPath,
        permissionMode: configuration.permissionMode,
        networkMode: configuration.networkMode,
      });
      if (!health.ok) throw new Error(health.messages.join("；"));
      return {
        model: configuration.model.model,
        modelEndpointOk: health.modelEndpoint.ok,
        brokerVersion: health.broker.brokerVersion ?? "unknown",
        brokerProtocolVersion: health.broker.protocolVersion ?? 0,
      };
    });

    // Windows Sandbox Broker requires the AppContainer to traverse every parent
    // directory of the working tree. Keep the isolated run beside the repository
    // (rather than below it) so the repository ACL cannot block that traversal,
    // and keep it outside credential-protected AppData/Temp locations.
    const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
    // The workspace itself must be a direct child of the drive root: granting
    // an ACL on a nested directory is insufficient when its parent is denied
    // to the AppContainer and PowerShell cannot set its current directory.
    root = await mkdtemp(join(dirname(repositoryRoot), `${basename(repositoryRoot)}-e2e-run-`));
    workspaceRoot = root;
    dataDirectory = join(root, "data");
    await mkdir(dataDirectory, { recursive: true });
    await writeFile(join(workspaceRoot, "note.txt"), "before", "utf8");

    const sourceConfiguration = await loadTuiConfiguration();
    const configuration: TuiConfiguration = {
      ...sourceConfiguration,
      configPath: join(root, "config.json"),
      dataDirectory,
      sandboxBrokerExecutablePath: await discoverBrokerExecutablePath(),
      permissionMode: "default",
      networkMode: "offline",
    };
    const acceptedDiffs = new Set<string>();
    const acceptedPermissions = new Set<string>();
    let unexpectedReview: Error | undefined;
    const failReview = (error: unknown): void => {
      unexpectedReview = error instanceof Error ? error : new Error(String(error));
      activeRuntime?.abortActiveRun();
    };
    activeRuntime = await createTuiRuntime(configuration, workspaceRoot);
    activeController = new TuiController(activeRuntime, configuration, (next, path) => createTuiRuntime(next, path));
    const reviewSubscription = activeRuntime.onSnapshot(snapshot => {
      for (const permission of snapshot.pendingPermissions) {
        if (acceptedPermissions.has(permission.requestId)) continue;
        const valid = permission.toolName === "PowerShell"
          && permission.commandText === EXPECTED_COMMAND
          && permission.commands.length === 1
          && permission.commands[0] === "Get-Content"
          && permission.networkTargets.length === 0
          && permission.affectedFiles.length === 1
          && permission.affectedFiles[0] === "note.txt";
        acceptedPermissions.add(permission.requestId);
        if (!valid) {
          failReview(new Error(`拒绝未匹配的 PowerShell 审核：${permission.commandText ?? ""}`));
        } else {
          if (activeController?.resolvePermission(permission.requestId, "allow") !== true) {
            failReview(new Error("PowerShell 权限请求未能进入 Broker 执行流程"));
          }
        }
      }
      for (const view of snapshot.diffProposals) {
        if (acceptedDiffs.has(view.proposalId)) continue;
        const proposal = activeController?.getDiff(view.proposalId);
        if (proposal === undefined) continue;
        acceptedDiffs.add(view.proposalId);
        const valid = proposal.status === "proposed"
          && proposal.changes.length === 1
          && proposal.changes[0]?.path === "note.txt"
          && proposal.changes[0]?.before.content === "before"
          && proposal.changes[0]?.afterContent === "after";
        if (!valid) failReview(new Error("拒绝未匹配的 Diff"));
        const task = activeController?.resolveDiff(view.proposalId, valid ? "accepted" : "rejected");
        if (task !== undefined) {
          void task.catch(failReview);
        }
      }
    });

    await step(steps, "严格执行 Read → Edit → PowerShell", async () => {
      const started = await activeController!.sendInput(
        "这是自动验收任务，必须立即调用 Tool，不要提问或等待澄清。`after` 是固定字面量文本 after，不是待用户提供的占位符。在当前工作区严格按顺序完成：1 使用 Read 读取 note.txt；2 使用 Edit 将完整内容 before 替换成固定字面量 after，不要调用 Write/ApplyPatch；3 使用 PowerShell 执行脚本 Get-Content -LiteralPath 'note.txt' -Raw；最后用一句话明确包含 after。不要读取或修改其他文件，不要执行其他命令，不要访问网络。",
      );
      let session: AgentSessionSnapshot;
      try {
        session = await withTimeout(activeRuntime!.agent.waitForRun(started.runId), 180_000);
      } catch (error: unknown) {
        const reason = unexpectedReview ?? (error instanceof Error ? error : new Error(String(error)));
        throw new TuiE2eFailure(reason.message, await collectE2eEvidence(activeController!, activeRuntime!, workspaceRoot));
      }
      if (unexpectedReview !== undefined) {
        throw new TuiE2eFailure(unexpectedReview.message, await collectE2eEvidence(activeController!, activeRuntime!, workspaceRoot));
      }
      assertCompletedSession(session);
      return {
        runId: started.runId,
        sessionId: session.id,
        diffReviewsAccepted: acceptedDiffs.size,
        permissionReviewsAccepted: acceptedPermissions.size,
      };
    });
    reviewSubscription.dispose();

    await step(steps, "验证文件、Checkpoint、Broker 结果和回灌", async () => {
      const content = await readFile(join(workspaceRoot, "note.txt"), "utf8");
      if (content !== "after") throw new Error(`note.txt 内容不正确：${content}`);
      const checkpoints = await activeController!.listCheckpoints();
      if (checkpoints.length === 0) throw new Error("未创建 Checkpoint");
      const session = await activeController!.getRuntime().getActiveSession();
      const toolMessages = session.messages.filter(message => message.role === "tool");
      const toolNames = toolMessages.map(message => message.toolName);
      if (toolNames.length !== 3 || toolNames[0] !== "Read" || toolNames[1] !== "Edit" || toolNames[2] !== "PowerShell") {
        throw new Error(`Tool 顺序不符合严格验收：${toolNames.join(" → ")}`);
      }
      const calls = session.messages
        .filter(message => message.role === "assistant")
        .flatMap(message => message.toolCalls);
      const readArgs = calls[0]?.arguments;
      const editArgs = calls[1]?.arguments;
      const shellArgs = calls[2]?.arguments;
      if (calls.length !== 3 || calls[0]?.name !== "Read" || calls[1]?.name !== "Edit" || calls[2]?.name !== "PowerShell"
        || !isRecord(readArgs) || readArgs.path !== "note.txt"
        || !isRecord(editArgs) || editArgs.path !== "note.txt" || editArgs.oldText !== "before" || editArgs.newText !== "after"
        || !isRecord(shellArgs) || shellArgs.script !== EXPECTED_COMMAND) {
        throw new Error("Tool 参数不符合严格验收");
      }
      const powerShellCall = session.messages.find(message => message.role === "tool" && message.toolName === "PowerShell");
      if (powerShellCall === undefined || powerShellCall.role !== "tool") throw new Error("未发现 PowerShell Tool Result");
      const detail = await activeController!.getToolResult(powerShellCall.toolCallId);
      const result = detail?.powerShell;
      if (result === undefined || result.exitCode !== 0 || result.timedOut || result.interrupted || result.stdout.trim() !== "after" || result.stderr.trim() !== "") {
        throw new Error("PowerShell 真实结果不符合预期");
      }
      const assistant = session.messages.filter(message => message.role === "assistant").at(-1);
      if (assistant?.content.includes("after") !== true) throw new Error("最终 Assistant 未确认 after");
      return {
        checkpointId: checkpoints[0]!.id,
        powerShellExitCode: result.exitCode,
        powerShellTimedOut: result.timedOut,
        powerShellStdout: result.stdout.trim(),
        finalAssistantConfirmedAfter: true,
      };
    });

    await activeController.dispose();
    activeController = undefined;
    activeRuntime = undefined;
    const restoredRuntime = await createTuiRuntime(configuration, workspaceRoot);
    const restoredController = new TuiController(restoredRuntime, configuration, (next, path) => createTuiRuntime(next, path));
    try {
      await step(steps, "重建 Runtime 恢复会话并恢复 Checkpoint", async () => {
        const session = await restoredRuntime.getActiveSession();
        assertCompletedSession(session);
        const checkpoints = await restoredController.listCheckpoints();
        const checkpoint = checkpoints.find(item => item.status === "active") ?? checkpoints[0];
        if (checkpoint === undefined) throw new Error("恢复时没有可用 Checkpoint");
        await restoredController.restoreCheckpoint(checkpoint.id);
        const reverted = await readFile(join(workspaceRoot, "note.txt"), "utf8");
        if (reverted !== "before") throw new Error(`Checkpoint 未恢复 before：${reverted}`);
        return {
          restoredSessionId: session.id,
          restoredCheckpointId: checkpoint.id,
          restoredContent: reverted,
        };
      });
    } finally {
      await restoredController.dispose();
    }
    const report: TuiE2eReport = { ok: true, workspaceRoot, dataDirectory, steps };
    await rm(root, { recursive: true, force: true });
    return report;
  } catch (error: unknown) {
    await activeController?.dispose().catch(() => undefined);
    if (activeRuntime !== undefined && activeController === undefined) await activeRuntime.dispose().catch(() => undefined);
    const message = error instanceof Error ? error.message : String(error);
    if (steps.at(-1)?.status !== "failed") {
      steps.push({
        name: "real-e2e",
        status: "failed",
        startedAt: new Date().toISOString(),
        durationMs: 0,
        message,
      });
    }
    const reportPath = root === "" ? undefined : join(root, "e2e-report.json");
    if (reportPath !== undefined) {
      await writeFile(reportPath, JSON.stringify({ ok: false, workspaceRoot, dataDirectory, steps, failureReportPath: reportPath }, null, 2), "utf8");
    }
    return { ok: false, workspaceRoot, dataDirectory, steps, ...(reportPath === undefined ? {} : { failureReportPath: reportPath }) };
  }
}

async function step(
  steps: TuiE2eStepResult[],
  name: string,
  action: () => Promise<Readonly<Record<string, string | number | boolean>> | void>,
): Promise<void> {
  const startedAt = new Date().toISOString();
  const started = Date.now();
  try {
    const details = await action();
    steps.push({
      name,
      status: "passed",
      startedAt,
      durationMs: Date.now() - started,
      ...(details === undefined ? {} : { details }),
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    const details = error instanceof TuiE2eFailure ? error.details : undefined;
    steps.push({
      name,
      status: "failed",
      startedAt,
      durationMs: Date.now() - started,
      message,
      ...(details === undefined ? {} : { details }),
    });
    throw error;
  }
}

async function collectE2eEvidence(
  controller: TuiController,
  runtime: TuiRuntime,
  workspaceRoot: string,
): Promise<Readonly<Record<string, string | number | boolean>>> {
  const session = await runtime.getActiveSession().catch(() => undefined);
  const snapshot = runtime.getSnapshot();
  const noteContent = await readFile(join(workspaceRoot, "note.txt"), "utf8").catch(() => "<unreadable>");
  const toolMessages = session?.messages.filter(message => message.role === "tool") ?? [];
  const lastTool = snapshot.tools.at(-1);
  return {
    sessionStatus: session?.status ?? "unavailable",
    sessionMessageCount: session?.messages.length ?? 0,
    sessionToolNames: toolMessages.map(message => message.toolName).join(" -> "),
    sessionToolCallCount: session?.usage.toolCallCount ?? 0,
    diffStates: controller.listDiffs().map(diff => `${diff.id}:${diff.status}`).join(", "),
    pendingDiffCount: controller.listDiffs().filter(diff => diff.status === "proposed").length,
    pendingPermissionCount: snapshot.pendingPermissions.length,
    lastToolName: lastTool?.toolName ?? "",
    lastToolState: lastTool?.state ?? "",
    lastWorkbenchFailure: snapshot.failed?.message ?? "",
    noteContent,
  };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(`E2E 超时（${timeoutMs}ms）`)), timeoutMs); }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function assertCompletedSession(session: AgentSessionSnapshot): void {
  if (session.status !== "completed") throw new Error(`Agent 会话未完成：${session.status}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const report = await runTuiRealE2e();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.ok) process.exitCode = 1;
}
