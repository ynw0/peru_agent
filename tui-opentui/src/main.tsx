import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import {
  loadTuiConfiguration,
  loadTuiSetupDraft,
  resolveWorkspaceRoot,
  type TuiConfiguration,
} from "../../src/tui/config.js";
import { TuiController } from "../../src/tui/controller.js";
import { createTuiRuntime } from "../../src/tui/runtime.js";
import { OpenTuiApp } from "./app.js";
import { OpenTuiSetup } from "./setup.js";
import { writeClipboard } from "./clipboard.js";

const workspaceRoot = await resolveWorkspaceRoot(process.argv[2] ?? process.cwd());
const renderer = await createCliRenderer({
  screenMode: "alternate-screen",
  externalOutputMode: "passthrough",
  targetFps: 60,
  gatherStats: false,
  exitOnCtrlC: false,
  useKittyKeyboard: {},
  autoFocus: false,
  openConsoleOnError: false,
  useMouse: true,
  exitSignals: [],
  consoleOptions: {
    onCopySelection: (text: string) => { void writeClipboard(text); },
  },
});
const root = createRoot(renderer);

let controller: TuiController | undefined;
let shuttingDown: Promise<void> | undefined;

async function shutdown(error?: unknown): Promise<void> {
  if (shuttingDown !== undefined) return shuttingDown;
  shuttingDown = (async () => {
    let failure = error;
    try {
      await controller?.dispose();
    } catch (disposeError: unknown) {
      failure ??= disposeError;
    } finally {
      renderer.destroy();
    }
    if (failure !== undefined) {
      process.exitCode = 1;
      process.stderr.write(`${failure instanceof Error ? failure.stack ?? failure.message : String(failure)}\n`);
    }
  })();
  return shuttingDown;
}

process.once("SIGINT", () => { void shutdown(); });
process.once("SIGTERM", () => { void shutdown(); });
process.once("uncaughtException", error => { void shutdown(error); });
process.once("unhandledRejection", error => { void shutdown(error); });

async function start(configuration: TuiConfiguration): Promise<void> {
  const runtime = await createTuiRuntime(configuration, workspaceRoot);
  controller = new TuiController(
    runtime,
    configuration,
    (nextConfiguration, path) => createTuiRuntime(nextConfiguration, path),
  );
  root.render(<OpenTuiApp controller={controller} onExit={() => shutdown()} />);
}

async function boot(): Promise<void> {
  let configuration: TuiConfiguration;
  try {
    configuration = await loadTuiConfiguration();
  } catch (error: unknown) {
    const setup = await loadTuiSetupDraft();
    const reason = setup.error ?? (setup.exists ? errorMessage(error) : undefined);
    root.render(
      <OpenTuiSetup
        draft={setup.draft}
        {...(reason === undefined ? {} : { reason })}
        onConfigured={nextConfiguration => { void start(nextConfiguration).catch(shutdown); }}
        onCancel={setupError => { void shutdown(setupError); }}
      />,
    );
    return;
  }

  await start(configuration);
}

await boot().catch(shutdown);

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "TUI 配置需要设置";
}
