const FORBIDDEN_MARKERS = ["<fim_prefix>", "<fim_suffix>", "<fim_middle>", "<|fim_prefix|>", "<|fim_suffix|>", "<|fim_middle|>"];

export function normalizeCompletionText(text: string, prefix: string, suffix: string): string | null {
  let candidate = text.replace(/\r\n/g, "\n").replace(/^```[^\n]*\n?/, "").replace(/\n?```$/, "");
  if (candidate.length > 8_192) {
    candidate = candidate.slice(0, 8_192);
  }
  if (candidate.trim() === "" || FORBIDDEN_MARKERS.some(marker => candidate.includes(marker))) {
    return null;
  }
  if (/[^\t\n\r\x20-\x7E\u0080-\uFFFF]/u.test(candidate)) {
    return null;
  }

  const prefixTail = prefix.slice(-candidate.length);
  if (candidate === prefixTail || suffix.startsWith(candidate)) {
    return null;
  }

  // 模型有时重复光标后的文本，只删除完整且明确的公共后缀。
  const overlap = longestSuffixPrefixOverlap(candidate, suffix);
  if (overlap > 0) {
    candidate = candidate.slice(0, candidate.length - overlap);
  }
  return candidate.trim() === "" ? null : candidate;
}

function longestSuffixPrefixOverlap(candidate: string, suffix: string): number {
  const max = Math.min(candidate.length, suffix.length, 512);
  for (let length = max; length >= 1; length -= 1) {
    if (candidate.endsWith(suffix.slice(0, length))) {
      return length;
    }
  }
  return 0;
}
