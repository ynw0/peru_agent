import type {
  AgentEvent,
  Capability,
  NetworkMode,
  PermissionMode,
} from "../agent-protocol.js";
import type { JournalEntry } from "../agent/event-journal.js";
import type { AgentSessionSnapshot } from "../agent/types.js";
import type { WorkbenchSnapshot } from "../workbench/workbench-state.js";
import type { CheckpointRecord } from "../checkpoint/checkpoint-manager.js";
import type { DiffProposal } from "../diff/diff-manager.js";
import type { PlanRecord } from "../plan/plan-manager.js";
import type { SubagentTaskRecord, SubagentTaskRequest } from "../subagent/types.js";
import type { WorkspaceFileSnapshot } from "../workspace/types.js";
import type {
  CompletionCandidate,
  CompletionDocumentInput,
  CompletionMetricsSnapshot,
  CompletionProviderProbeResult,
} from "../completion/types.js";

// IPC 协议版本必须显式匹配；版本不一致时拒绝连接，不做隐式兼容。
export const IPC_PROTOCOL_VERSION = 4 as const;

export interface RuntimeInitializeRequest {
  readonly protocolVersion: typeof IPC_PROTOCOL_VERSION;
  readonly clientId: string;
  readonly locale: "zh-CN" | "en-US";
  readonly permissionMode: PermissionMode;
  readonly networkMode: NetworkMode;
}

export interface RuntimeInitializeResult {
  readonly runtimeId: string;
  readonly protocolVersion: typeof IPC_PROTOCOL_VERSION;
  readonly enabledCapabilities: readonly Capability[];
}

export interface CreateSessionRequest {
  readonly workspaceId: string;
}

export interface CreateSessionResult {
  readonly sessionId: string;
}

export interface StartSessionRequest {
  readonly sessionId: string;
  readonly input: string;
}

export interface StartSessionResult {
  readonly runId: string;
}

export interface AbortSessionRequest {
  readonly sessionId: string;
}

export interface AbortSessionResult {
  readonly aborted: boolean;
}

export interface GetSessionRequest {
  readonly sessionId: string;
}

export interface ListSessionsRequest {
  readonly workspaceId?: string;
}

export interface ListSessionEventsRequest {
  readonly sessionId: string;
}

export interface RetrySessionRequest {
  readonly sessionId: string;
}

export interface ResolvePermissionRequest {
  readonly requestId: string;
  readonly decision: "allow" | "deny";
}

export interface ResolvePermissionResult {
  readonly accepted: boolean;
}

export interface RegisterWorkspaceRequest {
  readonly workspaceId: string;
  readonly rootPath: string;
}

export interface ReadWorkspaceFileRequest {
  readonly workspaceId: string;
  readonly path: string;
}

export interface ListDiffsRequest {
  readonly workspaceId?: string;
}

export interface ProposalRequest {
  readonly proposalId: string;
}

export interface ListCheckpointsRequest {
  readonly workspaceId?: string;
}

export interface RestoreCheckpointRequest {
  readonly checkpointId: string;
}

export interface ListPlansRequest {
  readonly sessionId?: string;
}

export interface GetPlanRequest {
  readonly planId: string;
}

export interface ResolvePlanRequest {
  readonly planId: string;
  readonly decision: "approved" | "rejected";
}

export interface GetWorkbenchSnapshotRequest {
  readonly sessionId?: string;
}

export interface CompletionRequestParams {
  readonly input: CompletionDocumentInput;
}

export interface CompletionAcceptedRequest {
  readonly requestId: string;
}

export interface DispatchSubagentRequest extends SubagentTaskRequest {}

export interface SubagentTaskRequestById {
  readonly taskId: string;
}

export interface ListSubagentsRequest {
  readonly parentSessionId?: string;
}

export interface ProposeSubagentMergeRequest {
  readonly taskId: string;
  readonly gateTaskIds: readonly string[];
}


// 请求方法表同时定义参数和返回值，是 Typed IPC 的唯一事实来源。
export interface IpcRequestMap {
  readonly "runtime.initialize": {
    readonly params: RuntimeInitializeRequest;
    readonly result: RuntimeInitializeResult;
  };
  readonly "session.create": {
    readonly params: CreateSessionRequest;
    readonly result: CreateSessionResult;
  };
  readonly "session.start": {
    readonly params: StartSessionRequest;
    readonly result: StartSessionResult;
  };
  readonly "session.abort": {
    readonly params: AbortSessionRequest;
    readonly result: AbortSessionResult;
  };
  readonly "session.get": {
    readonly params: GetSessionRequest;
    readonly result: AgentSessionSnapshot;
  };
  readonly "session.list": {
    readonly params: ListSessionsRequest;
    readonly result: { readonly sessions: readonly AgentSessionSnapshot[] };
  };
  readonly "session.events": {
    readonly params: ListSessionEventsRequest;
    readonly result: { readonly entries: readonly JournalEntry[] };
  };
  readonly "session.retry": {
    readonly params: RetrySessionRequest;
    readonly result: { readonly sessionId: string; readonly runId: string };
  };
  readonly "permission.resolve": {
    readonly params: ResolvePermissionRequest;
    readonly result: ResolvePermissionResult;
  };
  readonly "workspace.register": {
    readonly params: RegisterWorkspaceRequest;
    readonly result: { readonly registered: true };
  };
  readonly "workspace.read": {
    readonly params: ReadWorkspaceFileRequest;
    readonly result: WorkspaceFileSnapshot;
  };
  readonly "diff.list": {
    readonly params: ListDiffsRequest;
    readonly result: { readonly proposals: readonly DiffProposal[] };
  };
  readonly "diff.get": {
    readonly params: ProposalRequest;
    readonly result: DiffProposal;
  };
  readonly "diff.accept": {
    readonly params: ProposalRequest;
    readonly result: DiffProposal;
  };
  readonly "diff.reject": {
    readonly params: ProposalRequest;
    readonly result: DiffProposal;
  };
  readonly "checkpoint.list": {
    readonly params: ListCheckpointsRequest;
    readonly result: { readonly checkpoints: readonly CheckpointRecord[] };
  };
  readonly "checkpoint.restore": {
    readonly params: RestoreCheckpointRequest;
    readonly result: CheckpointRecord;
  };
  readonly "plan.list": {
    readonly params: ListPlansRequest;
    readonly result: { readonly plans: readonly PlanRecord[] };
  };
  readonly "plan.get": {
    readonly params: GetPlanRequest;
    readonly result: PlanRecord;
  };
  readonly "plan.resolve": {
    readonly params: ResolvePlanRequest;
    readonly result: PlanRecord;
  };
  readonly "workbench.getSnapshot": {
    readonly params: GetWorkbenchSnapshotRequest;
    readonly result: WorkbenchSnapshot;
  };
  readonly "completion.probe": {
    readonly params: Record<string, never>;
    readonly result: CompletionProviderProbeResult;
  };
  readonly "completion.request": {
    readonly params: CompletionRequestParams;
    readonly result: { readonly candidate: CompletionCandidate | null };
  };
  readonly "completion.accepted": {
    readonly params: CompletionAcceptedRequest;
    readonly result: { readonly recorded: true };
  };
  readonly "completion.metrics": {
    readonly params: Record<string, never>;
    readonly result: CompletionMetricsSnapshot;
  };
  readonly "completion.clearCache": {
    readonly params: Record<string, never>;
    readonly result: { readonly cleared: true };
  };
  readonly "subagent.dispatch": {
    readonly params: DispatchSubagentRequest;
    readonly result: SubagentTaskRecord;
  };
  readonly "subagent.start": {
    readonly params: SubagentTaskRequestById;
    readonly result: { readonly started: true };
  };
  readonly "subagent.abort": {
    readonly params: SubagentTaskRequestById;
    readonly result: { readonly aborted: boolean };
  };
  readonly "subagent.get": {
    readonly params: SubagentTaskRequestById;
    readonly result: SubagentTaskRecord;
  };
  readonly "subagent.list": {
    readonly params: ListSubagentsRequest;
    readonly result: { readonly tasks: readonly SubagentTaskRecord[] };
  };
  readonly "subagent.proposeMerge": {
    readonly params: ProposeSubagentMergeRequest;
    readonly result: SubagentTaskRecord;
  };
  readonly "subagent.finalizeMerge": {
    readonly params: SubagentTaskRequestById;
    readonly result: SubagentTaskRecord;
  };
}

export interface IpcEventMap {
  readonly "agent.event": AgentEvent;
  readonly "workbench.snapshot.changed": WorkbenchSnapshot;
  readonly "runtime.health.changed": {
    readonly healthy: boolean;
    readonly reason?: string;
  };
}

export type IpcRequestMethod = keyof IpcRequestMap;
export type IpcEventMethod = keyof IpcEventMap;

export type IpcRequestMessage = {
  readonly [Method in IpcRequestMethod]: {
    readonly kind: "request";
    readonly id: string;
    readonly method: Method;
    readonly params: IpcRequestMap[Method]["params"];
  };
}[IpcRequestMethod];

export interface IpcSuccessResponseMessage {
  readonly kind: "response";
  readonly id: string;
  readonly ok: true;
  readonly result: unknown;
}

export interface IpcErrorResponseMessage {
  readonly kind: "response";
  readonly id: string;
  readonly ok: false;
  readonly error: {
    readonly code: IpcErrorCode;
    readonly message: string;
  };
}

export type IpcResponseMessage = IpcSuccessResponseMessage | IpcErrorResponseMessage;

export interface IpcCancelMessage {
  readonly kind: "cancel";
  readonly id: string;
}


export type IpcEventMessage = {
  readonly [Method in IpcEventMethod]: {
    readonly kind: "event";
    readonly method: Method;
    readonly payload: IpcEventMap[Method];
  };
}[IpcEventMethod];

export type IpcMessage = IpcRequestMessage | IpcResponseMessage | IpcEventMessage | IpcCancelMessage;

export type IpcErrorCode =
  | "INVALID_MESSAGE"
  | "METHOD_NOT_FOUND"
  | "HANDLER_NOT_REGISTERED"
  | "HANDLER_FAILED"
  | "REQUEST_ABORTED"
  | "REQUEST_TIMEOUT"
  | "PROTOCOL_VERSION_MISMATCH";
