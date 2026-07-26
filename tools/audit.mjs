// 使用 Node.js 标准库执行 Phase 0 源码审计，不依赖第三方包。
import { readFile, readdir } from "node:fs/promises";
import { extname, join, relative } from "node:path";

const root = new URL("../", import.meta.url);
const checkedExtensions = new Set([".ts", ".tsx", ".js", ".mjs", ".json", ".cs", ".csproj", ".ps1"]);
const ignoredDirectories = new Set(["node_modules", "dist", ".git", "upstream"]);
const secretPatterns = [
  /sk-[A-Za-z0-9_-]{16,}/,
  /(?:api[_-]?key|token|password)\s*[:=]\s*["'][^"']{8,}["']/i,
];

async function collectFiles(directoryUrl) {
  const entries = await readdir(directoryUrl, { withFileTypes: true });
  const result = [];

  for (const entry of entries) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) {
      continue;
    }

    const childUrl = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, directoryUrl);
    if (entry.isDirectory()) {
      result.push(...await collectFiles(childUrl));
      continue;
    }

    if (checkedExtensions.has(extname(entry.name))) {
      result.push(childUrl);
    }
  }

  return result;
}

const files = await collectFiles(root);
const violations = [];

for (const fileUrl of files) {
  // TextDecoder 的 fatal 模式会在文件不是有效 UTF-8 时抛出异常。
  const buffer = await readFile(fileUrl);
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    violations.push(`${fileUrl.pathname}: 不是有效 UTF-8`);
    continue;
  }

  for (const pattern of secretPatterns) {
    if (pattern.test(text)) {
      violations.push(`${fileUrl.pathname}: 疑似包含硬编码密钥、令牌或密码`);
    }
  }

  if (/catch\s*\([^)]*\)\s*\{\s*\}/s.test(text) || /catch\s*\{\s*\}/s.test(text)) {
    violations.push(`${fileUrl.pathname}: 存在空 catch`);
  }
}

if (violations.length > 0) {
  console.error("源码审计失败：");
  for (const violation of violations) {
    console.error(`- ${violation}`);
  }
  process.exitCode = 1;
} else {
  console.log(`源码审计通过：检查 ${files.length} 个 UTF-8 代码与配置文件`);
}
