// AgentError 使用稳定错误码，IDE 不需要解析错误文本判断类型。
export class AgentError extends Error {
  public constructor(
    public readonly code:
      | "SESSION_NOT_FOUND"
      | "RUN_ALREADY_ACTIVE"
      | "MODEL_PROTOCOL_ERROR"
      | "MODEL_REQUEST_FAILED"
      | "MODEL_USAGE_MISSING"
      | "TOOL_NOT_FOUND"
      | "TOOL_INPUT_INVALID"
      | "TOOL_EXECUTION_FAILED"
      | "PERMISSION_DENIED"
      | "MAX_TURNS_EXCEEDED"
      | "MAX_TOOL_CALLS_EXCEEDED"
      | "TOKEN_BUDGET_EXCEEDED"
      | "RUN_ABORTED"
      | "INTERNAL_ERROR",
    message: string,
  ) {
    super(message);
    this.name = "AgentError";
  }
}
