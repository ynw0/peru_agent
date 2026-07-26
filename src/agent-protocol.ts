// 权限模式只有三种，IDE、Agent Runtime 和权限引擎必须使用同一组枚举。
export type PermissionMode = "default" | "autoReview" | "fullAccess";

// 网络模式不会自动切换；用户必须明确选择需要的运行环境。
export type NetworkMode = "offline" | "lan" | "internet";

// Tool 风险等级用于权限审核和自生成 Tool 的晋级判断。
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
  | "workspace.propose"
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

// Agent 运行过程通过不可变事件传给 IDE；UI 只投影事件，不保存另一份事实状态。
export type AgentEvent =
  | { type: "session.created"; sessionId: string; workspaceId?: string }
  | { type: "session.started"; sessionId: string; runId: string }
  | { type: "plan.created"; sessionId: string; confidence: number; affectedFiles: string[] }
  | { type: "model.started"; sessionId: string; turn: number }
  | { type: "assistant.delta"; sessionId: string; delta: string }
  | { type: "assistant.completed"; sessionId: string; messageId: string }
  | { type: "tool.requested"; sessionId: string; toolName: string; capabilities: Capability[] }
  | { type: "tool.inspected"; sessionId: string; toolName: string; affectedFiles: string[] }
  | { type: "tool.started"; sessionId: string; toolName: string; toolCallId: string }
  | { type: "tool.progress"; sessionId: string; toolName: string; toolCallId: string; message: string }
  | { type: "permission.requested"; sessionId: string; requestId: string; capabilities: Capability[] }
  | { type: "permission.resolved"; sessionId: string; requestId: string; decision: "allow" | "deny" }
  | { type: "tool.completed"; sessionId: string; toolName: string; success: boolean; toolCallId?: string }
  | { type: "diff.proposed"; sessionId: string; proposalId: string; affectedFiles: string[] }
  | { type: "diff.resolved"; sessionId: string; proposalId: string; decision: "accepted" | "rejected" | "conflict"; checkpointId?: string }
  | { type: "checkpoint.created"; sessionId: string; checkpointId: string; proposalId: string }
  | { type: "checkpoint.restored"; sessionId: string; checkpointId: string; affectedFiles: string[] }
  | { type: "session.completed"; sessionId: string }
  | { type: "session.failed"; sessionId: string; code: string; message: string }
  | { type: "session.aborted"; sessionId: string };
