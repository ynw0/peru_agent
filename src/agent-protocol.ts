// 权限模式只有三种，UI 和运行时必须使用同一组枚举。
export type PermissionMode = "default" | "autoReview" | "fullAccess";

// 网络模式不会自动切换；用户必须明确选择。
export type NetworkMode = "offline" | "lan" | "internet";

// Tool 风险等级用于决定是否允许自动晋级。
export type ToolRiskLevel =
  | "pure-compute"
  | "workspace-read"
  | "workspace-write"
  | "process"
  | "network"
  | "browser"
  | "computer-use"
  | "security-core";

// 所有高权限行为使用明确能力标识，避免只凭工具名称判断权限。
export type Capability =
  | "workspace.read"
  | "workspace.write"
  | "workspace.delete"
  | "process.execute"
  | "process.background"
  | "git.write"
  | "network.loopback"
  | "network.lan"
  | "network.internet"
  | "browser.navigate"
  | "browser.interact"
  | "computer.inspect"
  | "computer.interact"
  | "tool.install"
  | "skill.install";

// Agent 运行过程通过事件传给 IDE，UI 不是事实来源。
export type AgentEvent =
  | { type: "session.created"; sessionId: string }
  | { type: "plan.created"; sessionId: string; confidence: number; affectedFiles: string[] }
  | { type: "tool.requested"; sessionId: string; toolName: string; capabilities: Capability[] }
  | { type: "permission.requested"; sessionId: string; requestId: string; capabilities: Capability[] }
  | { type: "permission.resolved"; sessionId: string; requestId: string; decision: "allow" | "deny" }
  | { type: "tool.completed"; sessionId: string; toolName: string; success: boolean }
  | { type: "session.completed"; sessionId: string };
