import type { IpcErrorCode } from "./protocol.js";

// 所有 IPC 错误都带稳定错误码，禁止依赖字符串解析判断错误类型。
export class IpcError extends Error {
  public readonly code: IpcErrorCode;

  public constructor(code: IpcErrorCode, message: string) {
    super(message);
    this.name = "IpcError";
    this.code = code;
  }
}
