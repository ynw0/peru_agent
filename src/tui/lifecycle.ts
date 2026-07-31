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
}

/**
 * TUI 的唯一生命周期边界。终端模式由终端自身管理；这里仅负责释放
 * Controller 当前持有的 Runtime、卸载 Renderer 和处理进程退出信号。
 */
export class TuiApplicationLifecycle {
  private readonly host: TuiLifecycleHost;
  private readonly writeError: (message: string) => void;
  private readonly setExitCode: (code: number) => void;
  private renderer: TuiApplicationRenderer | undefined;
  private shutdownPromise: Promise<void> | undefined;
  private installed = false;

  public constructor(
    private readonly controller: TuiController,
    options: TuiApplicationLifecycleOptions = {},
  ) {
    this.host = options.host ?? (process as unknown as TuiLifecycleHost);
    this.writeError = options.writeError ?? (message => process.stderr.write(`${message}\n`));
    this.setExitCode = options.setExitCode ?? (code => { process.exitCode = code; });
  }

  public setRenderer(renderer: TuiApplicationRenderer | undefined): void {
    this.renderer = renderer;
  }

  public install(): void {
    if (this.installed) return;
    this.installed = true;
    this.host.once("SIGINT", this.onSignal);
    this.host.once("SIGTERM", this.onSignal);
    this.host.once("uncaughtException", this.onUnhandledError);
    this.host.once("unhandledRejection", this.onUnhandledError);
  }

  public uninstall(): void {
    if (!this.installed) return;
    this.installed = false;
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
        this.renderer?.unmount();
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
}
