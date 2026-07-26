import type { CompletionCapability } from "../completion-engine.js";
import type { CompletionDocumentInput, CompletionRequest } from "./types.js";

export interface CompletionContextBuilderOptions {
  readonly reservedMetadataTokens: number;
  readonly maxOutputTokens: number;
}

const DEFAULT_OPTIONS: CompletionContextBuilderOptions = {
  reservedMetadataTokens: 256,
  maxOutputTokens: 128,
};

// 使用保守字符估算限制请求体；Provider 可在未来替换为模型专用 tokenizer。
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3);
}

export function buildCompletionRequest(
  requestId: string,
  input: CompletionDocumentInput,
  capability: CompletionCapability,
  options: CompletionContextBuilderOptions = DEFAULT_OPTIONS,
): CompletionRequest {
  if (!Number.isInteger(input.version) || input.version < 0) {
    throw new Error("文档版本必须是非负整数");
  }
  if (!Number.isInteger(input.offset) || input.offset < 0 || input.offset > input.text.length) {
    throw new Error("补全光标偏移无效");
  }
  if (options.reservedMetadataTokens < 0 || options.maxOutputTokens <= 0) {
    throw new Error("补全上下文预算无效");
  }

  const prefixBudget = Math.max(1, capability.maxPrefixTokens - options.reservedMetadataTokens);
  const suffixBudget = Math.max(1, capability.maxSuffixTokens - options.reservedMetadataTokens);
  const prefix = trimPrefixToTokenBudget(input.text.slice(0, input.offset), prefixBudget);
  const suffix = trimSuffixToTokenBudget(input.text.slice(input.offset), suffixBudget);
  const enrichment = input.enrichment;
  const metadata = fitMetadataToBudget({
    ...(enrichment?.currentFunction === undefined ? {} : { currentFunction: enrichment.currentFunction }),
    imports: limitItems(enrichment?.imports ?? [], 32),
    recentEdits: limitItems(enrichment?.recentEdits ?? [], 16),
    lspTypes: limitItems(enrichment?.lspTypes ?? [], 24),
    diagnostics: limitItems(enrichment?.diagnostics ?? [], 24),
    projectRules: limitItems(enrichment?.projectRules ?? [], 24),
  }, options.reservedMetadataTokens);

  return {
    requestId,
    documentUri: input.documentUri,
    languageId: input.languageId,
    documentVersion: input.version,
    offset: input.offset,
    prefix,
    suffix,
    metadata,
    maxOutputTokens: options.maxOutputTokens,
  };
}

function trimPrefixToTokenBudget(value: string, budget: number): string {
  if (estimateTokens(value) <= budget) {
    return value;
  }
  return value.slice(Math.max(0, value.length - budget * 3));
}

function trimSuffixToTokenBudget(value: string, budget: number): string {
  if (estimateTokens(value) <= budget) {
    return value;
  }
  return value.slice(0, budget * 3);
}

function limitItems(items: readonly string[], limit: number): readonly string[] {
  return items.filter(item => item.trim() !== "").slice(0, limit);
}

function fitMetadataToBudget(
  metadata: CompletionRequest["metadata"],
  tokenBudget: number,
): CompletionRequest["metadata"] {
  let remainingChars = tokenBudget * 3;
  const take = (value: string): string => {
    if (remainingChars <= 0) {
      return "";
    }
    const result = value.slice(0, remainingChars);
    remainingChars -= result.length;
    return result;
  };
  const takeArray = (items: readonly string[]): readonly string[] => {
    const result: string[] = [];
    for (const item of items) {
      const value = take(item);
      if (value === "") {
        break;
      }
      result.push(value);
    }
    return result;
  };
  const currentFunction = metadata.currentFunction === undefined ? undefined : take(metadata.currentFunction);
  return {
    ...(currentFunction === undefined || currentFunction === "" ? {} : { currentFunction }),
    imports: takeArray(metadata.imports),
    recentEdits: takeArray(metadata.recentEdits),
    lspTypes: takeArray(metadata.lspTypes),
    diagnostics: takeArray(metadata.diagnostics),
    projectRules: takeArray(metadata.projectRules),
  };
}
