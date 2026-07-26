// Provider 配置只保存密钥引用，不保存明文密钥。
export interface OpenAICompatibleProviderConfig {
  readonly baseUrl: string;
  readonly apiKeyReference: string;
  readonly model: string;
}

export function validateProviderConfig(config: OpenAICompatibleProviderConfig): URL {
  if (config.apiKeyReference.trim() === "") {
    throw new Error("API Key 引用不能为空");
  }
  if (config.model.trim() === "") {
    throw new Error("模型名称不能为空");
  }

  const url = new URL(config.baseUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("模型服务地址必须使用 HTTP 或 HTTPS");
  }
  return url;
}
