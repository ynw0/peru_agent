// playwright-core 是可选运行时依赖；未安装时 Browser Runtime 会明确拒绝启动。
declare module "playwright-core" {
  export interface Locator {
    ariaSnapshot(options: { timeout: number }): Promise<string>;
    innerText(options: { timeout: number }): Promise<string>;
    evaluateAll<T>(callback: (nodes: Element[]) => T): Promise<T>;
    evaluate<T>(callback: (node: Element) => T): Promise<T>;
    nth(index: number): Locator;
    click(options: { timeout: number }): Promise<void>;
    fill(text: string, options: { timeout: number }): Promise<void>;
  }

  export interface Route {
    request(): { url(): string };
    continue(): Promise<void>;
    abort(errorCode?: string): Promise<void>;
  }

  export interface Page {
    goto(url: string, options: { waitUntil: "domcontentloaded"; timeout: number }): Promise<void>;
    locator(selector: string): Locator;
    url(): string;
    title(): Promise<string>;
    screenshot(options: { type: "png"; fullPage: false }): Promise<Uint8Array & { toString(encoding: "base64"): string }>;
  }

  export interface BrowserContext {
    route(pattern: string, handler: (route: Route) => Promise<void>): Promise<void>;
    newPage(): Promise<Page>;
    close(): Promise<void>;
  }

  export interface Browser {
    newContext(options: {
      locale: string;
      viewport: { width: number; height: number };
      acceptDownloads: false;
    }): Promise<BrowserContext>;
    close(): Promise<void>;
  }

  export const chromium: {
    launch(options: { headless: true; proxy: { server: string }; executablePath: string }): Promise<Browser>;
  };
}
