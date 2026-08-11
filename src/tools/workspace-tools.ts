import type { CheckpointManager } from "../checkpoint/checkpoint-manager.js";
import type { DiffManager } from "../diff/diff-manager.js";
import type { DiffReviewCoordinator } from "../diff/diff-review-coordinator.js";
import { noToolPermissions, toolPermission, type Tool } from "../tool-runtime.js";
import type { WorkspaceRegistry } from "../workspace/workspace-service.js";
import type { WorkspaceTargetResolver } from "../workspace/target-resolver.js";

interface PathInput {
  readonly path: string;
}

interface WriteInput extends PathInput {
  readonly content: string;
}

interface EditInput extends PathInput {
  readonly oldText: string;
  readonly newText: string;
  readonly replaceAll: boolean;
}

interface PatchEdit {
  readonly oldText: string;
  readonly newText: string;
  readonly replaceAll: boolean;
}

interface ApplyPatchInput extends PathInput {
  readonly edits: readonly PatchEdit[];
}

interface GlobInput {
  readonly pattern: string;
  readonly maxResults: number;
  readonly root?: string;
}

interface GrepInput {
  readonly query: string;
  readonly pattern: string;
  readonly caseSensitive: boolean;
  readonly maxResults: number;
  readonly root?: string;
}

interface DiffInput {
  readonly proposalId: string;
}

interface CheckpointInput {
  readonly checkpointId: string;
}

function asRecord(value: unknown, label = "参数"): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label}必须是对象`);
  }
  return value as Record<string, unknown>;
}

function requireString(record: Record<string, unknown>, name: string, allowEmpty = false): string {
  const value = record[name];
  if (typeof value !== "string" || (!allowEmpty && value.trim() === "")) {
    throw new Error(`${name} 必须是${allowEmpty ? "" : "非空"}字符串`);
  }
  return value;
}

function optionalBoolean(record: Record<string, unknown>, name: string, defaultValue: boolean): boolean {
  const value = record[name];
  if (value === undefined) {
    return defaultValue;
  }
  if (typeof value !== "boolean") {
    throw new Error(`${name} 必须是布尔值`);
  }
  return value;
}

function optionalPositiveInteger(
  record: Record<string, unknown>,
  name: string,
  defaultValue: number,
  maximum: number,
): number {
  const value = record[name];
  if (value === undefined) {
    return defaultValue;
  }
  if (!Number.isInteger(value) || Number(value) <= 0 || Number(value) > maximum) {
    throw new Error(`${name} 必须是 1~${maximum} 的整数`);
  }
  return Number(value);
}

function replaceText(content: string, oldText: string, newText: string, replaceAll: boolean): string {
  if (oldText === "") {
    throw new Error("oldText 不能为空");
  }
  const occurrences = content.split(oldText).length - 1;
  if (occurrences === 0) {
    throw new Error("文件中没有找到 oldText");
  }
  if (occurrences > 1 && !replaceAll) {
    throw new Error(`oldText 出现 ${occurrences} 次；必须明确设置 replaceAll=true`);
  }
  return replaceAll ? content.split(oldText).join(newText) : content.replace(oldText, newText);
}

export interface WorkspaceToolDependencies {
  readonly workspaces: WorkspaceRegistry;
  readonly targetResolver?: WorkspaceTargetResolver;
  readonly diffs: DiffManager;
  readonly checkpoints: CheckpointManager;
  readonly diffReviews?: DiffReviewCoordinator;
}

export function createWorkspaceTools(dependencies: WorkspaceToolDependencies): readonly Tool<unknown, unknown>[] {
  const target = (context: { readonly sessionId: string; readonly workspaceId: string }, path: string) => dependencies.targetResolver?.resolve(context.sessionId, context.workspaceId, path)
    ?? { workspaceId: context.workspaceId, relativePath: path, workspace: dependencies.workspaces.get(context.workspaceId) };
  const readTool: Tool<PathInput, object> = {
    manifest: {
      name: "read",
      version: "1.0.0",
      description: "读取当前工作区或当前 Session 已授权外部目录中的 UTF-8 文本文件，并返回内容和 SHA-256",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
        additionalProperties: false,
      },
      riskLevel: "workspace-read",
      capabilities: ["workspace.read"],
      generated: false,
    },
    validate(value) {
      const record = asRecord(value);
      return { path: requireString(record, "path") };
    },
    inspect: input => ({ affectedFiles: [input.path], certifiedComputerApplication: false }),
    permissions: input => toolPermission("read", [input.path]),
    execute: async (input, context) => {
      const resolved = target(context, input.path);
      const snapshot = await resolved.workspace.readText(resolved.relativePath);
      return {
        path: snapshot.path,
        content: snapshot.content,
        sha256: snapshot.sha256,
        byteLength: snapshot.byteLength,
      };
    },
    serializeOutput: output => JSON.stringify(output),
  };

  const writeTool: Tool<WriteInput, object> = {
    manifest: {
      name: "write",
      version: "1.0.0",
      description: "提出创建或完整替换一个 UTF-8 文本文件的 Diff，不直接写入磁盘",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" }, content: { type: "string" } },
        required: ["path", "content"],
        additionalProperties: false,
      },
      riskLevel: "workspace-write",
      capabilities: ["workspace.propose"],
      generated: false,
    },
    validate(value) {
      const record = asRecord(value);
      return {
        path: requireString(record, "path"),
        content: requireString(record, "content", true),
      };
    },
    inspect: input => ({ affectedFiles: [input.path], certifiedComputerApplication: false }),
    permissions: input => toolPermission("edit", [input.path]),
    execute: async (input, context) => {
      const resolved = target(context, input.path);
      const proposal = await dependencies.diffs.propose({
        sessionId: context.sessionId,
        workspaceId: resolved.workspaceId,
        toolCallId: context.toolCallId,
        changes: [{ path: resolved.relativePath, afterContent: input.content }],
      });
      if (context.workspaceWriteMode === "isolatedAutoApply") return dependencies.diffs.accept(proposal.id);
      return dependencies.diffReviews === undefined ? proposal : dependencies.diffReviews.awaitResolution(proposal.id, context.sessionId, context.signal);
    },
    serializeOutput: output => JSON.stringify(output),
  };

  const editTool: Tool<EditInput, object> = {
    manifest: {
      name: "edit",
      version: "1.0.0",
      description: "精确替换文件中的文本并提出 Diff，不直接写入磁盘",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          oldText: { type: "string" },
          newText: { type: "string" },
          replaceAll: { type: "boolean" },
        },
        required: ["path", "oldText", "newText"],
        additionalProperties: false,
      },
      riskLevel: "workspace-write",
      capabilities: ["workspace.read", "workspace.propose"],
      generated: false,
    },
    validate(value) {
      const record = asRecord(value);
      return {
        path: requireString(record, "path"),
        oldText: requireString(record, "oldText"),
        newText: requireString(record, "newText", true),
        replaceAll: optionalBoolean(record, "replaceAll", false),
      };
    },
    inspect: input => ({ affectedFiles: [input.path], certifiedComputerApplication: false }),
    permissions: input => toolPermission("edit", [input.path]),
    execute: async (input, context) => {
      const resolved = target(context, input.path);
      const current = await resolved.workspace.readText(resolved.relativePath);
      const afterContent = replaceText(current.content ?? "", input.oldText, input.newText, input.replaceAll);
      const proposal = await dependencies.diffs.propose({
        sessionId: context.sessionId,
        workspaceId: resolved.workspaceId,
        toolCallId: context.toolCallId,
        changes: [{ path: current.path, afterContent }],
      });
      if (context.workspaceWriteMode === "isolatedAutoApply") return dependencies.diffs.accept(proposal.id);
      return dependencies.diffReviews === undefined ? proposal : dependencies.diffReviews.awaitResolution(proposal.id, context.sessionId, context.signal);
    },
    serializeOutput: output => JSON.stringify(output),
  };

  const applyPatchTool: Tool<ApplyPatchInput, object> = {
    manifest: {
      name: "apply_patch",
      version: "1.0.0",
      description: "按顺序执行多个精确文本替换并提出一个 Diff，不直接写入磁盘",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          edits: {
            type: "array",
            items: {
              type: "object",
              properties: {
                oldText: { type: "string" },
                newText: { type: "string" },
                replaceAll: { type: "boolean" },
              },
              required: ["oldText", "newText"],
              additionalProperties: false,
            },
          },
        },
        required: ["path", "edits"],
        additionalProperties: false,
      },
      riskLevel: "workspace-write",
      capabilities: ["workspace.read", "workspace.propose"],
      generated: false,
    },
    validate(value) {
      const record = asRecord(value);
      if (!Array.isArray(record.edits) || record.edits.length === 0 || record.edits.length > 100) {
        throw new Error("edits 必须是包含 1~100 项的数组");
      }
      const edits = record.edits.map((item, index) => {
        const edit = asRecord(item, `edits[${index}]`);
        return {
          oldText: requireString(edit, "oldText"),
          newText: requireString(edit, "newText", true),
          replaceAll: optionalBoolean(edit, "replaceAll", false),
        };
      });
      return { path: requireString(record, "path"), edits };
    },
    inspect: input => ({ affectedFiles: [input.path], certifiedComputerApplication: false }),
    permissions: input => toolPermission("edit", [input.path]),
    execute: async (input, context) => {
      const resolved = target(context, input.path);
      const current = await resolved.workspace.readText(resolved.relativePath);
      let afterContent = current.content ?? "";
      for (const edit of input.edits) {
        afterContent = replaceText(afterContent, edit.oldText, edit.newText, edit.replaceAll);
      }
      const proposal = await dependencies.diffs.propose({
        sessionId: context.sessionId,
        workspaceId: resolved.workspaceId,
        toolCallId: context.toolCallId,
        changes: [{ path: current.path, afterContent }],
      });
      if (context.workspaceWriteMode === "isolatedAutoApply") return dependencies.diffs.accept(proposal.id);
      return dependencies.diffReviews === undefined ? proposal : dependencies.diffReviews.awaitResolution(proposal.id, context.sessionId, context.signal);
    },
    serializeOutput: output => JSON.stringify(output),
  };

  const globTool: Tool<GlobInput, object> = {
    manifest: {
      name: "glob",
      version: "1.0.0",
      description: "按 Glob 模式列出当前工作区或已授权外部目录中的文件；root 可使用已授权绝对目录",
      inputSchema: {
        type: "object",
        properties: {
          pattern: { type: "string" },
          maxResults: { type: "number" },
          root: { type: "string" },
        },
        required: ["pattern"],
        additionalProperties: false,
      },
      riskLevel: "workspace-read",
      capabilities: ["workspace.read"],
      generated: false,
    },
    validate(value) {
      const record = asRecord(value);
      const root = record.root === undefined ? undefined : requireString(record, "root");
      return {
        pattern: requireString(record, "pattern"),
        maxResults: optionalPositiveInteger(record, "maxResults", 200, 10_000),
        ...(root === undefined ? {} : { root }),
      };
    },
    inspect: () => ({ affectedFiles: [], certifiedComputerApplication: false }),
    permissions: input => toolPermission("glob", [input.pattern], { root: input.root ?? "." }),
    execute: async (input, context) => ({
      paths: await (input.root === undefined ? dependencies.workspaces.get(context.workspaceId) : target(context, input.root).workspace).glob(input.pattern, input.maxResults),
    }),
    serializeOutput: output => JSON.stringify(output),
  };

  const grepTool: Tool<GrepInput, object> = {
    manifest: {
      name: "grep",
      version: "1.0.0",
      description: "在当前工作区或已授权外部目录的 UTF-8 文本文件中搜索字符串；root 可使用已授权绝对目录",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
          pattern: { type: "string" },
          caseSensitive: { type: "boolean" },
          maxResults: { type: "number" },
          root: { type: "string" },
        },
        required: ["query"],
        additionalProperties: false,
      },
      riskLevel: "workspace-read",
      capabilities: ["workspace.read"],
      generated: false,
    },
    validate(value) {
      const record = asRecord(value);
      const root = record.root === undefined ? undefined : requireString(record, "root");
      return {
        query: requireString(record, "query"),
        pattern: typeof record.pattern === "string" ? record.pattern : "**/*",
        caseSensitive: optionalBoolean(record, "caseSensitive", false),
        maxResults: optionalPositiveInteger(record, "maxResults", 200, 10_000),
        ...(root === undefined ? {} : { root }),
      };
    },
    inspect: () => ({ affectedFiles: [], certifiedComputerApplication: false }),
    permissions: input => toolPermission("grep", [input.query], { pattern: input.pattern, root: input.root ?? "." }),
    execute: async (input, context) => ({
      matches: await (input.root === undefined ? dependencies.workspaces.get(context.workspaceId) : target(context, input.root).workspace).grep(
        input.query,
        input.pattern,
        input.caseSensitive,
        input.maxResults,
      ),
    }),
    serializeOutput: output => JSON.stringify(output),
  };

  const diffTool: Tool<DiffInput, object> = {
    manifest: {
      name: "file_diff",
      version: "1.0.0",
      description: "读取一个已经提出的 Diff Proposal",
      inputSchema: {
        type: "object",
        properties: { proposalId: { type: "string" } },
        required: ["proposalId"],
        additionalProperties: false,
      },
      riskLevel: "workspace-read",
      capabilities: ["workspace.read"],
      generated: false,
    },
    validate(value) {
      const record = asRecord(value);
      return { proposalId: requireString(record, "proposalId") };
    },
    inspect: () => ({ affectedFiles: [], certifiedComputerApplication: false }),
    permissions: noToolPermissions,
    execute: async input => {
      const proposal = dependencies.diffs.get(input.proposalId);
      if (proposal === undefined) {
        throw new Error(`Diff Proposal 不存在：${input.proposalId}`);
      }
      return proposal;
    },
    serializeOutput: output => JSON.stringify(output),
  };

  const checkpointTool: Tool<CheckpointInput, object> = {
    manifest: {
      name: "checkpoint_read",
      version: "1.0.0",
      description: "读取一个 Checkpoint 的文件快照和状态",
      inputSchema: {
        type: "object",
        properties: { checkpointId: { type: "string" } },
        required: ["checkpointId"],
        additionalProperties: false,
      },
      riskLevel: "workspace-read",
      capabilities: ["workspace.read"],
      generated: false,
    },
    validate(value) {
      const record = asRecord(value);
      return { checkpointId: requireString(record, "checkpointId") };
    },
    inspect: () => ({ affectedFiles: [], certifiedComputerApplication: false }),
    permissions: noToolPermissions,
    execute: async input => {
      const checkpoint = await dependencies.checkpoints.get(input.checkpointId);
      if (checkpoint === undefined) {
        throw new Error(`Checkpoint 不存在：${input.checkpointId}`);
      }
      return checkpoint;
    },
    serializeOutput: output => JSON.stringify(output),
  };

  return [
    readTool,
    writeTool,
    editTool,
    applyPatchTool,
    globTool,
    grepTool,
    diffTool,
    checkpointTool,
  ] as readonly Tool<unknown, unknown>[];
}
