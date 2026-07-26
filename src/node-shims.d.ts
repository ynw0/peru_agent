// 当前执行环境没有安装 @types/node，因此只声明本阶段实际使用的 Node.js 标准模块。
// 正式依赖安装成功后应删除该文件，统一使用锁定版本的 @types/node。

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
  export function appendFile(path: string, data: string, encoding: "utf8"): Promise<void>;
  export function mkdir(path: string, options: { recursive: true }): Promise<string | undefined>;
  export function readFile(path: string, encoding: "utf8"): Promise<string>;
  export function readdir(path: string): Promise<string[]>;
  export function rename(oldPath: string, newPath: string): Promise<void>;
  export function rm(path: string, options: { recursive: true; force: true }): Promise<void>;
  export function writeFile(path: string, data: string, encoding: "utf8"): Promise<void>;
}

declare module "node:path" {
  export function dirname(path: string): string;
  export function join(...paths: string[]): string;
}
