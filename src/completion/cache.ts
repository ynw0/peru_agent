import { createHash } from "node:crypto";
import type { CompletionCandidate, CompletionRequest } from "./types.js";

interface CacheEntry {
  readonly candidate: CompletionCandidate;
  readonly expiresAt: number;
}

export class CompletionCache {
  private readonly entries = new Map<string, CacheEntry>();

  public constructor(
    private readonly maxEntries = 128,
    private readonly ttlMs = 15_000,
  ) {
    if (!Number.isInteger(maxEntries) || maxEntries <= 0 || !Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw new Error("补全缓存配置无效");
    }
  }

  public key(request: CompletionRequest, providerId: string): string {
    const source = JSON.stringify({
      providerId,
      documentUri: request.documentUri,
      languageId: request.languageId,
      prefix: request.prefix,
      suffix: request.suffix,
      metadata: request.metadata,
      maxOutputTokens: request.maxOutputTokens,
    });
    return createHash("sha256").update(source, "utf8").digest("hex");
  }

  public get(key: string, now = Date.now()): CompletionCandidate | undefined {
    const entry = this.entries.get(key);
    if (entry === undefined) {
      return undefined;
    }
    if (entry.expiresAt <= now) {
      this.entries.delete(key);
      return undefined;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    return { ...entry.candidate, cacheHit: true, firstTokenLatencyMs: 0, totalLatencyMs: 0 };
  }

  public set(key: string, candidate: CompletionCandidate, now = Date.now()): void {
    this.entries.delete(key);
    this.entries.set(key, { candidate: { ...candidate, cacheHit: false }, expiresAt: now + this.ttlMs });
    while (this.entries.size > this.maxEntries) {
      const oldestKey = this.entries.keys().next().value as string | undefined;
      if (oldestKey === undefined) {
        break;
      }
      this.entries.delete(oldestKey);
    }
  }

  public clear(): void {
    this.entries.clear();
  }
}
