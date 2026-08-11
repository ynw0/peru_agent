import { toolPermission, type Tool } from "../tool-runtime.js";
import type { ComputerUseRuntime } from "./runtime.js";
import type { PreparedComputerAction } from "./types.js";

interface WindowInput { readonly windowHandle: string }
interface SnapshotInput { readonly snapshotId: string }
interface ClickInput extends SnapshotInput { readonly elementId: string; readonly reason: string }
interface TypeInput extends ClickInput { readonly text: string }
interface ShortcutInput extends SnapshotInput { readonly shortcut: string; readonly reason: string }

export function createComputerUseTools(runtime: ComputerUseRuntime): readonly Tool<unknown, unknown>[] {
  const prepared = new Map<string, PreparedComputerAction>();

  const list: Tool<Record<string, never>, object> = {
    manifest: {
      name: "ComputerListWindows",
      version: "1.0.0",
      description: "列出 Windows 顶层窗口、进程身份和认证状态；不会点击或输入",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      riskLevel: "computer-use",
      capabilities: ["computer.inspect"],
      generated: false,
    },
    validate(value) { requireRecord(value); return {}; },
    inspect: () => ({ affectedFiles: [], certifiedComputerApplication: false, reason: "检查当前 Windows 窗口列表" }),
    permissions: () => toolPermission("computer_inspect", ["windows"], {}),
    execute: (_input, context) => runtime.listWindows(context.signal),
    serializeOutput: output => JSON.stringify(output),
  };

  const inspect: Tool<WindowInput, object> = {
    manifest: {
      name: "ComputerInspectWindow",
      version: "1.0.0",
      description: "读取窗口身份和 UI Automation Tree；未认证应用也只允许此操作",
      inputSchema: {
        type: "object",
        properties: { windowHandle: { type: "string" } },
        required: ["windowHandle"],
        additionalProperties: false,
      },
      riskLevel: "computer-use",
      capabilities: ["computer.inspect"],
      generated: false,
    },
    validate(value) { const item = requireRecord(value); return { windowHandle: requireString(item, "windowHandle") }; },
    inspect: () => ({ affectedFiles: [], certifiedComputerApplication: false, reason: "检查窗口 UI Tree" }),
    permissions: input => toolPermission("computer_inspect", [`window:${input.windowHandle}`], { windowHandle: input.windowHandle }),
    execute: (input, context) => runtime.inspect(input.windowHandle, context.signal),
    serializeOutput: output => JSON.stringify(output),
  };

  const screenshot: Tool<SnapshotInput, object> = {
    manifest: {
      name: "ComputerScreenshot",
      version: "1.0.0",
      description: "获取与 UI Snapshot 绑定的窗口 PNG 截图证据",
      inputSchema: snapshotSchema,
      riskLevel: "computer-use",
      capabilities: ["computer.inspect"],
      generated: false,
    },
    validate: validateSnapshot,
    inspect: () => ({ affectedFiles: [], certifiedComputerApplication: false, reason: "获取窗口截图证据" }),
    permissions: input => toolPermission("computer_inspect", [`snapshot:${input.snapshotId}`], { snapshotId: input.snapshotId }),
    execute: (input, context) => runtime.screenshot(input.snapshotId, context.signal),
    serializeOutput: output => JSON.stringify(output),
  };

  const click = interactionTool<ClickInput>(
    "ComputerClick",
    "点击认证应用中通过 Snapshot 证据绑定的元素",
    {
      type: "object",
      properties: { snapshotId: { type: "string" }, elementId: { type: "string" }, reason: { type: "string" } },
      required: ["snapshotId", "elementId", "reason"],
      additionalProperties: false,
    },
    value => {
      const item = requireRecord(value);
      return { snapshotId: requireString(item, "snapshotId"), elementId: requireString(item, "elementId"), reason: requireString(item, "reason") };
    },
    input => runtime.prepareClick(input),
  );

  const type = interactionTool<TypeInput>(
    "ComputerType",
    "向认证应用中非敏感 ValuePattern 元素输入文本",
    {
      type: "object",
      properties: {
        snapshotId: { type: "string" }, elementId: { type: "string" }, reason: { type: "string" }, text: { type: "string" },
      },
      required: ["snapshotId", "elementId", "reason", "text"],
      additionalProperties: false,
    },
    value => {
      const item = requireRecord(value);
      return {
        snapshotId: requireString(item, "snapshotId"), elementId: requireString(item, "elementId"),
        reason: requireString(item, "reason"), text: requireString(item, "text"),
      };
    },
    input => runtime.prepareType(input),
  );

  const shortcut = interactionTool<ShortcutInput>(
    "ComputerShortcut",
    "向认证应用发送清单明确允许的快捷键",
    {
      type: "object",
      properties: { snapshotId: { type: "string" }, shortcut: { type: "string" }, reason: { type: "string" } },
      required: ["snapshotId", "shortcut", "reason"],
      additionalProperties: false,
    },
    value => {
      const item = requireRecord(value);
      return { snapshotId: requireString(item, "snapshotId"), shortcut: requireString(item, "shortcut"), reason: requireString(item, "reason") };
    },
    input => runtime.prepareShortcut(input),
  );

  return [list, inspect, screenshot, click, type, shortcut];

  function interactionTool<TInput>(
    name: string,
    description: string,
    inputSchema: NonNullable<Tool<TInput, object>["manifest"]["inputSchema"]>,
    validate: (value: unknown) => TInput,
    prepare: (input: TInput) => PreparedComputerAction,
  ): Tool<TInput, object> {
    return {
      manifest: {
        name,
        version: "1.0.0",
        description,
        inputSchema,
        riskLevel: "computer-use",
        capabilities: ["computer.interact"],
        generated: false,
      },
      validate,
      inspect(input, context) {
        if (context === undefined) throw new Error(`${name} 检查需要 Tool 上下文`);
        const action = prepare(input);
        prepared.set(context.toolCallId, action);
        return {
          affectedFiles: [],
          certifiedComputerApplication: true,
          requestedCapabilities: ["computer.interact"],
          reason: action.reason,
        };
      },
      permissions(input, inspection) {
        const record = input as Record<string, unknown>;
        const snapshotId = typeof record.snapshotId === "string" ? record.snapshotId : "unknown";
        return toolPermission("computer_interact", [`${name}:${snapshotId}`], { reason: inspection.reason ?? description });
      },
      async execute(_input, context) {
        const action = prepared.get(context.toolCallId);
        if (action === undefined) throw new Error(`${name} 缺少已审核动作`);
        prepared.delete(context.toolCallId);
        return runtime.execute(action.id, context.signal);
      },
      releaseInspection(_input, context) {
        const action = prepared.get(context.toolCallId);
        if (action !== undefined) {
          runtime.discardAction(action.id);
          prepared.delete(context.toolCallId);
        }
      },
      serializeOutput: output => JSON.stringify(output),
    };
  }
}

const snapshotSchema = {
  type: "object",
  properties: { snapshotId: { type: "string" } },
  required: ["snapshotId"],
  additionalProperties: false,
} as const;

function validateSnapshot(value: unknown): SnapshotInput {
  const item = requireRecord(value);
  return { snapshotId: requireString(item, "snapshotId") };
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Computer Use 参数必须是对象");
  return value as Record<string, unknown>;
}

function requireString(value: Record<string, unknown>, key: string): string {
  const item = value[key];
  if (typeof item !== "string" || item.trim() === "") throw new Error(`${key} 必须是非空字符串`);
  return item;
}
