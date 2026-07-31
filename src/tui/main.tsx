import { render } from "ink";
import { loadTuiConfiguration, loadTuiSetupDraft, resolveWorkspaceRoot } from "./config.js";
import { TuiApp } from "./app.js";
import { createTuiRuntime } from "./runtime.js";
import { runTuiSetupWizard } from "./setup.js";
import { TuiController } from "./controller.js";
import { TuiApplicationLifecycle } from "./lifecycle.js";

async function main(): Promise<void> {
  const workspaceRoot = await resolveWorkspaceRoot(process.argv[2] ?? process.cwd());
  let configuration;
  try {
    configuration = await loadTuiConfiguration();
  } catch (error: unknown) {
    const setup = await loadTuiSetupDraft();
    configuration = await runTuiSetupWizard(setup.draft, setup.error ?? (setup.exists ? errorMessage(error) : undefined));
  }
  const runtime = await createTuiRuntime(configuration, workspaceRoot);
  const controller = new TuiController(runtime, configuration, (nextConfiguration, path) => createTuiRuntime(nextConfiguration, path));
  const lifecycle = new TuiApplicationLifecycle(controller);
  try {
    const app = render(
      <TuiApp
        controller={controller}
        onExit={() => lifecycle.shutdown()}
      />,
      { alternateScreen: true, exitOnCtrlC: false },
    );
    lifecycle.setRenderer(app);
    // Enable terminal modes only after Ink has installed its renderer. This
    // prevents the first alternate-screen frame from consuming the setup
    // sequence and leaves a single lifecycle owner for cleanup.
    lifecycle.install();
    await app.waitUntilExit();
  } finally {
    await lifecycle.shutdown();
    lifecycle.uninstall();
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "TUI 配置需要设置";
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : "TUI 启动失败"}\n`);
  process.exitCode = 1;
});
