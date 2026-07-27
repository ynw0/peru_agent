export function decodeTextBody(body: Uint8Array, contentType: string): string {
  const charset = /charset\s*=\s*([^;\s]+)/i.exec(contentType)?.[1]?.replace(/["']/g, "").toLowerCase();
  if (charset !== undefined && charset !== "utf-8" && charset !== "utf8") {
    throw new Error(`当前只支持 UTF-8 文本响应：${charset}`);
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(body);
}

export function extractReadableText(content: string, contentType: string): { title?: string; text: string } {
  if (!contentType.toLowerCase().includes("html")) {
    return { text: content.trim() };
  }
  const titleMatch = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(content);
  const withoutUnsafe = content
    .replace(/<head\b[^>]*>[\s\S]*?<\/head>/gi, " ")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--([\s\S]*?)-->/g, " ");
  const text = decodeHtmlEntities(withoutUnsafe.replace(/<[^>]+>/g, " "))
    .replace(/[\t\r ]+/g, " ")
    .replace(/\n\s+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const title = titleMatch === null ? undefined : decodeHtmlEntities(titleMatch[1] ?? "").replace(/\s+/g, " ").trim();
  return { ...(title === undefined || title === "" ? {} : { title }), text };
}

function decodeHtmlEntities(value: string): string {
  const named: Readonly<Record<string, string>> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
  };
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (_match, entity: string) => {
    if (entity.startsWith("#x") || entity.startsWith("#X")) {
      const code = Number.parseInt(entity.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : "";
    }
    if (entity.startsWith("#")) {
      const code = Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : "";
    }
    return named[entity.toLowerCase()] ?? "";
  });
}
