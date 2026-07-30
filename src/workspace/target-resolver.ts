import { isAbsolute, relative, resolve } from "node:path";
import type { WorkspaceRegistry, WorkspaceService } from "./workspace-service.js";

export interface ResolvedWorkspaceTarget {
  readonly workspaceId: string;
  readonly relativePath: string;
  readonly workspace: WorkspaceService;
  readonly absolutePath: string;
  readonly external: boolean;
}

export interface WorkspaceExternalResolver {
  resolveExternal(sessionId: string, requestedPath: string): { readonly workspaceId: string; readonly relativePath: string } | undefined;
  describeAuthorizedRoots?(sessionId: string): readonly string[];
}

/** Single path gate for all file/document tools. Registry membership alone is not authorization. */
export class WorkspaceTargetResolver {
  private external: WorkspaceExternalResolver | undefined;

  public constructor(private readonly registry: WorkspaceRegistry) {}

  public setExternalResolver(external: WorkspaceExternalResolver): void { this.external = external; }

  public resolve(sessionId: string, activeWorkspaceId: string, requestedPath: string): ResolvedWorkspaceTarget {
    if (!isAbsolute(requestedPath)) {
      const workspace = this.registry.get(activeWorkspaceId);
      const normalized = requestedPath.replace(/\\/g, "/");
      return { workspaceId: activeWorkspaceId, relativePath: normalized, workspace, absolutePath: resolve(workspace.root, normalized), external: false };
    }
    const activeWorkspace = this.registry.get(activeWorkspaceId);
    const activeAbsolute = resolve(requestedPath);
    const activeRelation = relative(activeWorkspace.root, activeAbsolute);
    if (activeRelation !== "" && !activeRelation.startsWith("..") && !isAbsolute(activeRelation)) {
      return { workspaceId: activeWorkspaceId, relativePath: activeRelation.replace(/\\/g, "/"), workspace: activeWorkspace, absolutePath: activeAbsolute, external: false };
    }
    const external = this.external?.resolveExternal(sessionId, requestedPath);
    if (external === undefined) {
      const roots = this.external?.describeAuthorizedRoots?.(sessionId) ?? [];
      throw new Error(`外部路径尚未授权：${requestedPath}；执行会话=${sessionId}；当前授权根=${roots.join(", ") || "无"}`);
    }
    const workspace = this.registry.get(external.workspaceId);
    const relativePath = external.relativePath === "" ? "." : external.relativePath;
    const absolutePath = resolve(workspace.root, relativePath);
    const relation = relative(workspace.root, absolutePath);
    if (relation.startsWith("..") || isAbsolute(relation)) throw new Error(`外部路径越界：${requestedPath}`);
    return { workspaceId: workspace.workspaceId, relativePath: relativePath.replace(/\\/g, "/"), workspace, absolutePath, external: true };
  }
}
