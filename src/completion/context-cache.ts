import type { CompletionContextEnrichment } from "./types.js";

interface ContextEntry {
  readonly version: number;
  readonly enrichment: CompletionContextEnrichment;
  readonly expiresAt: number;
}

// 缓存仅绑定精确文档版本；版本变化时绝不复用旧 LSP/Diagnostics 上下文。
export class CompletionContextCache {
  private readonly entries = new Map<string, ContextEntry>();

  public constructor(private readonly ttlMs = 30_000, private readonly maxEntries = 256) {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0 || !Number.isInteger(maxEntries) || maxEntries <= 0) {
      throw new Error("补全上下文缓存配置无效");
    }
  }

  public set(
    documentUri: string,
    version: number,
    enrichment: CompletionContextEnrichment,
    now = Date.now(),
  ): void {
    if (documentUri.trim() === "" || !Number.isInteger(version) || version < 0) {
      throw new Error("补全上下文缓存键无效");
    }
    this.entries.delete(documentUri);
    this.entries.set(documentUri, { version, enrichment: cloneEnrichment(enrichment), expiresAt: now + this.ttlMs });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest === undefined) {
        break;
      }
      this.entries.delete(oldest);
    }
  }

  public get(documentUri: string, version: number, now = Date.now()): CompletionContextEnrichment | undefined {
    const entry = this.entries.get(documentUri);
    if (entry === undefined) {
      return undefined;
    }
    if (entry.version !== version || entry.expiresAt <= now) {
      this.entries.delete(documentUri);
      return undefined;
    }
    this.entries.delete(documentUri);
    this.entries.set(documentUri, entry);
    return cloneEnrichment(entry.enrichment);
  }

  public invalidate(documentUri: string): void {
    this.entries.delete(documentUri);
  }

  public clear(): void {
    this.entries.clear();
  }
}

function cloneEnrichment(value: CompletionContextEnrichment): CompletionContextEnrichment {
  return {
    ...(value.currentFunction === undefined ? {} : { currentFunction: value.currentFunction }),
    ...(value.imports === undefined ? {} : { imports: [...value.imports] }),
    ...(value.recentEdits === undefined ? {} : { recentEdits: [...value.recentEdits] }),
    ...(value.lspTypes === undefined ? {} : { lspTypes: [...value.lspTypes] }),
    ...(value.diagnostics === undefined ? {} : { diagnostics: [...value.diagnostics] }),
    ...(value.projectRules === undefined ? {} : { projectRules: [...value.projectRules] }),
  };
}
