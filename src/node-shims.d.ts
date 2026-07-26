// Phase 0 只声明当前代码实际使用的 Node.js 标准模块类型。
// 正式开发安装 @types/node 后删除本文件，避免重复维护完整 Node 类型。

declare module "node:net" {
  export function isIP(input: string): 0 | 4 | 6;
}

declare module "node:test" {
  type TestCallback = () => void | Promise<void>;
  export default function test(name: string, callback: TestCallback): void;
}

declare module "node:assert/strict" {
  interface StrictAssert {
    equal(actual: unknown, expected: unknown): void;
    throws(callback: () => unknown): void;
    rejects(promise: Promise<unknown>, validator?: (error: unknown) => boolean): Promise<void>;
  }
  const assert: StrictAssert;
  export default assert;
}
