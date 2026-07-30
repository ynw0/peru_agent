import type { TuiController } from "./controller.js";

export interface TuiApplicationRenderer {
  unmount(): void;
  waitUntilExit(): Promise<unknown>;
}

export type TuiLifecycleEvent =
  | "SIGINT"
  | "SIGTERM"
  | "uncaughtException"
  | "unhandledRejection";

export interface TuiLifecycleHost {
  once(event: TuiLifecycleEvent, listener: (error?: unknown) => void): unknown;
  removeListener(event: TuiLifecycleEvent, listener: (error?: unknown) => void): unknown;
}

export interface TuiApplicationLifecycleOptions {
  readonly host?: TuiLifecycleHost;
  readonly writeError?: (message: string) => void;
  readonly setExitCode?: (code: number) => void;
  readonly stdout?: { readonly isTTY?: boolean; write(value: string): unknown };
}

/**
 * TUI 的唯一生命周期边界。Renderer 可以替换，但 shutdown 永远释放
 * Controller 当前持有的 Runtime，因此工作区/配置切换后不会清理旧实例。
 */
export class TuiApplicationLifecycle {
  private readonly host: TuiLifecycleHost;
  private readonly writeError: (message: string) => void;
  private readonly setExitCode: (code: number) => void;
  private readonly stdout: { readonly isTTY?: boolean; write(value: string): unknown };
  private renderer: TuiApplicationRenderer | undefined;
  private shutdownPromise: Promise<void> | undefined;
  private installed = false;
  private mouseTrackingEnabled = false;

  public constructor(
    private readonly controller: TuiController,
    options: TuiApplicationLifecycleOptions = {},
  ) {
    this.host = options.host ?? (process as unknown as TuiLifecycleHost);
    this.writeError = options.writeError ?? (message => process.stderr.write(`${message}\n`));
    this.setExitCode = options.setExitCode ?? (code => { process.exitCode = code; });
    this.stdout = options.stdout ?? process.stdout;
  }

  public setRenderer(renderer: TuiApplicationRenderer | undefined): void {
    this.renderer = renderer;
  }

  public install(): void {
    if (this.installed) return;
    this.installed = true;
    this.enableMouseTracking();
    this.host.once("SIGINT", this.onSignal);
    this.host.once("SIGTERM", this.onSignal);
    this.host.once("uncaughtException", this.onUnhandledError);
    this.host.once("unhandledRejection", this.onUnhandledError);
  }

  public uninstall(): void {
    if (!this.installed) return;
    this.installed = false;
    this.disableMouseTracking();
    this.host.removeListener("SIGINT", this.onSignal);
    this.host.removeListener("SIGTERM", this.onSignal);
    this.host.removeListener("uncaughtException", this.onUnhandledError);
    this.host.removeListener("unhandledRejection", this.onUnhandledError);
  }

  public shutdown(error?: unknown): Promise<void> {
    if (this.shutdownPromise !== undefined) return this.shutdownPromise;
    this.shutdownPromise = (async () => {
      let failure = error;
      try {
        await this.controller.dispose();
      } catch (disposeError: unknown) {
        failure ??= disposeError;
      } finally {
        // 即使 Runtime 清理失败，也必须退出 alternate screen。
        this.renderer?.unmount();
        this.disableMouseTracking();
      }
      if (failure !== undefined) {
        this.setExitCode(1);
        this.writeError(failure instanceof Error ? failure.stack ?? failure.message : String(failure));
      }
    })();
    return this.shutdownPromise;
  }

  private readonly onSignal = (): void => {
    void this.shutdown();
  };

  private readonly onUnhandledError = (error?: unknown): void => {
    void this.shutdown(error);
  };

  private enableMouseTracking(): void {
    if (this.mouseTrackingEnabled || this.stdout.isTTY !== true) return;
    this.mouseTrackingEnabled = true;
    // 1002 reports motion while a button is held, which is required for
    // left-button text selection. 1006 keeps coordinates unambiguous.
    this.stdout.write("\u001b[?1002h\u001b[?1006h");
  }

  private disableMouseTracking(): void {
    if (!this.mouseTrackingEnabled) return;
    this.mouseTrackingEnabled = false;
    this.stdout.write("\u001b[?1002l\u001b[?1006l");
  }
}
