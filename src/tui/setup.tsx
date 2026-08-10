import { useEffect, useState, type ReactElement } from "react";
import { Box, Text, render, useInput, useWindowSize } from "ink";
import {
  checkTuiHealth,
  loadTuiConfiguration,
  writeTuiConfiguration,
  type TuiConfiguration,
  type TuiHealthReport,
  type TuiSetupDraft,
} from "./config.js";
import {
  createTuiConfigurationEditor,
  reduceTuiConfigurationEditor,
  setTuiConfigurationEditorBusy,
  setTuiConfigurationEditorStatus,
  setTuiConfigurationEditorWidth,
  TUI_CONFIGURATION_FIELDS,
  type TuiConfigurationEditorState,
} from "./view-state.js";
import { getTuiInputWindow } from "./terminal-layout.js";
import { parseTuiMouseInput } from "./mouse.js";

export interface TuiConfigurationEditorProps {
  readonly initialDraft: TuiSetupDraft;
  readonly reason?: string;
  readonly onSubmit: (draft: TuiSetupDraft) => Promise<void>;
  readonly onCancel: () => void;
  readonly embedded?: boolean;
}

export async function runTuiSetupWizard(
  draft: TuiSetupDraft,
  reason?: string,
): Promise<TuiConfiguration> {
  return new Promise<TuiConfiguration>((resolve, reject) => {
    let application: ReturnType<typeof render> | undefined;
    const onCancel = (): void => {
      application?.unmount();
      reject(new Error("TUI 配置向导已取消"));
    };
    const onSubmit = async (nextDraft: TuiSetupDraft): Promise<void> => {
      await writeTuiConfiguration(nextDraft);
      const configuration = await loadTuiConfiguration(nextDraft.configPath);
      application?.unmount();
      resolve(configuration);
    };
    application = render(
      <TuiConfigurationEditor
        initialDraft={draft}
        {...(reason === undefined ? {} : { reason })}
        onSubmit={onSubmit}
        onCancel={onCancel}
      />,
      { alternateScreen: true, exitOnCtrlC: false },
    );
  });
}

export function TuiConfigurationEditor({
  initialDraft,
  reason,
  onSubmit,
  onCancel,
  embedded = false,
}: TuiConfigurationEditorProps): ReactElement {
  const [state, setState] = useState<TuiConfigurationEditorState>(() =>
    createTuiConfigurationEditor(initialDraft, reason),
  );
  const { columns } = useWindowSize();

  useEffect(() => {
    setState(current => setTuiConfigurationEditorWidth(current, Math.max(24, columns - 34)));
  }, [columns]);

  useInput((value, key) => {
    if (parseTuiMouseInput(value) !== undefined) return;
    if (state.busy) return;
    const transition = reduceTuiConfigurationEditor(state, value, key);
    if (transition.cancelled === true) {
      onCancel();
      return;
    }
    setState(transition.state);
    if (transition.submitted !== undefined) void submit(transition.submitted);
  });

  async function submit(draft: TuiSetupDraft): Promise<void> {
    setState(current => setTuiConfigurationEditorBusy(
      setTuiConfigurationEditorStatus(current, "正在检查模型端点和 Sandbox Broker…"),
      true,
    ));
    try {
      const health = await checkTuiHealth(draft);
      if (!health.ok) {
          setState(current => setTuiConfigurationEditorBusy(
          setTuiConfigurationEditorStatus(current, "检查未通过：修正字段后再次按 Enter。", health),
          false,
        ));
        return;
      }
      setState(current => setTuiConfigurationEditorStatus(current, "检查通过，正在应用配置…", health));
      await onSubmit(draft);
    } catch (error: unknown) {
      setState(current => setTuiConfigurationEditorBusy(
        setTuiConfigurationEditorStatus(current, error instanceof Error ? error.message : "配置保存失败"),
        false,
      ));
    }
  }

  const fields = TUI_CONFIGURATION_FIELDS.map(field => ({
    field,
    label: configurationFieldLabel(field),
    value: field === TUI_CONFIGURATION_FIELDS[state.fieldIndex]
      ? state.input.text
      : configurationFieldDisplayValue(state.draft, field),
  }));
  const content = (
    <Box flexDirection="column" paddingX={embedded ? 1 : 2} paddingY={embedded ? 0 : 1}>
      <Text bold color="magenta">peru_agent TUI 配置{embedded ? "" : "向导"}</Text>
      <Text dimColor>{state.status}</Text>
      <Text dimColor>↑/↓ 或 Tab 选择，Enter 下一项/保存，←/→ 或 Space 切换，Esc 取消；Broker 路径由当前安装包自动解析</Text>
      <Box flexDirection="column" marginTop={1}>
        {fields.map((field, index) => (
          <Box key={field.field}>
            {index === state.fieldIndex ? <Text color="yellow">› </Text> : <Text>  </Text>}
            <Text bold={index === state.fieldIndex}>{field.label}：</Text>
            {index === state.fieldIndex
              ? <ConfigurationFieldInput state={state} value={field.value} />
              : <Text>{field.value}</Text>}
          </Box>
        ))}
      </Box>
      {state.health !== undefined && (
        <Box flexDirection="column" marginTop={1}>
          {state.health.messages.map((message, index) => <Text key={`health-${index}`} color={state.health?.ok === true ? "green" : "red"}>{message}</Text>)}
        </Box>
      )}
      <Box marginTop={1}><Text dimColor>配置文件：{initialDraft.configPath}</Text></Box>
    </Box>
  );
  return embedded
    ? <Box borderStyle="single" borderColor="gray" backgroundColor="black" paddingX={1} paddingY={1} width="90%">{content}</Box>
    : content;
}

function ConfigurationFieldInput({ state, value }: { readonly state: TuiConfigurationEditorState; readonly value: string }): ReactElement {
  if (state.fieldIndex >= TUI_CONFIGURATION_FIELDS.length - 1) return <Text color="cyan">{value}</Text>;
  const field = TUI_CONFIGURATION_FIELDS[state.fieldIndex];
  const displayValue = field === "apiKey" && value !== "" ? "•".repeat(value.length) : value;
  const window = getTuiInputWindow(displayValue, state.input.cursor, state.horizontalWidth);
  return <>
    <Text color="cyan">{window.before}</Text>
    <Text color="yellow">▌</Text>
    <Text color="cyan">{window.after}</Text>
  </>;
}

function configurationFieldLabel(field: typeof TUI_CONFIGURATION_FIELDS[number]): string {
  switch (field) {
    case "baseUrl": return "模型地址";
    case "chatCompletionsPath": return "Chat Completions 路径";
    case "model": return "模型名称";
    case "apiKey": return "API Key（直接填写）";
    case "contextWindowTokens": return "上下文窗口 Token";
    case "permissionMode": return "默认权限模式";
    case "networkMode": return "网络模式";
    case "save": return "保存并检查";
  }
}

function configurationFieldValue(
  draft: TuiSetupDraft,
  field: typeof TUI_CONFIGURATION_FIELDS[number],
): string {
  if (field === "save") return "Enter 执行 / Esc 取消";
  return draft[field];
}

function configurationFieldDisplayValue(
  draft: TuiSetupDraft,
  field: typeof TUI_CONFIGURATION_FIELDS[number],
): string {
  const value = configurationFieldValue(draft, field);
  return field === "apiKey" && value !== "" ? "•".repeat(value.length) : value;
}
