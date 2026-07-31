export type TuiCommand =
  | { readonly kind: "help" } | { readonly kind: "home" } | { readonly kind: "new" } | { readonly kind: "sessions" } | { readonly kind: "permissions" }
  | { readonly kind: "resume"; readonly sessionId?: string } | { readonly kind: "workspace"; readonly path: string }
  | { readonly kind: "model" } | { readonly kind: "mode"; readonly mode: "default" | "autoReview" }
  | { readonly kind: "diffs" } | { readonly kind: "checkpoints" } | { readonly kind: "restore"; readonly checkpointId: string }
  | { readonly kind: "retry" } | { readonly kind: "doctor" } | { readonly kind: "config" } | { readonly kind: "tools" }
  | { readonly kind: "clear" } | { readonly kind: "exit" } | { readonly kind: "rename"; readonly title?: string }
  | { readonly kind: "export"; readonly path?: string } | { readonly kind: "compact"; readonly instructions?: string }
  | { readonly kind: "context" } | { readonly kind: "usage" } | { readonly kind: "queue" }
  | { readonly kind: "plans" } | { readonly kind: "plan"; readonly instruction?: string }
  | { readonly kind: "tasks" } | { readonly kind: "task"; readonly instruction?: string } | { readonly kind: "subagents" } | { readonly kind: "trash" } | { readonly kind: "transcript" } | { readonly kind: "artifacts" };

export interface TuiCommandDescriptor { readonly name: string; readonly description: string; readonly usage?: string; }
const rawCommands: readonly (readonly [string, string])[] = [
  ["home", "返回首页"],
  ["permissions", "查看权限队列"], ["transcript", "打开会话 Transcript"], ["trash", "查看回收区会话"], ["subagents", "查看子 Agent"],
  ["help", "显示帮助"], ["new", "新建会话"], ["sessions", "列出当前工作区会话"], ["resume", "恢复会话"], ["workspace", "切换工作区"], ["model", "显示模型配置"], ["mode", "设置新会话权限模式"], ["diffs", "查看 Diff 队列"], ["checkpoints", "查看 Checkpoint"], ["restore", "恢复 Checkpoint"], ["retry", "重试当前会话"], ["doctor", "检查运行环境"], ["config", "编辑模型/API Key 配置"], ["tools", "查看 Tool"], ["rename", "重命名会话"], ["export", "导出 Markdown"], ["compact", "压缩会话"], ["context", "查看上下文占用"], ["usage", "查看用量"], ["queue", "查看输入队列"], ["plans", "查看 Plan"], ["plan", "创建 Plan"], ["tasks", "查看子 Agent 任务"], ["task", "派发子 Agent 任务"], ["artifacts", "查看内部 Commit 产物"], ["clear", "清理投影"], ["exit", "退出 TUI"],
];
export const TUI_COMMANDS: readonly TuiCommandDescriptor[] = rawCommands.map(([name, description]) => ({ name, description }));

export function parseTuiCommand(input: string): TuiCommand | undefined {
  if (!input.startsWith("/")) return undefined;
  const trimmed = input.trim(); const space = trimmed.indexOf(" "); const name = (space < 0 ? trimmed : trimmed.slice(0, space)).toLocaleLowerCase(); const tail = space < 0 ? "" : trimmed.slice(space + 1).trim();
  switch (name) {
    case "/help": return tail === "" ? { kind: "help" } : undefined; case "/home": return tail === "" ? { kind: "home" } : undefined; case "/new": return tail === "" ? { kind: "new" } : undefined;
    case "/sessions": return tail === "" ? { kind: "sessions" } : undefined; case "/resume": return { kind: "resume", ...(tail === "" ? {} : { sessionId: tail }) };
    case "/workspace": return tail === "" ? undefined : { kind: "workspace", path: tail }; case "/model": return tail === "" ? { kind: "model" } : undefined;
    case "/mode": return tail === "default" || tail === "autoReview" ? { kind: "mode", mode: tail } : undefined;
    case "/diffs": return tail === "" ? { kind: "diffs" } : undefined; case "/checkpoints": return tail === "" ? { kind: "checkpoints" } : undefined;
    case "/restore": return tail === "" ? undefined : { kind: "restore", checkpointId: tail }; case "/retry": return tail === "" ? { kind: "retry" } : undefined;
    case "/doctor": return tail === "" ? { kind: "doctor" } : undefined; case "/config": return tail === "" ? { kind: "config" } : undefined;
    case "/tools": return tail === "" ? { kind: "tools" } : undefined; case "/permissions": return tail === "" ? { kind: "permissions" } : undefined; case "/clear": return tail === "" ? { kind: "clear" } : undefined; case "/exit": return tail === "" ? { kind: "exit" } : undefined;
    case "/rename": return { kind: "rename", ...(tail === "" ? {} : { title: tail }) }; case "/export": return { kind: "export", ...(tail === "" ? {} : { path: tail }) };
    case "/compact": return { kind: "compact", ...(tail === "" ? {} : { instructions: tail }) }; case "/context": return tail === "" ? { kind: "context" } : undefined;
    case "/usage": return tail === "" ? { kind: "usage" } : undefined; case "/queue": return tail === "" ? { kind: "queue" } : undefined;
    case "/plans": return tail === "" ? { kind: "plans" } : undefined; case "/plan": return { kind: "plan", ...(tail === "" ? {} : { instruction: tail }) };
    case "/tasks": return tail === "" ? { kind: "tasks" } : undefined; case "/task": return { kind: "task", ...(tail === "" ? {} : { instruction: tail }) };
    case "/subagents": return tail === "" ? { kind: "subagents" } : undefined; case "/trash": return tail === "" ? { kind: "trash" } : undefined; case "/transcript": return tail === "" ? { kind: "transcript" } : undefined;
    case "/artifacts": return tail === "" ? { kind: "artifacts" } : undefined;
    default: return undefined;
  }
}

export const TUI_HELP = TUI_COMMANDS.map(item => `/${item.name.padEnd(12, " ")} ${item.description}`).join("\n") + "\n输入：Enter 发送；Shift+Enter/Alt+Enter 换行；Tab 补全；Ctrl+R 历史；Ctrl+O Verbose；鼠标滚轮浏览终端历史；左键拖选后 Ctrl+Shift+C 复制；PageUp/PageDown 浏览当前应用视图；Ctrl+C 取消运行";
