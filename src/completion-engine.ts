// 补全模型必须明确声明 FIM、流式和取消能力。
export interface CompletionCapability {
  readonly fim: boolean;
  readonly streaming: boolean;
  readonly cancellation: boolean;
  readonly maxPrefixTokens: number;
  readonly maxSuffixTokens: number;
}

// 不满足全部条件的模型不能被启用为低延迟补全模型。
export function validateCompletionCapability(capability: CompletionCapability): void {
  if (!capability.fim) {
    throw new Error("补全模型不支持 FIM");
  }
  if (!capability.streaming) {
    throw new Error("补全模型不支持流式输出");
  }
  if (!capability.cancellation) {
    throw new Error("补全模型不支持请求取消");
  }
  if (capability.maxPrefixTokens <= 0 || capability.maxSuffixTokens <= 0) {
    throw new Error("补全模型上下文限制无效");
  }
}
