import { useEffect, useState, type ReactNode } from "react";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import {
  checkTuiHealth,
  loadTuiConfiguration,
  writeTuiConfiguration,
  type TuiConfiguration,
  type TuiHealthReport,
  type TuiSetupDraft,
} from "../../src/tui/config.js";
import {
  createTuiConfigurationEditor,
  reduceTuiConfigurationEditor,
  setTuiConfigurationEditorBusy,
  setTuiConfigurationEditorStatus,
  setTuiConfigurationEditorWidth,
  TUI_CONFIGURATION_FIELDS,
  type TuiConfigurationEditorState,
} from "../../src/tui/view-state.js";
import { getTuiInputWindow } from "../../src/tui/terminal-layout.js";
import { adaptOpenTuiKey } from "../../src/tui/opentui-key-adapter.js";

export interface OpenTuiSetupProps {
  readonly draft: TuiSetupDraft;
  readonly reason?: string;
  readonly onConfigured: (configuration: TuiConfiguration) => void;
  readonly onCancel: (error: Error) => void;
}

export interface OpenTuiConfigurationEditorResult {
  readonly keepOpen?: boolean;
  readonly status?: string;
  readonly health?: TuiHealthReport;
}

export interface OpenTuiConfigurationEditorProps {
  readonly draft: TuiSetupDraft;
  readonly reason?: string;
  readonly title: string;
  readonly submitStatus: string;
  readonly embedded?: boolean;
  readonly onSubmitDraft: (draft: TuiSetupDraft) => Promise<OpenTuiConfigurationEditorResult | void>;
  readonly onCancel: () => void;
}

export function OpenTuiSetup({ draft, reason, onConfigured, onCancel }: OpenTuiSetupProps): ReactNode {
  return (
    <OpenTuiConfigurationEditor
      draft={draft}
      {...(reason === undefined ? {} : { reason })}
      title="peru_agent · OpenTUI 配置"
      submitStatus="正在检查模型端点和 Sandbox Broker…"
      onCancel={() => onCancel(new Error("OpenTUI 配置向导已取消"))}
      onSubmitDraft={async nextDraft => {
        const health = await checkTuiHealth(nextDraft);
        if (!health.ok) {
          return { keepOpen: true, status: "检查未通过：修正字段后再次按 Enter。", health };
        }
        await writeTuiConfiguration(nextDraft);
        const configuration = await loadTuiConfiguration(nextDraft.configPath);
        onConfigured(configuration);
      }}
    />
  );
}

export function OpenTuiConfigurationEditor({
  draft,
  reason,
  title,
  submitStatus,
  embedded = false,
  onSubmitDraft,
  onCancel,
}: OpenTuiConfigurationEditorProps): ReactNode {
  const [state, setState] = useState<TuiConfigurationEditorState>(() => createTuiConfigurationEditor(draft, reason));
  const { width } = useTerminalDimensions();

  useEffect(() => {
    setState(current => setTuiConfigurationEditorWidth(current, Math.max(24, width - 34)));
  }, [width]);

  useKeyboard(event => {
    if (state.busy) return;
    const input = adaptOpenTuiKey(event);
    const transition = reduceTuiConfigurationEditor(state, input.value, input.key);
    if (transition.cancelled === true) {
      event.preventDefault();
      event.stopPropagation();
      onCancel();
      return;
    }
    setState(transition.state);
    if (transition.submitted !== undefined) void submit(transition.submitted);
    event.preventDefault();
    event.stopPropagation();
  });

  async function submit(nextDraft: TuiSetupDraft): Promise<void> {
    setState(current => setTuiConfigurationEditorBusy(
      setTuiConfigurationEditorStatus(current, submitStatus),
      true,
    ));
    try {
      const result = await onSubmitDraft(nextDraft);
      if (result?.keepOpen === true) {
        setState(current => setTuiConfigurationEditorBusy(
          setTuiConfigurationEditorStatus(current, result.status ?? "请修正配置后重试", result.health),
          false,
        ));
      }
    } catch (error: unknown) {
      setState(current => setTuiConfigurationEditorBusy(
        setTuiConfigurationEditorStatus(current, error instanceof Error ? error.message : "配置应用失败"),
        false,
      ));
    }
  }

  const container = embedded
    ? {
        position: "absolute" as const,
        left: "5%" as const,
        top: "5%" as const,
        width: "90%" as const,
        height: "90%" as const,
        zIndex: 200,
        border: true,
        borderStyle: "double" as const,
        borderColor: "#f4a261",
        backgroundColor: "#0d1117",
      }
    : { width: "100%" as const, height: "100%" as const };

  return (
    <box flexDirection="column" padding={2} {...container}>
      <text fg="#f4a261"><strong>{title}</strong></text>
      <text fg="#8b949e">{state.status}</text>
      <text fg="#8b949e">↑/↓ 或 Tab 选择 · Enter 下一项/保存 · ←/→ 或 Space 切换 · Esc 取消</text>
      <box flexDirection="column" marginTop={1}>
        {TUI_CONFIGURATION_FIELDS.map((field, index) => {
          const selected = index === state.fieldIndex;
          const value = selected ? state.input.text : configurationFieldValue(state.draft, field);
          return (
            <box key={field} flexDirection="row">
              <text fg={selected ? "#f4a261" : "#8b949e"}>{selected ? "› " : "  "}</text>
              <text fg={selected ? "#ffffff" : "#c9d1d9"}>{configurationFieldLabel(field)}：</text>
              {selected ? <ConfigurationInput state={state} value={value} /> : <text>{maskedValue(field, value)}</text>}
            </box>
          );
        })}
      </box>
      {state.health !== undefined && (
        <box flexDirection="column" marginTop={1}>
          {state.health.messages.map((message, index) => (
            <text key={`health-${index}`} fg={state.health?.ok === true ? "#3fb950" : "#f85149"}>{message}</text>
          ))}
        </box>
      )}
      <text fg="#8b949e">配置文件：{draft.configPath}</text>
    </box>
  );
}

function ConfigurationInput({ state, value }: { readonly state: TuiConfigurationEditorState; readonly value: string }): ReactNode {
  if (state.fieldIndex >= TUI_CONFIGURATION_FIELDS.length - 1) return <text fg="#58a6ff">{value}</text>;
  const field = TUI_CONFIGURATION_FIELDS[state.fieldIndex] ?? "save";
  const display = maskedValue(field, value);
  const window = getTuiInputWindow(display, state.input.cursor, state.horizontalWidth);
  return <text><span fg="#58a6ff">{window.before}</span><span fg="#f4a261">▌</span><span fg="#58a6ff">{window.after}</span></text>;
}

function configurationFieldLabel(field: typeof TUI_CONFIGURATION_FIELDS[number]): string {
  switch (field) {
    case "baseUrl": return "模型地址";
    case "chatCompletionsPath": return "Chat Completions 路径";
    case "model": return "模型名称";
    case "apiKey": return "API Key";
    case "contextWindowTokens": return "上下文窗口 Token";
    case "permissionMode": return "默认权限模式";
    case "networkMode": return "网络模式";
    case "save": return "保存并检查";
  }
}

function configurationFieldValue(draft: TuiSetupDraft, field: typeof TUI_CONFIGURATION_FIELDS[number]): string {
  return field === "save" ? "Enter 执行 / Esc 取消" : draft[field];
}

function maskedValue(field: typeof TUI_CONFIGURATION_FIELDS[number], value: string): string {
  return field === "apiKey" && value !== "" ? "•".repeat(value.length) : value;
}
