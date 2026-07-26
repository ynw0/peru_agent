// 当前执行环境没有安装 @types/node，因此只声明项目实际使用的 Node.js 标准模块。
// 正式依赖安装成功后应删除该文件，统一使用锁定版本的 @types/node。

declare module "node:crypto" {
  interface Hash {
    update(data: string, inputEncoding: "utf8"): Hash;
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
  export function readFile(path: string, encoding: "utf8"): Promise<string>;
  export function readdir(path: string): Promise<string[]>;
  export function readdir(path: string, options: { withFileTypes: true }): Promise<Dirent[]>;
  export function realpath(path: string): Promise<string>;
  export function rename(oldPath: string, newPath: string): Promise<void>;
  export function symlink(target: string, path: string, type?: "file" | "dir" | "junction"): Promise<void>;
  export function rm(path: string, options: { force: boolean; recursive?: boolean }): Promise<void>;
  export function writeFile(path: string, data: string, encoding: "utf8"): Promise<void>;
}

declare module "node:path" {
  export const sep: string;
  export function dirname(path: string): string;
  export function isAbsolute(path: string): boolean;
  export function join(...paths: string[]): string;
  export function relative(from: string, to: string): string;
  export function resolve(...paths: string[]): string;
}
