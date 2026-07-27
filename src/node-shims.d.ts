// 当前执行环境没有安装 @types/node，因此只声明项目实际使用的 Node.js 标准模块。
// 正式依赖安装成功后应删除该文件，统一使用锁定版本的 @types/node。

declare class Buffer extends Uint8Array {
  static from(data: string, encoding: "utf8" | "base64"): Buffer;
  static from(data: Uint8Array): Buffer;
  toString(encoding?: "base64" | "utf8"): string;
}

declare module "node:crypto" {
  export interface KeyObject {
    export(options: { type: "pkcs8" | "spki"; format: "pem" }): string | Uint8Array;
  }
  export function createPrivateKey(key: string): KeyObject;
  export function createPublicKey(key: string): KeyObject;
  export function generateKeyPairSync(algorithm: "ed25519"): { publicKey: KeyObject; privateKey: KeyObject };
  export function sign(algorithm: null, data: Uint8Array, key: KeyObject): Buffer;
  export function verify(algorithm: null, data: Uint8Array, key: KeyObject, signature: Uint8Array): boolean;
  interface Hash {
    update(data: string, inputEncoding: "utf8"): Hash;
    update(data: Uint8Array): Hash;
    digest(encoding: "hex"): string;
  }
  export function createHash(algorithm: "sha256"): Hash;
}

declare module "node:net" {
  export function isIP(input: string): 0 | 4 | 6;
}

declare module "node:test" {
  type TestCallback = () => void | Promise<void>;
  export default function test(name: string, callback: TestCallback): void;
}

declare module "node:assert/strict" {
  export interface StrictAssert {
    equal(actual: unknown, expected: unknown): void;
    deepEqual(actual: unknown, expected: unknown): void;
    match(actual: string, expected: RegExp): void;
    ok(value: unknown): void;
    throws(callback: () => unknown): void;
    rejects(promise: Promise<unknown>, validator?: (error: unknown) => boolean): Promise<void>;
  }
  const assert: StrictAssert;
  export default assert;
}

declare module "node:fs/promises" {
  export interface FileStat {
    isFile(): boolean;
    isDirectory(): boolean;
    isSymbolicLink(): boolean;
  }
  export interface Dirent {
    readonly name: string;
    isFile(): boolean;
    isDirectory(): boolean;
    isSymbolicLink(): boolean;
  }
  export function appendFile(path: string, data: string, encoding: "utf8"): Promise<void>;
  export function lstat(path: string): Promise<FileStat>;
  export function mkdir(path: string, options: { recursive: true }): Promise<string | undefined>;
  export function mkdtemp(prefix: string): Promise<string>;
  export function readFile(path: string, encoding: "utf8"): Promise<string>;
  export function readdir(path: string): Promise<string[]>;
  export function readdir(path: string, options: { withFileTypes: true }): Promise<Dirent[]>;
  export function realpath(path: string): Promise<string>;
  export function rename(oldPath: string, newPath: string): Promise<void>;
  export function symlink(target: string, path: string, type?: "file" | "dir" | "junction"): Promise<void>;
  export function rm(path: string, options: { force: boolean; recursive?: boolean }): Promise<void>;
  export function writeFile(path: string, data: string, encoding: "utf8"): Promise<void>;
  export function writeFile(path: string, data: Uint8Array, options: { flag: "wx"; mode: number }): Promise<void>;
}

declare module "node:path" {
  export const sep: string;
  export function dirname(path: string): string;
  export function isAbsolute(path: string): boolean;
  export function join(...paths: string[]): string;
  export function relative(from: string, to: string): string;
  export function resolve(...paths: string[]): string;
  export function basename(path: string): string;
}


declare module "node:child_process" {
  export interface WritableStreamLike {
    write(data: string, encoding: "utf8", callback: (error?: Error | null) => void): void;
  }
  export interface ReadableStreamLike {
    setEncoding(encoding: "utf8"): void;
    on(event: "data", listener: (chunk: string) => void): void;
  }
  export interface ChildProcessWithoutNullStreams {
    readonly stdin: WritableStreamLike;
    readonly stdout: ReadableStreamLike;
    readonly stderr: ReadableStreamLike;
    on(event: "error", listener: (error: Error) => void): void;
    on(event: "exit", listener: (code: number | null) => void): void;
    kill(): boolean;
  }
  export function spawn(
    command: string,
    args: readonly string[],
    options: {
      shell: false;
      windowsHide: true;
      stdio: ["pipe", "pipe", "pipe"];
    },
  ): ChildProcessWithoutNullStreams;
}


declare module "node:dns/promises" {
  export function lookup(
    hostname: string,
    options: { all: true; verbatim: true },
  ): Promise<{ address: string; family: 4 | 6 }[]>;
}

declare module "node:http" {
  export interface IncomingMessage {
    readonly statusCode?: number;
    readonly url?: string;
    readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
    on(event: "data", listener: (chunk: Uint8Array) => void): void;
    on(event: "end", listener: () => void): void;
    on(event: "error", listener: (error: Error) => void): void;
    destroy(error?: Error): void;
  }
  export interface ServerResponse {
    statusCode: number;
    setHeader(name: string, value: string): void;
    end(data?: string): void;
  }
  export interface Server {
    listen(port: number, hostname: string, callback: () => void): void;
    address(): { port: number; address: string; family: string } | string | null;
    close(callback: (error?: Error) => void): void;
  }
  export interface ClientRequest {
    on(event: "error", listener: (error: Error) => void): void;
    on(event: "timeout", listener: () => void): void;
    on(event: "close", listener: () => void): void;
    write(data: string, encoding: "utf8"): void;
    end(): void;
    destroy(error?: Error): void;
  }
  export interface RequestOptions {
    protocol: string;
    hostname: string;
    port: number;
    path: string;
    method: string;
    headers: Readonly<Record<string, string>>;
    servername: string;
    lookup(hostname: string, options: unknown, callback: (error: Error | null, address: string, family: 4 | 6) => void): void;
    timeout: number;
  }
  export function request(options: RequestOptions, callback: (response: IncomingMessage) => void): ClientRequest;
  export function createServer(listener: (request: IncomingMessage, response: ServerResponse) => void): Server;
}

declare module "node:https" {
  export { request } from "node:http";
}

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
    launch(options: { headless: true; proxy: { server: string } }): Promise<Browser>;
  };
}


declare module "node:os" {
  export function tmpdir(): string;
}
