import type { AgentUserInput, AgentUserAttachment } from "../agent/types.js";
import { sha256Text } from "../workspace/workspace-service.js";
import type { WorkspaceService } from "../workspace/workspace-service.js";
import { extname, isAbsolute, relative, resolve } from "node:path";
import { lstat } from "node:fs/promises";
import type { ExternalAccessCoordinator } from "./external-access.js";

export async function buildAgentUserInput(content: string, workspace: WorkspaceService): Promise<AgentUserInput> {
  const candidates = [...content.matchAll(/@(?:"([^"]+)"|(\S+))/g)].map(match => match[1] ?? match[2] ?? "").filter((value): value is string => value !== null && value !== "");
  const unique = [...new Set(candidates)].slice(0, 10);
  if (candidates.length > 10) throw new Error("一次最多附加 10 个文件");
  const attachments: AgentUserAttachment[] = [];
  let total = 0;
  for (const path of unique) {
    const normalizedPath = isAbsolute(path) ? relative(workspace.root, resolve(path)).replace(/\\/g, "/") : path;
    if (normalizedPath === "" || normalizedPath.startsWith("..") || isAbsolute(normalizedPath)) throw new Error(`附件必须位于当前工作区：${path}`);
    const snapshot = await workspace.readText(normalizedPath);
    if (snapshot.content === null) throw new Error(`附件不是可读取文本文件：${path}`);
    const bytes = new TextEncoder().encode(snapshot.content).byteLength;
    if (bytes > 256 * 1024) throw new Error(`附件超过 256 KiB：${path}`);
    total += bytes;
    if (total > 512 * 1024) throw new Error("附件总大小超过 512 KiB");
    attachments.push({ kind: "workspace-file", path: snapshot.path, content: snapshot.content, sha256: sha256Text(snapshot.content), byteLength: bytes });
  }
  return attachments.length === 0 ? { content } : { content, displayContent: content.replace(/@(?:"[^"]+"|\S+)/g, match => match), attachments };
}

export async function buildAuthorizedExternalUserInput(
  content: string,
  paths: readonly string[],
  access: ExternalAccessCoordinator,
  sessionId: string,
): Promise<AgentUserInput> {
  const attachments: AgentUserAttachment[] = [];
  let total = 0;
  for (const rawPath of [...new Set(paths)].slice(0, 10)) {
    const absolute = resolve(rawPath);
    const status = await lstat(absolute).catch(() => undefined);
    if (status?.isDirectory() === true) continue;
    if (status === undefined) throw new Error(`外部路径不存在：${absolute}`);
    const target = access.getWorkspace(sessionId, absolute);
    if (target === undefined) throw new Error(`未授权访问外部文件：${absolute}`);
    const workspace = access.getWorkspaceService(target.workspaceId);
    const extension = extname(absolute).toLocaleLowerCase();
    const binary = [".xlsx", ".pdf", ".docx"].includes(extension);
    if (binary) {
      const snapshot = await workspace.readBytes(target.relativePath);
      if (!snapshot.exists || snapshot.sha256 === null) throw new Error(`外部文件不存在：${absolute}`);
      if (snapshot.byteLength > 32 * 1024 * 1024) throw new Error(`外部文件超过 32 MiB：${absolute}`);
      attachments.push({ kind: "external-file", path: absolute, sha256: snapshot.sha256, byteLength: snapshot.byteLength, binary: true, mediaType: mediaTypeFor(extension) });
      continue;
    }
    const snapshot = await workspace.readText(target.relativePath);
    const text = snapshot.content ?? "";
    const bytes = new TextEncoder().encode(text).byteLength;
    if (bytes > 256 * 1024) throw new Error(`附件超过 256 KiB：${absolute}`);
    total += bytes;
    if (total > 512 * 1024) throw new Error("附件总大小超过 512 KiB");
    attachments.push({ kind: "external-file", path: absolute, content: text, sha256: snapshot.sha256 ?? sha256Text(text), byteLength: bytes, mediaType: "text/plain" });
  }
  const grants = access.list(sessionId).map(item => item.directory);
  const grantNotice = grants.length === 0 ? "" : `\n\n[Peru Agent 授权提示：本会话可通过文件 Tool 访问以下目录：${grants.join("、")}]`;
  return attachments.length === 0
    ? { content: `${content}${grantNotice}`, displayContent: content }
    : { content: `${content}${grantNotice}`, displayContent: content, attachments };
}

function mediaTypeFor(extension: string): string {
  if (extension === ".xlsx") return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  if (extension === ".pdf") return "application/pdf";
  if (extension === ".docx") return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  return "application/octet-stream";
}

export function formatCollapsedInput(value: string, limit = 10_000): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, 500)}\n… [已折叠 ${value.length - 1000} 字符，Session 保留完整内容] …\n${value.slice(-500)}`;
}
