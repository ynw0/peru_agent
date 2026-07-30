import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { WorkspaceRegistry, WorkspaceService } from "../workspace/workspace-service.js";
import type { WorkspaceExternalResolver } from "../workspace/target-resolver.js";

export interface ExternalDirectoryGrant {
  readonly id: string;
  readonly sessionId: string;
  readonly directory: string;
  readonly createdAt: string;
}

export interface TuiExternalAccessRequest {
  readonly sessionId: string;
  readonly paths: readonly string[];
  readonly directory: string;
}

/** Volatile session-scoped mounts for files outside the active workspace. */
export class ExternalAccessCoordinator implements WorkspaceExternalResolver {
  private readonly grants = new Map<string, ExternalDirectoryGrant>();

  public constructor(private readonly workspaces: WorkspaceRegistry) {}

  public async authorizeDirectory(sessionId: string, requestedPath: string): Promise<ExternalDirectoryGrant> {
    const absolute = resolve(requestedPath);
    const status = await lstat(absolute).catch(() => undefined);
    if (status === undefined) throw new Error(`外部路径不存在：${absolute}`);
    const directory = await realpath(status.isDirectory() ? absolute : resolve(absolute, ".."));
    const id = `external-${createHash("sha256").update(directory.toLocaleLowerCase(), "utf8").digest("hex").slice(0, 24)}`;
    const existing = this.grants.get(`${sessionId}:${id}`);
    if (existing !== undefined) return existing;
    const workspace = await WorkspaceService.create(id, directory);
    if (this.workspaces.list().some(item => item.workspaceId === id) === false) this.workspaces.register(workspace);
    const grant: ExternalDirectoryGrant = { id, sessionId, directory, createdAt: new Date().toISOString() };
    this.grants.set(`${sessionId}:${id}`, grant);
    return grant;
  }

  public getWorkspace(sessionId: string, requestedPath: string): { readonly workspaceId: string; readonly relativePath: string; readonly grant: ExternalDirectoryGrant } | undefined {
    const absolute = resolve(requestedPath);
    for (const grant of this.grants.values()) {
      if (grant.sessionId !== sessionId) continue;
      const relation = relative(grant.directory, absolute);
      if (relation.startsWith("..") || isAbsolute(relation)) continue;
      return { workspaceId: grant.id, relativePath: (relation === "" ? "." : relation).replace(/\\/g, "/"), grant };
    }
    return undefined;
  }

  public getWorkspaceService(workspaceId: string): WorkspaceService {
    return this.workspaces.get(workspaceId);
  }

  public resolveExternal(sessionId: string, requestedPath: string): { readonly workspaceId: string; readonly relativePath: string } | undefined {
    const target = this.getWorkspace(sessionId, requestedPath);
    return target === undefined ? undefined : { workspaceId: target.workspaceId, relativePath: target.relativePath };
  }

  public describeAuthorizedRoots(sessionId: string): readonly string[] {
    return this.list(sessionId).map(grant => grant.directory);
  }

  public revokeSession(sessionId: string): void {
    for (const [key, grant] of this.grants) {
      if (grant.sessionId !== sessionId) continue;
      this.grants.delete(key);
      if (![...this.grants.values()].some(other => other.id === grant.id)) this.workspaces.unregister(grant.id);
    }
  }

  public list(sessionId: string): readonly ExternalDirectoryGrant[] {
    return [...this.grants.values()].filter(grant => grant.sessionId === sessionId).map(grant => structuredClone(grant));
  }
}

export function findExternalPathCandidates(value: string, workspaceRoot: string): readonly string[] {
  const matches = new Set<string>();
  const fileUrls = [...value.matchAll(/file:\/\/\/([^\s"']+)/gi)];
  for (const match of fileUrls) {
    try { matches.add(decodeURIComponent(new URL(`file:///${match[1] ?? ""}`).pathname.replace(/^\/(\w):/, "$1:"))); } catch { /* prompt remains local */ }
  }
  const paths = [
    ...value.matchAll(/["']((?:[A-Za-z]:[\\/]|\\\\)[^"']+)["']/g),
    ...value.matchAll(/(?:^|\s)((?:[A-Za-z]:[\\/]|\\\\)[^\s"']+)/g),
  ];
  for (const match of paths) {
    const candidate = match[1];
    if (candidate === undefined) continue;
    const absolute = resolve(candidate);
    const relation = relative(workspaceRoot, absolute);
    if (isAbsolute(candidate) && relation !== "" && !relation.startsWith("..") && !isAbsolute(relation)) continue;
    if (isAbsolute(candidate)) matches.add(absolute);
  }
  return [...matches];
}
