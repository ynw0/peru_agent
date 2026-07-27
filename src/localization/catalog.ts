import type { LocalizedCatalog, SupportedLocale } from "./types.js";

export const UI_MESSAGE_KEYS = [
  "runtime.disconnected", "error.unknown", "status.label", "token.label",
  "role.user", "role.ai", "role.aiStreaming", "chat.placeholder", "action.send", "action.stop", "action.retry",
  "tasks.planReview", "tasks.subagents", "tasks.tools", "tasks.diffReview", "tasks.checkpoints",
  "permissions.empty", "action.allowOnce", "action.deny", "browser.title", "browser.create",
  "computer.title", "computer.inspectOnlyNotice", "evolution.title", "evolution.refresh",
  "release.title", "release.locale", "release.version", "release.channel", "release.productionReady",
  "release.blockers", "release.refresh", "release.zhCN", "release.enUS", "boolean.yes", "boolean.no",
] as const;

export type UiMessageKey = typeof UI_MESSAGE_KEYS[number];

const zhCN: LocalizedCatalog<UiMessageKey> = {
  locale: "zh-CN",
  messages: {
    "runtime.disconnected": "Agent Runtime 未连接。不会执行任何本地操作。",
    "error.unknown": "未知操作错误",
    "status.label": "状态：{status}",
    "token.label": "Token：{tokens}",
    "role.user": "用户",
    "role.ai": "AI",
    "role.aiStreaming": "AI（生成中）",
    "chat.placeholder": "输入任务或继续说明…",
    "action.send": "发送",
    "action.stop": "停止",
    "action.retry": "重试",
    "tasks.planReview": "计划审核",
    "tasks.subagents": "子 Agent",
    "tasks.tools": "Tool 调用",
    "tasks.diffReview": "Diff Review",
    "tasks.checkpoints": "Checkpoint",
    "permissions.empty": "当前没有待处理权限请求。",
    "action.allowOnce": "允许一次",
    "action.deny": "拒绝",
    "browser.title": "受控 Chromium",
    "browser.create": "创建受控浏览器",
    "computer.title": "认证应用 Computer Use",
    "computer.inspectOnlyNotice": "未认证应用只能检查。点击、输入和快捷键必须由 Agent Tool 经权限中心批准。",
    "evolution.title": "Tool / Skill 候选中心",
    "evolution.refresh": "刷新候选中心",
    "release.title": "发布与更新",
    "release.locale": "界面语言",
    "release.version": "当前版本：{version}",
    "release.channel": "发布通道：{channel}",
    "release.productionReady": "生产发布就绪：{ready}",
    "release.blockers": "发布阻塞项",
    "release.refresh": "刷新发布状态",
    "release.zhCN": "简体中文",
    "release.enUS": "English",
    "boolean.yes": "是",
    "boolean.no": "否",
  },
};

const enUS: LocalizedCatalog<UiMessageKey> = {
  locale: "en-US",
  messages: {
    "runtime.disconnected": "Agent Runtime is not connected. No local action will be executed.",
    "error.unknown": "Unknown operation error",
    "status.label": "Status: {status}",
    "token.label": "Tokens: {tokens}",
    "role.user": "User",
    "role.ai": "AI",
    "role.aiStreaming": "AI (streaming)",
    "chat.placeholder": "Enter a task or continue the conversation…",
    "action.send": "Send",
    "action.stop": "Stop",
    "action.retry": "Retry",
    "tasks.planReview": "Plan Review",
    "tasks.subagents": "Subagents",
    "tasks.tools": "Tool Calls",
    "tasks.diffReview": "Diff Review",
    "tasks.checkpoints": "Checkpoints",
    "permissions.empty": "There are no pending permission requests.",
    "action.allowOnce": "Allow once",
    "action.deny": "Deny",
    "browser.title": "Controlled Chromium",
    "browser.create": "Create controlled browser",
    "computer.title": "Certified Computer Use",
    "computer.inspectOnlyNotice": "Uncertified applications are inspect-only. Click, type and shortcuts require an Agent Tool permission approval.",
    "evolution.title": "Tool / Skill Candidate Center",
    "evolution.refresh": "Refresh candidates",
    "release.title": "Release and Updates",
    "release.locale": "Interface language",
    "release.version": "Current version: {version}",
    "release.channel": "Release channel: {channel}",
    "release.productionReady": "Production release ready: {ready}",
    "release.blockers": "Release blockers",
    "release.refresh": "Refresh release status",
    "release.zhCN": "简体中文",
    "release.enUS": "English",
    "boolean.yes": "Yes",
    "boolean.no": "No",
  },
};

export const LOCALIZATION_CATALOGS: Readonly<Record<SupportedLocale, LocalizedCatalog<UiMessageKey>>> = {
  "zh-CN": zhCN,
  "en-US": enUS,
};

export function validateLocalizationCatalogs(): void {
  const expected = [...UI_MESSAGE_KEYS].sort();
  for (const locale of ["zh-CN", "en-US"] as const) {
    const catalog = LOCALIZATION_CATALOGS[locale];
    const actual = Object.keys(catalog.messages).sort();
    if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
      throw new Error(`本地化资源键不一致：${locale}`);
    }
    for (const [key, message] of Object.entries(catalog.messages)) {
      if (message.trim() === "") throw new Error(`本地化资源不能为空：${locale}/${key}`);
    }
  }
}

export function localize(
  locale: SupportedLocale,
  key: UiMessageKey,
  parameters: Readonly<Record<string, string | number>> = {},
): string {
  const template = LOCALIZATION_CATALOGS[locale].messages[key];
  const placeholders = [...template.matchAll(/\{([a-zA-Z0-9_]+)\}/g)].map(match => match[1] ?? "");
  const expected = [...new Set(placeholders)].sort();
  const actual = Object.keys(parameters).sort();
  if (expected.length !== actual.length || expected.some((name, index) => name !== actual[index])) {
    throw new Error(`本地化参数不匹配：${locale}/${key}`);
  }
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (_match, name: string) => String(parameters[name]));
}
