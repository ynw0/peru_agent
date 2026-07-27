import { IPC_PROTOCOL_VERSION } from "./protocol.js";
import {
  validateComputerActionResult,
  validateComputerScreenshot,
  validateComputerUiSnapshot,
  validateRunningApplicationIdentity,
} from "../computer-use/broker-validation.js";
import type {
  IpcEventMethod,
  IpcMessage,
  IpcRequestMethod,
} from "./protocol.js";

const ERROR_CODES = new Set([
  "INVALID_MESSAGE",
  "METHOD_NOT_FOUND",
  "HANDLER_NOT_REGISTERED",
  "HANDLER_FAILED",
  "REQUEST_ABORTED",
  "REQUEST_TIMEOUT",
  "PROTOCOL_VERSION_MISMATCH",
]);

const REQUEST_METHODS: ReadonlySet<string> = new Set<IpcRequestMethod>([
  "runtime.initialize",
  "session.create",
  "session.start",
  "session.abort",
  "session.get",
  "session.list",
  "session.events",
  "session.retry",
  "permission.resolve",
  "workspace.register",
  "workspace.read",
  "diff.list",
  "diff.get",
  "diff.accept",
  "diff.reject",
  "checkpoint.list",
  "checkpoint.restore",
  "plan.list",
  "plan.get",
  "plan.resolve",
  "workbench.getSnapshot",
  "completion.probe",
  "completion.request",
  "completion.accepted",
  "completion.metrics",
  "completion.clearCache",
  "subagent.dispatch",
  "subagent.start",
  "subagent.abort",
  "subagent.get",
  "subagent.list",
  "subagent.proposeMerge",
  "subagent.finalizeMerge",
  "egress.audit.list",
  "web.fetch",
  "web.search",
  "web.download",
  "browser.create",
  "browser.navigate",
  "browser.snapshot",
  "browser.screenshot",
  "browser.download",
  "browser.click",
  "browser.type",
  "browser.close",
  "browser.list",
  "computer.windows",
  "computer.inspect",
  "computer.screenshot",
  "computer.audit.list",
  "evolution.gaps.list",
  "evolution.candidates.list",
  "evolution.candidate.get",
  "evolution.candidate.validate",
  "evolution.candidate.approve",
  "evolution.candidate.promote",
  "evolution.candidate.disable",
  "evolution.candidate.rollback",
  "evolution.whitelist.list",
  "evolution.audit.list",
]);

const EVENT_METHODS: ReadonlySet<string> = new Set<IpcEventMethod>([
  "agent.event",
  "workbench.snapshot.changed",
  "runtime.health.changed",
  "browser.session.changed",
  "browser.snapshot.changed",
  "computer.window.changed",
  "computer.snapshot.changed",
  "computer.action.prepared",
  "computer.action.completed",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function isOptionalNonEmptyString(value: unknown): boolean {
  return value === undefined || isNonEmptyString(value);
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every(item => typeof item === "string");
}

function isNonNegativeInteger(value: unknown): boolean {
  return Number.isInteger(value) && Number(value) >= 0;
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every(key => allowed.has(key));
}

export function isRequestParams(method: IpcRequestMethod, value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }

  switch (method) {
    case "runtime.initialize":
      return hasOnlyKeys(value, ["protocolVersion", "clientId", "locale", "permissionMode", "networkMode"])
        && value.protocolVersion === IPC_PROTOCOL_VERSION
        && isNonEmptyString(value.clientId)
        && (value.locale === "zh-CN" || value.locale === "en-US")
        && isPermissionMode(value.permissionMode)
        && (value.networkMode === "offline" || value.networkMode === "lan" || value.networkMode === "internet");
    case "session.create":
      return hasOnlyKeys(value, ["workspaceId"]) && isNonEmptyString(value.workspaceId);
    case "session.start":
      return hasOnlyKeys(value, ["sessionId", "input"])
        && isNonEmptyString(value.sessionId)
        && isNonEmptyString(value.input);
    case "session.abort":
    case "session.get":
    case "session.events":
    case "session.retry":
      return hasOnlyKeys(value, ["sessionId"]) && isNonEmptyString(value.sessionId);
    case "session.list":
      return hasOnlyKeys(value, ["workspaceId"]) && isOptionalNonEmptyString(value.workspaceId);
    case "permission.resolve":
      return hasOnlyKeys(value, ["requestId", "decision"])
        && isNonEmptyString(value.requestId)
        && (value.decision === "allow" || value.decision === "deny");
    case "workspace.register":
      return hasOnlyKeys(value, ["workspaceId", "rootPath"])
        && isNonEmptyString(value.workspaceId)
        && isNonEmptyString(value.rootPath);
    case "workspace.read":
      return hasOnlyKeys(value, ["workspaceId", "path"])
        && isNonEmptyString(value.workspaceId)
        && isNonEmptyString(value.path);
    case "diff.list":
    case "checkpoint.list":
      return hasOnlyKeys(value, ["workspaceId"]) && isOptionalNonEmptyString(value.workspaceId);
    case "diff.get":
    case "diff.accept":
    case "diff.reject":
      return hasOnlyKeys(value, ["proposalId"]) && isNonEmptyString(value.proposalId);
    case "checkpoint.restore":
      return hasOnlyKeys(value, ["checkpointId"]) && isNonEmptyString(value.checkpointId);
    case "plan.list":
      return hasOnlyKeys(value, ["sessionId"]) && isOptionalNonEmptyString(value.sessionId);
    case "plan.get":
      return hasOnlyKeys(value, ["planId"]) && isNonEmptyString(value.planId);
    case "plan.resolve":
      return hasOnlyKeys(value, ["planId", "decision"])
        && isNonEmptyString(value.planId)
        && (value.decision === "approved" || value.decision === "rejected");
    case "workbench.getSnapshot":
      return hasOnlyKeys(value, ["sessionId"]) && isOptionalNonEmptyString(value.sessionId);
    case "completion.probe":
    case "completion.metrics":
    case "completion.clearCache":
      return hasOnlyKeys(value, []);
    case "completion.request":
      return hasOnlyKeys(value, ["input"]) && isCompletionDocumentInput(value.input);
    case "completion.accepted":
      return hasOnlyKeys(value, ["requestId"]) && isNonEmptyString(value.requestId);
    case "subagent.dispatch":
      return isSubagentTaskRequest(value);
    case "subagent.start":
    case "subagent.abort":
    case "subagent.get":
    case "subagent.finalizeMerge":
      return hasOnlyKeys(value, ["taskId"]) && isNonEmptyString(value.taskId);
    case "subagent.list":
      return hasOnlyKeys(value, ["parentSessionId"]) && isOptionalNonEmptyString(value.parentSessionId);
    case "subagent.proposeMerge":
      return hasOnlyKeys(value, ["taskId", "gateTaskIds"])
        && isNonEmptyString(value.taskId)
        && isStringArray(value.gateTaskIds)
        && value.gateTaskIds.length >= 2;
    case "egress.audit.list":
      return hasOnlyKeys(value, []);
    case "web.fetch":
      return hasOnlyKeys(value, ["url", "mode", "maxChars"])
        && isNonEmptyString(value.url)
        && isNetworkMode(value.mode)
        && (value.maxChars === undefined || (isPositiveInteger(value.maxChars) && Number(value.maxChars) <= 200_000));
    case "web.search":
      return hasOnlyKeys(value, ["query", "mode", "maxResults"])
        && isNonEmptyString(value.query)
        && String(value.query).length <= 500
        && isNetworkMode(value.mode)
        && (value.maxResults === undefined || (isPositiveInteger(value.maxResults) && Number(value.maxResults) <= 20));
    case "web.download":
      return hasOnlyKeys(value, ["workspaceId", "url", "mode", "maxBytes"])
        && isNonEmptyString(value.workspaceId)
        && isNonEmptyString(value.url)
        && isNetworkMode(value.mode)
        && (value.maxBytes === undefined || (isPositiveInteger(value.maxBytes) && Number(value.maxBytes) <= 32 * 1024 * 1024));
    case "browser.create":
      return hasOnlyKeys(value, ["workspaceId", "networkMode", "locale"])
        && isNonEmptyString(value.workspaceId)
        && isNetworkMode(value.networkMode)
        && (value.locale === "zh-CN" || value.locale === "en-US");
    case "browser.navigate":
      return hasOnlyKeys(value, ["browserSessionId", "url"])
        && isNonEmptyString(value.browserSessionId)
        && isNonEmptyString(value.url);
    case "browser.snapshot":
    case "browser.screenshot":
    case "browser.close":
      return hasOnlyKeys(value, ["browserSessionId"]) && isNonEmptyString(value.browserSessionId);
    case "browser.download":
      return hasOnlyKeys(value, ["browserSessionId", "url", "maxBytes"])
        && isNonEmptyString(value.browserSessionId)
        && isNonEmptyString(value.url)
        && (value.maxBytes === undefined || (isPositiveInteger(value.maxBytes) && Number(value.maxBytes) <= 32 * 1024 * 1024));
    case "browser.click":
      return hasOnlyKeys(value, ["browserSessionId", "snapshotId", "elementId"])
        && isNonEmptyString(value.browserSessionId)
        && isNonEmptyString(value.snapshotId)
        && isNonEmptyString(value.elementId);
    case "browser.type":
      return hasOnlyKeys(value, ["browserSessionId", "snapshotId", "elementId", "text"])
        && isNonEmptyString(value.browserSessionId)
        && isNonEmptyString(value.snapshotId)
        && isNonEmptyString(value.elementId)
        && isNonEmptyString(value.text)
        && String(value.text).length <= 10_000;
    case "browser.list":
      return hasOnlyKeys(value, ["workspaceId"]) && isOptionalNonEmptyString(value.workspaceId);
    case "computer.windows":
    case "computer.audit.list":
      return hasOnlyKeys(value, []);
    case "computer.inspect":
      return hasOnlyKeys(value, ["windowHandle"]) && isNonEmptyString(value.windowHandle);
    case "computer.screenshot":
      return hasOnlyKeys(value, ["snapshotId"]) && isNonEmptyString(value.snapshotId);
    case "evolution.gaps.list":
    case "evolution.candidates.list":
    case "evolution.whitelist.list":
    case "evolution.audit.list":
      return hasOnlyKeys(value, []);
    case "evolution.candidate.get":
    case "evolution.candidate.validate":
    case "evolution.candidate.promote":
      return hasOnlyKeys(value, ["candidateId"]) && isNonEmptyString(value.candidateId);
    case "evolution.candidate.approve":
      return hasOnlyKeys(value, ["candidateId", "approverId", "decision", "reason"])
        && isNonEmptyString(value.candidateId)
        && isNonEmptyString(value.approverId)
        && (value.decision === "approved" || value.decision === "rejected")
        && isNonEmptyString(value.reason)
        && String(value.reason).length <= 2_000;
    case "evolution.candidate.disable":
    case "evolution.candidate.rollback":
      return hasOnlyKeys(value, ["candidateId", "reason"])
        && isNonEmptyString(value.candidateId)
        && isNonEmptyString(value.reason)
        && String(value.reason).length <= 2_000;
  }
}

export function isResponseResult(method: IpcRequestMethod, value: unknown): boolean {
  switch (method) {
    case "runtime.initialize":
      return isRecord(value)
        && isNonEmptyString(value.runtimeId)
        && value.protocolVersion === IPC_PROTOCOL_VERSION
        && isStringArray(value.enabledCapabilities);
    case "session.create":
      return isRecord(value) && isNonEmptyString(value.sessionId);
    case "session.start":
      return isRecord(value) && isNonEmptyString(value.runId);
    case "session.abort":
      return isRecord(value) && typeof value.aborted === "boolean";
    case "session.get":
      return isAgentSessionSnapshot(value);
    case "session.list":
      return isRecord(value) && Array.isArray(value.sessions) && value.sessions.every(isAgentSessionSnapshot);
    case "session.events":
      return isRecord(value) && Array.isArray(value.entries) && value.entries.every(isJournalEntry);
    case "session.retry":
      return isRecord(value) && isNonEmptyString(value.sessionId) && isNonEmptyString(value.runId);
    case "permission.resolve":
      return isRecord(value) && typeof value.accepted === "boolean";
    case "workspace.register":
      return isRecord(value) && value.registered === true;
    case "workspace.read":
      return isWorkspaceFileSnapshot(value);
    case "diff.list":
      return isRecord(value) && Array.isArray(value.proposals) && value.proposals.every(isDiffProposal);
    case "diff.get":
    case "diff.accept":
    case "diff.reject":
      return isDiffProposal(value);
    case "checkpoint.list":
      return isRecord(value) && Array.isArray(value.checkpoints) && value.checkpoints.every(isCheckpointRecord);
    case "checkpoint.restore":
      return isCheckpointRecord(value);
    case "plan.list":
      return isRecord(value) && Array.isArray(value.plans) && value.plans.every(isPlanRecord);
    case "plan.get":
    case "plan.resolve":
      return isPlanRecord(value);
    case "workbench.getSnapshot":
      return isWorkbenchSnapshot(value);
    case "completion.probe":
      return isCompletionProviderProbeResult(value);
    case "completion.request":
      return isRecord(value) && (value.candidate === null || isCompletionCandidate(value.candidate));
    case "completion.accepted":
      return isRecord(value) && value.recorded === true;
    case "completion.metrics":
      return isCompletionMetricsSnapshot(value);
    case "completion.clearCache":
      return isRecord(value) && value.cleared === true;
    case "subagent.dispatch":
    case "subagent.get":
    case "subagent.proposeMerge":
    case "subagent.finalizeMerge":
      return isSubagentTaskRecord(value);
    case "subagent.start":
      return isRecord(value) && value.started === true;
    case "subagent.abort":
      return isRecord(value) && typeof value.aborted === "boolean";
    case "subagent.list":
      return isRecord(value) && Array.isArray(value.tasks) && value.tasks.every(isSubagentTaskRecord);
    case "egress.audit.list":
      return isRecord(value) && Array.isArray(value.entries) && value.entries.every(isEgressAuditEntry);
    case "web.fetch":
      return isWebFetchResult(value);
    case "web.search":
      return isWebSearchResult(value);
    case "web.download":
      return isWebDownloadArtifact(value);
    case "browser.create":
    case "browser.close":
      return isBrowserSessionRecord(value);
    case "browser.navigate":
    case "browser.snapshot":
      return isBrowserDomSnapshot(value);
    case "browser.screenshot":
      return isBrowserScreenshot(value);
    case "browser.download":
      return isWebDownloadArtifact(value);
    case "browser.click":
    case "browser.type":
      return isBrowserActionResult(value);
    case "browser.list":
      return isRecord(value) && Array.isArray(value.sessions) && value.sessions.every(isBrowserSessionRecord);
    case "computer.windows":
      return isRecord(value) && Array.isArray(value.windows) && value.windows.every(isComputerWindowRecord);
    case "computer.inspect":
      return validateBoolean(() => validateComputerUiSnapshot(value));
    case "computer.screenshot":
      return validateBoolean(() => validateComputerScreenshot(value));
    case "computer.audit.list":
      return isRecord(value) && Array.isArray(value.entries) && value.entries.every(isComputerUseAuditEntry);
    case "evolution.gaps.list":
      return isRecord(value) && Array.isArray(value.gaps) && value.gaps.every(isCapabilityGapProposal);
    case "evolution.candidates.list":
      return isRecord(value) && Array.isArray(value.candidates) && value.candidates.every(isEvolutionCandidateRecord);
    case "evolution.candidate.get":
    case "evolution.candidate.validate":
    case "evolution.candidate.approve":
    case "evolution.candidate.promote":
    case "evolution.candidate.disable":
    case "evolution.candidate.rollback":
      return isEvolutionCandidateRecord(value);
    case "evolution.whitelist.list":
      return isRecord(value) && Array.isArray(value.entries) && value.entries.every(isSignedWhitelistEntry);
    case "evolution.audit.list":
      return isRecord(value) && Array.isArray(value.entries) && value.entries.every(isEvolutionAuditEntry);
  }
}

function isSubagentRole(value: unknown): boolean {
  return value === "planner" || value === "explorer" || value === "implementer"
    || value === "reviewer" || value === "tester";
}

function isSubagentTaskStatus(value: unknown): boolean {
  return value === "queued" || value === "running" || value === "completed"
    || value === "failed" || value === "aborted" || value === "patchProposed" || value === "merged";
}

function isPositiveInteger(value: unknown): boolean {
  return Number.isInteger(value) && Number(value) > 0;
}

function isSubagentBudget(value: unknown): boolean {
  return isRecord(value)
    && hasOnlyKeys(value, ["maxTurns", "maxToolCalls", "maxTotalTokens", "maxDurationMs"])
    && isPositiveInteger(value.maxTurns)
    && isPositiveInteger(value.maxToolCalls)
    && isPositiveInteger(value.maxTotalTokens)
    && isPositiveInteger(value.maxDurationMs);
}

function hasSubagentTaskFields(value: Record<string, unknown>): boolean {
  return isNonEmptyString(value.parentSessionId)
    && (value.parentTaskId === undefined || isNonEmptyString(value.parentTaskId))
    && isSubagentRole(value.role)
    && isNonEmptyString(value.instruction)
    && isPositiveInteger(value.depth)
    && isNonEmptyString(value.baseWorkspaceId)
    && isStringArray(value.allowedPaths)
    && value.allowedPaths.length > 0
    && isStringArray(value.writablePaths)
    && isStringArray(value.allowedCapabilities)
    && isSubagentBudget(value.budget)
    && (value.targetTaskId === undefined || isNonEmptyString(value.targetTaskId));
}

function isSubagentTaskRequest(value: unknown): boolean {
  return isRecord(value)
    && hasOnlyKeys(value, [
      "parentSessionId", "parentTaskId", "role", "instruction", "depth", "baseWorkspaceId",
      "allowedPaths", "writablePaths", "allowedCapabilities", "budget", "targetTaskId",
    ])
    && hasSubagentTaskFields(value);
}

function isSubagentUsage(value: unknown): boolean {
  return isRecord(value)
    && isNonNegativeInteger(value.inputTokens)
    && isNonNegativeInteger(value.outputTokens)
    && isNonNegativeInteger(value.turns)
    && isNonNegativeInteger(value.toolCalls);
}

function isSubagentExecutionResult(value: unknown): boolean {
  return isRecord(value)
    && typeof value.summary === "string"
    && isSubagentUsage(value.usage)
    && (value.childSessionId === undefined || isNonEmptyString(value.childSessionId))
    && (value.verdict === undefined || value.verdict === "approved" || value.verdict === "rejected");
}

function isSubagentWorktree(value: unknown): boolean {
  return isRecord(value)
    && isNonEmptyString(value.id)
    && isNonEmptyString(value.taskId)
    && isNonEmptyString(value.baseWorkspaceId)
    && isNonEmptyString(value.workspaceId)
    && isNonEmptyString(value.root)
    && isStringArray(value.allowedPaths)
    && isStringArray(value.writablePaths)
    && Array.isArray(value.baseFiles)
    && value.baseFiles.every(isWorkspaceFileSnapshot)
    && isNonEmptyString(value.createdAt);
}

function isSubagentTaskRecord(value: unknown): boolean {
  if (!isRecord(value)
    || !hasSubagentTaskFields(value)
    || !isNonEmptyString(value.id)
    || !isSubagentTaskStatus(value.status)
    || !isNonEmptyString(value.createdAt)
    || !isNonEmptyString(value.updatedAt)
    || (value.worktree !== undefined && !isSubagentWorktree(value.worktree))
    || (value.result !== undefined && !isSubagentExecutionResult(value.result))
    || (value.patchProposalId !== undefined && !isNonEmptyString(value.patchProposalId))
    || (value.error !== undefined && (!isRecord(value.error)
      || !isNonEmptyString(value.error.code)
      || !isNonEmptyString(value.error.message)))) {
    return false;
  }

  if ((value.status === "completed" || value.status === "patchProposed" || value.status === "merged")
    && value.result === undefined) {
    return false;
  }
  if ((value.status === "patchProposed" || value.status === "merged")
    && value.patchProposalId === undefined) {
    return false;
  }
  if ((value.status === "failed" || value.status === "aborted") && value.error === undefined) {
    return false;
  }
  if (value.role === "implementer" && (value.status === "completed" || value.status === "patchProposed")
    && value.worktree === undefined) {
    return false;
  }
  if (value.status === "merged" && value.worktree !== undefined) {
    return false;
  }
  if (isRecord(value.worktree)
    && (value.worktree.taskId !== value.id
      || value.worktree.id !== `worktree:${value.id}`
      || value.worktree.workspaceId !== `subagent:${value.id}`)) {
    return false;
  }
  return true;
}

function isAgentSessionSnapshot(value: unknown): boolean {
  return isRecord(value)
    && isNonEmptyString(value.id)
    && isNonEmptyString(value.workspaceId)
    && isPermissionMode(value.permissionMode)
    && isSessionStatus(value.status)
    && Array.isArray(value.messages)
    && value.messages.every(isAgentMessage)
    && isNonEmptyString(value.createdAt)
    && isNonEmptyString(value.updatedAt)
    && (value.activeRunId === undefined || isNonEmptyString(value.activeRunId))
    && (value.lastError === undefined || (isRecord(value.lastError)
      && isNonEmptyString(value.lastError.code)
      && isNonEmptyString(value.lastError.message)))
    && isRecord(value.usage)
    && isNonNegativeInteger(value.usage.inputTokens)
    && isNonNegativeInteger(value.usage.outputTokens);
}

function isAgentMessage(value: unknown): boolean {
  if (!isRecord(value) || !isNonEmptyString(value.id) || typeof value.role !== "string") {
    return false;
  }
  if (value.role === "user") {
    return typeof value.content === "string";
  }
  if (value.role === "assistant") {
    return typeof value.content === "string" && Array.isArray(value.toolCalls);
  }
  if (value.role === "tool") {
    return isNonEmptyString(value.toolCallId)
      && isNonEmptyString(value.toolName)
      && typeof value.content === "string"
      && typeof value.isError === "boolean";
  }
  return false;
}

function isWorkspaceFileSnapshot(value: unknown): boolean {
  return isRecord(value)
    && isNonEmptyString(value.path)
    && typeof value.exists === "boolean"
    && (value.content === null || typeof value.content === "string")
    && (value.sha256 === null || isSha256(value.sha256))
    && isNonNegativeInteger(value.byteLength);
}

function isDiffProposal(value: unknown): boolean {
  return isRecord(value)
    && isNonEmptyString(value.id)
    && isNonEmptyString(value.sessionId)
    && isNonEmptyString(value.workspaceId)
    && isNonEmptyString(value.toolCallId)
    && isNonEmptyString(value.createdAt)
    && (value.status === "proposed" || value.status === "accepted"
      || value.status === "rejected" || value.status === "conflict")
    && Array.isArray(value.changes)
    && value.changes.every(change => isRecord(change)
      && isNonEmptyString(change.path)
      && isWorkspaceFileSnapshot(change.before)
      && typeof change.afterContent === "string"
      && isSha256(change.afterSha256)
      && typeof change.unifiedDiff === "string")
    && (value.checkpointId === undefined || isNonEmptyString(value.checkpointId))
    && (value.conflictMessage === undefined || typeof value.conflictMessage === "string");
}

function isCheckpointRecord(value: unknown): boolean {
  return isRecord(value)
    && isNonEmptyString(value.id)
    && isNonEmptyString(value.workspaceId)
    && isNonEmptyString(value.sessionId)
    && isNonEmptyString(value.proposalId)
    && isNonEmptyString(value.createdAt)
    && (value.status === "active" || value.status === "restored")
    && Array.isArray(value.files)
    && value.files.every(file => isRecord(file)
      && isNonEmptyString(file.path)
      && isWorkspaceFileSnapshot(file.before)
      && (file.expectedAfterSha256 === null || isSha256(file.expectedAfterSha256))
      && (file.afterContent === null || typeof file.afterContent === "string"));
}

function isPlanRecord(value: unknown): boolean {
  return isRecord(value)
    && isNonEmptyString(value.id)
    && isNonEmptyString(value.sessionId)
    && isNonEmptyString(value.title)
    && isNonEmptyString(value.summary)
    && typeof value.confidence === "number"
    && value.confidence >= 0
    && value.confidence <= 100
    && isStringArray(value.affectedFiles)
    && Array.isArray(value.steps)
    && value.steps.every(isPlanStep)
    && isPlanStatus(value.status)
    && isNonEmptyString(value.createdAt)
    && isNonEmptyString(value.updatedAt)
    && (value.message === undefined || typeof value.message === "string");
}

function isPlanStep(value: unknown): boolean {
  return isRecord(value)
    && isNonEmptyString(value.id)
    && isNonEmptyString(value.title)
    && isNonEmptyString(value.description)
    && isStringArray(value.affectedFiles)
    && isStringArray(value.capabilities);
}

function isJournalEntry(value: unknown): boolean {
  return isRecord(value)
    && Number.isInteger(value.sequence)
    && Number(value.sequence) > 0
    && isNonEmptyString(value.recordedAt)
    && isAgentEvent(value.event);
}

function isWorkbenchSnapshot(value: unknown): boolean {
  return isRecord(value)
    && (value.activeSessionId === undefined || isNonEmptyString(value.activeSessionId))
    && (value.activeRunId === undefined || isNonEmptyString(value.activeRunId))
    && (value.sessionStatus === "none" || isSessionStatus(value.sessionStatus))
    && Array.isArray(value.chatMessages)
    && value.chatMessages.every(message => isRecord(message)
      && isNonEmptyString(message.id)
      && (message.role === "user" || message.role === "assistant")
      && typeof message.content === "string"
      && (message.state === "streaming" || message.state === "completed"))
    && Array.isArray(value.plans)
    && value.plans.every(plan => isRecord(plan)
      && isNonEmptyString(plan.planId)
      && isNonEmptyString(plan.title)
      && isNonEmptyString(plan.summary)
      && typeof plan.confidence === "number"
      && isStringArray(plan.affectedFiles)
      && Array.isArray(plan.steps)
      && plan.steps.every(isPlanStep)
      && isPlanStatus(plan.status))
    && isStringArray(value.affectedFiles)
    && Array.isArray(value.pendingPermissions)
    && value.pendingPermissions.every(permission => isRecord(permission)
      && isNonEmptyString(permission.requestId)
      && isNonEmptyString(permission.toolCallId)
      && isNonEmptyString(permission.toolName)
      && isToolRiskLevel(permission.riskLevel)
      && isStringArray(permission.capabilities)
      && isStringArray(permission.affectedFiles)
      && isNonEmptyString(permission.reason))
    && Array.isArray(value.tools)
    && value.tools.every(tool => isRecord(tool)
      && isNonEmptyString(tool.toolCallId)
      && isNonEmptyString(tool.toolName)
      && isNonEmptyString(tool.description)
      && isToolRiskLevel(tool.riskLevel)
      && isStringArray(tool.capabilities)
      && isStringArray(tool.affectedFiles)
      && isStringArray(tool.networkTargets)
      && isStringArray(tool.commands)
      && isStringArray(tool.progressMessages)
      && (tool.state === "requested" || tool.state === "running"
        || tool.state === "completed" || tool.state === "failed"))
    && Array.isArray(value.diffProposals)
    && value.diffProposals.every(proposal => isRecord(proposal)
      && isNonEmptyString(proposal.proposalId)
      && (proposal.status === "proposed" || proposal.status === "accepted"
        || proposal.status === "rejected" || proposal.status === "conflict")
      && isStringArray(proposal.affectedFiles)
      && (proposal.checkpointId === undefined || isNonEmptyString(proposal.checkpointId)))
    && Array.isArray(value.checkpoints)
    && value.checkpoints.every(checkpoint => isRecord(checkpoint)
      && isNonEmptyString(checkpoint.checkpointId)
      && (checkpoint.proposalId === undefined || isNonEmptyString(checkpoint.proposalId))
      && typeof checkpoint.restored === "boolean")
    && Array.isArray(value.subagents)
    && value.subagents.every(task => isRecord(task)
      && isNonEmptyString(task.taskId)
      && isSubagentRole(task.role)
      && Number.isInteger(task.depth)
      && Number(task.depth) > 0
      && isSubagentTaskStatus(task.status)
      && (task.workspaceId === undefined || isNonEmptyString(task.workspaceId))
      && (task.verdict === undefined || task.verdict === "approved" || task.verdict === "rejected")
      && (task.proposalId === undefined || isNonEmptyString(task.proposalId))
      && (task.error === undefined || (isRecord(task.error)
        && isNonEmptyString(task.error.code)
        && isNonEmptyString(task.error.message))))
    && isRecord(value.usage)
    && isNonNegativeInteger(value.usage.inputTokens)
    && isNonNegativeInteger(value.usage.outputTokens)
    && typeof value.completed === "boolean"
    && typeof value.aborted === "boolean"
    && (value.failed === undefined || (isRecord(value.failed)
      && isNonEmptyString(value.failed.code)
      && isNonEmptyString(value.failed.message)));
}

function isAgentEvent(value: unknown): boolean {
  if (!isRecord(value) || !isNonEmptyString(value.type) || !isNonEmptyString(value.sessionId)) {
    return false;
  }

  switch (value.type) {
    case "session.created":
      return value.workspaceId === undefined || typeof value.workspaceId === "string";
    case "session.started":
      return isNonEmptyString(value.runId);
    case "user.message.added":
      return isNonEmptyString(value.messageId) && typeof value.content === "string";
    case "plan.created":
      return isNonEmptyString(value.planId)
        && isNonEmptyString(value.title)
        && isNonEmptyString(value.summary)
        && typeof value.confidence === "number"
        && value.confidence >= 0
        && value.confidence <= 100
        && isStringArray(value.affectedFiles)
        && Array.isArray(value.steps)
        && value.steps.every(isPlanStep)
        && value.status === "reviewing"
        && isNonEmptyString(value.createdAt);
    case "plan.resolved":
      return isNonEmptyString(value.planId)
        && (value.decision === "approved" || value.decision === "rejected")
        && isNonEmptyString(value.updatedAt);
    case "plan.status.changed":
      return isNonEmptyString(value.planId)
        && (value.status === "executing" || value.status === "completed"
          || value.status === "failed" || value.status === "cancelled")
        && isNonEmptyString(value.updatedAt)
        && (value.message === undefined || typeof value.message === "string");
    case "model.started":
      return Number.isInteger(value.turn) && Number(value.turn) > 0;
    case "assistant.started":
      return isNonEmptyString(value.messageId)
        && Number.isInteger(value.turn)
        && Number(value.turn) > 0;
    case "assistant.delta":
      return isNonEmptyString(value.messageId) && typeof value.delta === "string";
    case "assistant.completed":
      return isNonEmptyString(value.messageId);
    case "session.usage.updated":
      return isNonNegativeInteger(value.inputTokens) && isNonNegativeInteger(value.outputTokens);
    case "tool.requested":
      return isNonEmptyString(value.toolCallId)
        && isNonEmptyString(value.toolName)
        && isNonEmptyString(value.description)
        && isToolRiskLevel(value.riskLevel)
        && isStringArray(value.capabilities);
    case "tool.inspected":
      return isNonEmptyString(value.toolCallId)
        && isNonEmptyString(value.toolName)
        && isToolRiskLevel(value.riskLevel)
        && isStringArray(value.affectedFiles)
        && isStringArray(value.networkTargets)
        && isStringArray(value.commands);
    case "tool.started":
      return isNonEmptyString(value.toolName) && isNonEmptyString(value.toolCallId);
    case "tool.progress":
      return isNonEmptyString(value.toolName)
        && isNonEmptyString(value.toolCallId)
        && isNonEmptyString(value.message);
    case "permission.requested":
      return isNonEmptyString(value.requestId)
        && isNonEmptyString(value.toolCallId)
        && isNonEmptyString(value.toolName)
        && isToolRiskLevel(value.riskLevel)
        && isStringArray(value.capabilities)
        && isStringArray(value.affectedFiles)
        && isNonEmptyString(value.reason);
    case "permission.resolved":
      return isNonEmptyString(value.requestId)
        && (value.decision === "allow" || value.decision === "deny");
    case "tool.completed":
      return isNonEmptyString(value.toolName)
        && isNonEmptyString(value.toolCallId)
        && typeof value.success === "boolean";
    case "diff.proposed":
      return isNonEmptyString(value.proposalId) && isStringArray(value.affectedFiles);
    case "diff.resolved":
      return isNonEmptyString(value.proposalId)
        && (value.decision === "accepted" || value.decision === "rejected" || value.decision === "conflict")
        && (value.checkpointId === undefined || isNonEmptyString(value.checkpointId));
    case "checkpoint.created":
      return isNonEmptyString(value.checkpointId) && isNonEmptyString(value.proposalId);
    case "checkpoint.restored":
      return isNonEmptyString(value.checkpointId) && isStringArray(value.affectedFiles);
    case "subagent.task.created":
      return isNonEmptyString(value.taskId)
        && (value.role === "planner" || value.role === "explorer" || value.role === "implementer"
          || value.role === "reviewer" || value.role === "tester")
        && Number.isInteger(value.depth) && Number(value.depth) > 0;
    case "subagent.task.started":
      return isNonEmptyString(value.taskId) && isNonEmptyString(value.workspaceId);
    case "subagent.task.completed":
      return isNonEmptyString(value.taskId)
        && (value.role === "planner" || value.role === "explorer" || value.role === "implementer"
          || value.role === "reviewer" || value.role === "tester")
        && (value.verdict === undefined || value.verdict === "approved" || value.verdict === "rejected");
    case "subagent.task.failed":
      return isNonEmptyString(value.taskId) && isNonEmptyString(value.code) && isNonEmptyString(value.message);
    case "subagent.task.aborted":
      return isNonEmptyString(value.taskId);
    case "subagent.patch.proposed":
      return isNonEmptyString(value.taskId) && isNonEmptyString(value.proposalId)
        && isStringArray(value.gateTaskIds);
    case "subagent.task.merged":
      return isNonEmptyString(value.taskId) && isNonEmptyString(value.proposalId);
    case "session.completed":
    case "session.aborted":
      return true;
    case "session.failed":
      return isNonEmptyString(value.code) && isNonEmptyString(value.message);
    default:
      return false;
  }
}

function isCompletionDocumentInput(value: unknown): boolean {
  return isRecord(value)
    && isNonEmptyString(value.documentUri)
    && isNonEmptyString(value.languageId)
    && isNonNegativeInteger(value.version)
    && isNonNegativeInteger(value.offset)
    && typeof value.text === "string"
    && Number(value.offset) <= value.text.length
    && (value.enrichment === undefined || (isRecord(value.enrichment)
      && (value.enrichment.currentFunction === undefined || typeof value.enrichment.currentFunction === "string")
      && (value.enrichment.imports === undefined || isStringArray(value.enrichment.imports))
      && (value.enrichment.recentEdits === undefined || isStringArray(value.enrichment.recentEdits))
      && (value.enrichment.lspTypes === undefined || isStringArray(value.enrichment.lspTypes))
      && (value.enrichment.diagnostics === undefined || isStringArray(value.enrichment.diagnostics))
      && (value.enrichment.projectRules === undefined || isStringArray(value.enrichment.projectRules))));
}

function isCompletionCapability(value: unknown): boolean {
  return isRecord(value)
    && typeof value.fim === "boolean"
    && typeof value.streaming === "boolean"
    && typeof value.cancellation === "boolean"
    && Number.isInteger(value.maxPrefixTokens)
    && Number(value.maxPrefixTokens) > 0
    && Number.isInteger(value.maxSuffixTokens)
    && Number(value.maxSuffixTokens) > 0;
}

function isCompletionProviderProbeResult(value: unknown): boolean {
  return isRecord(value)
    && isCompletionCapability(value.capability)
    && isNonEmptyString(value.modelId)
    && isNonNegativeFiniteNumber(value.firstTokenLatencyMs)
    && isNonNegativeFiniteNumber(value.totalLatencyMs)
    && isNonNegativeFiniteNumber(value.cancellationLatencyMs);
}

function isCompletionCandidate(value: unknown): boolean {
  return isRecord(value)
    && isNonEmptyString(value.requestId)
    && isNonEmptyString(value.documentUri)
    && isNonNegativeInteger(value.documentVersion)
    && isNonNegativeInteger(value.offset)
    && isNonEmptyString(value.text)
    && isNonEmptyString(value.providerId)
    && typeof value.cacheHit === "boolean"
    && isNonNegativeFiniteNumber(value.firstTokenLatencyMs)
    && isNonNegativeFiniteNumber(value.totalLatencyMs);
}

function isCompletionMetricsSnapshot(value: unknown): boolean {
  return isRecord(value)
    && isNonNegativeInteger(value.requests)
    && isNonNegativeInteger(value.cacheHits)
    && isNonNegativeInteger(value.cancellations)
    && isNonNegativeInteger(value.failures)
    && isNonNegativeInteger(value.accepted)
    && isNullableNonNegativeNumber(value.p50FirstTokenMs)
    && isNullableNonNegativeNumber(value.p95FirstTokenMs)
    && isNullableNonNegativeNumber(value.p50TotalMs)
    && isNullableNonNegativeNumber(value.p95TotalMs)
    && typeof value.acceptanceRate === "number"
    && Number.isFinite(value.acceptanceRate)
    && value.acceptanceRate >= 0
    && value.acceptanceRate <= 1;
}

function isNonNegativeFiniteNumber(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isNullableNonNegativeNumber(value: unknown): boolean {
  return value === null || isNonNegativeFiniteNumber(value);
}

function isEventPayload(method: IpcEventMethod, value: unknown): boolean {
  switch (method) {
    case "agent.event":
      return isAgentEvent(value);
    case "workbench.snapshot.changed":
      return isWorkbenchSnapshot(value);
    case "runtime.health.changed":
      return isRecord(value)
        && typeof value.healthy === "boolean"
        && (value.reason === undefined || typeof value.reason === "string");
    case "browser.session.changed":
      return isBrowserSessionRecord(value);
    case "browser.snapshot.changed":
      return isBrowserDomSnapshot(value);
    case "computer.window.changed":
      return isComputerWindowRecord(value);
    case "computer.snapshot.changed":
      return validateBoolean(() => validateComputerUiSnapshot(value));
    case "computer.action.prepared":
      return isPreparedComputerAction(value);
    case "computer.action.completed":
      return validateBoolean(() => validateComputerActionResult(value));
  }
}



function isCapabilityGapProposal(value: unknown): boolean {
  return isRecord(value)
    && isNonEmptyString(value.id)
    && isSha256(value.signature)
    && isNonEmptyString(value.workspaceId)
    && isNonEmptyString(value.outcome)
    && isStringArray(value.requiredCapabilities)
    && isStringArray(value.observationIds)
    && isPositiveInteger(value.occurrenceCount)
    && (value.suggestedKind === "tool" || value.suggestedKind === "skill")
    && typeof value.autoForgeAllowed === "boolean"
    && isNonEmptyString(value.createdAt)
    && isNonEmptyString(value.updatedAt);
}

function isEvolutionCandidateRecord(value: unknown): boolean {
  return isRecord(value)
    && isNonEmptyString(value.id)
    && (value.kind === "tool" || value.kind === "skill")
    && isNonEmptyString(value.name)
    && isNonEmptyString(value.version)
    && isNonEmptyString(value.description)
    && isToolRiskLevel(value.riskLevel)
    && isStringArray(value.capabilities)
    && isRecord(value.payload)
    && isStringArray(value.sourceGapIds)
    && ["draft", "validating", "validationFailed", "awaitingManualApproval", "promoted", "disabled", "rolledBack"].includes(String(value.status))
    && isNonEmptyString(value.createdAt)
    && isNonEmptyString(value.updatedAt)
    && (value.validation === undefined || isCandidateValidationReport(value.validation))
    && (value.artifact === undefined || isSignedCandidateArtifact(value.artifact));
}

function isCandidateValidationReport(value: unknown): boolean {
  return isRecord(value)
    && isNonEmptyString(value.candidateId)
    && isSha256(value.candidateDigest)
    && isRecord(value.staticAnalysis)
    && Array.isArray(value.reviewers)
    && Array.isArray(value.gates)
    && typeof value.complete === "boolean"
    && typeof value.autoPromotionAllowed === "boolean"
    && isNonEmptyString(value.completedAt);
}

function isSignedCandidateArtifact(value: unknown): boolean {
  return isRecord(value)
    && isNonEmptyString(value.candidateId)
    && isSha256(value.candidateDigest)
    && isSha256(value.validationDigest)
    && isSha256(value.packageDigest)
    && isNonEmptyString(value.signerKeyId)
    && value.algorithm === "ed25519"
    && isNonEmptyString(value.signatureBase64)
    && isNonEmptyString(value.signedAt);
}

function isSignedWhitelistEntry(value: unknown): boolean {
  return isRecord(value)
    && isNonEmptyString(value.candidateId)
    && (value.kind === "tool" || value.kind === "skill")
    && isNonEmptyString(value.name)
    && isNonEmptyString(value.version)
    && isToolRiskLevel(value.riskLevel)
    && isStringArray(value.capabilities)
    && isSha256(value.candidateDigest)
    && isSha256(value.validationDigest)
    && isSha256(value.packageDigest)
    && isNonEmptyString(value.signerKeyId)
    && isNonEmptyString(value.signatureBase64)
    && isNonEmptyString(value.signedAt)
    && isNonEmptyString(value.decisionSignatureBase64)
    && (value.status === "active" || value.status === "disabled" || value.status === "rolledBack")
    && (value.promotionMode === "automatic" || value.promotionMode === "manual")
    && isNonEmptyString(value.activatedAt)
    && isNonEmptyString(value.updatedAt);
}

function isEvolutionAuditEntry(value: unknown): boolean {
  return isRecord(value)
    && isNonEmptyString(value.id)
    && (value.candidateId === undefined || isNonEmptyString(value.candidateId))
    && isNonEmptyString(value.action)
    && isNonEmptyString(value.actor)
    && isNonEmptyString(value.summary)
    && isNonEmptyString(value.createdAt);
}

function validateBoolean(validator: () => unknown): boolean {
  try {
    validator();
    return true;
  } catch {
    return false;
  }
}

function isComputerCertification(value: unknown): boolean {
  return isRecord(value)
    && (value.status === "certified" || value.status === "inspect-only" || value.status === "blocked")
    && (value.applicationId === undefined || isNonEmptyString(value.applicationId))
    && (value.displayName === undefined || isNonEmptyString(value.displayName))
    && isStringArray(value.allowedActions)
    && value.allowedActions.every(action => action === "click" || action === "type" || action === "shortcut")
    && isStringArray(value.allowedShortcuts)
    && isStringArray(value.reasons)
    && (value.manifestSha256 === undefined || isSha256(value.manifestSha256));
}

function isComputerWindowRecord(value: unknown): boolean {
  return isRecord(value)
    && validateBoolean(() => validateRunningApplicationIdentity(value.identity))
    && isComputerCertification(value.certification);
}

function isComputerElementEvidence(value: unknown): boolean {
  return isRecord(value)
    && isNonEmptyString(value.snapshotId)
    && isSha256(value.snapshotSha256)
    && isNonEmptyString(value.elementId)
    && Array.isArray(value.runtimeId)
    && value.runtimeId.every(Number.isInteger)
    && isNonEmptyString(value.role)
    && typeof value.name === "string"
    && typeof value.automationId === "string"
    && typeof value.className === "string"
    && isRecord(value.bounds)
    && [value.bounds.x, value.bounds.y, value.bounds.width, value.bounds.height].every(item => typeof item === "number" && Number.isFinite(item));
}

function isPreparedComputerAction(value: unknown): boolean {
  return isRecord(value)
    && isNonEmptyString(value.id)
    && (value.action === "click" || value.action === "type" || value.action === "shortcut")
    && isNonEmptyString(value.applicationId)
    && isSha256(value.identityFingerprint)
    && isSha256(value.manifestSha256)
    && isNonEmptyString(value.snapshotId)
    && (value.evidence === undefined || isComputerElementEvidence(value.evidence))
    && (value.shortcut === undefined || isNonEmptyString(value.shortcut))
    && (value.textSha256 === undefined || isSha256(value.textSha256))
    && isNonEmptyString(value.reason)
    && isStringArray(value.requestedCapabilities)
    && isNonEmptyString(value.createdAt)
    && isNonEmptyString(value.expiresAt);
}

function isComputerUseAuditEntry(value: unknown): boolean {
  return isRecord(value)
    && isNonEmptyString(value.id)
    && isNonEmptyString(value.timestamp)
    && (value.action === "inspect" || value.action === "screenshot" || value.action === "click" || value.action === "type" || value.action === "shortcut")
    && (value.decision === "allowed" || value.decision === "denied" || value.decision === "completed" || value.decision === "failed")
    && isNonNegativeInteger(value.processId)
    && isNonEmptyString(value.windowHandle)
    && (value.applicationId === undefined || isNonEmptyString(value.applicationId))
    && (value.snapshotId === undefined || isNonEmptyString(value.snapshotId))
    && (value.elementId === undefined || isNonEmptyString(value.elementId))
    && isNonEmptyString(value.reason);
}

function isNetworkMode(value: unknown): boolean {
  return value === "offline" || value === "lan" || value === "internet";
}

function isEgressAuditEntry(value: unknown): boolean {
  return isRecord(value)
    && isNonEmptyString(value.id)
    && isNonEmptyString(value.timestamp)
    && isNonEmptyString(value.purpose)
    && isNetworkMode(value.mode)
    && isNonEmptyString(value.method)
    && isNonEmptyString(value.redactedUrl)
    && isNonEmptyString(value.hostname)
    && isNonNegativeInteger(value.port)
    && isStringArray(value.addresses)
    && (value.selectedAddress === undefined || isNonEmptyString(value.selectedAddress))
    && (value.decision === "allowed" || value.decision === "denied" || value.decision === "completed" || value.decision === "failed")
    && isNonEmptyString(value.reason)
    && (value.status === undefined || isNonNegativeInteger(value.status))
    && (value.byteLength === undefined || isNonNegativeInteger(value.byteLength));
}

function isWebDownloadArtifact(value: unknown): boolean {
  return isRecord(value)
    && isNonEmptyString(value.id)
    && isNonEmptyString(value.workspaceId)
    && isNonEmptyString(value.fileName)
    && isNonEmptyString(value.relativePath)
    && isNonEmptyString(value.sourceUrl)
    && isNonEmptyString(value.contentType)
    && isNonNegativeInteger(value.byteLength)
    && isSha256(value.sha256)
    && isNonEmptyString(value.createdAt);
}

function isWebFetchResult(value: unknown): boolean {
  return isRecord(value)
    && isNonEmptyString(value.url)
    && isNonNegativeInteger(value.status)
    && isNonEmptyString(value.contentType)
    && (value.title === undefined || typeof value.title === "string")
    && typeof value.text === "string"
    && typeof value.truncated === "boolean"
    && isNonNegativeInteger(value.byteLength)
    && Array.isArray(value.redirects)
    && value.redirects.every(hop => isRecord(hop)
      && isNonEmptyString(hop.fromUrl)
      && isNonEmptyString(hop.toUrl)
      && isNonNegativeInteger(hop.status));
}

function isWebSearchResult(value: unknown): boolean {
  return isRecord(value)
    && isNonEmptyString(value.query)
    && isNonEmptyString(value.provider)
    && Array.isArray(value.results)
    && value.results.every(item => isRecord(item)
      && isNonEmptyString(item.title)
      && isNonEmptyString(item.url)
      && isNonEmptyString(item.snippet)
      && (item.source === undefined || typeof item.source === "string"));
}

function isBrowserSessionRecord(value: unknown): boolean {
  return isRecord(value)
    && isNonEmptyString(value.id)
    && isNonEmptyString(value.workspaceId)
    && isNetworkMode(value.networkMode)
    && (value.status === "starting" || value.status === "ready" || value.status === "navigating"
      || value.status === "failed" || value.status === "closed")
    && (value.currentUrl === undefined || isNonEmptyString(value.currentUrl))
    && (value.title === undefined || typeof value.title === "string")
    && (value.lastSnapshotId === undefined || isNonEmptyString(value.lastSnapshotId))
    && isNonEmptyString(value.createdAt)
    && isNonEmptyString(value.updatedAt)
    && (value.error === undefined || (isRecord(value.error)
      && isNonEmptyString(value.error.code)
      && isNonEmptyString(value.error.message)));
}

function isBrowserElementSnapshot(value: unknown): boolean {
  return isRecord(value)
    && isNonEmptyString(value.id)
    && isNonEmptyString(value.role)
    && typeof value.name === "string"
    && (value.value === undefined || typeof value.value === "string")
    && typeof value.disabled === "boolean";
}

function isBrowserDomSnapshot(value: unknown): boolean {
  return isRecord(value)
    && isNonEmptyString(value.id)
    && isNonEmptyString(value.sessionId)
    && isNonEmptyString(value.url)
    && typeof value.title === "string"
    && typeof value.text === "string"
    && Array.isArray(value.elements)
    && value.elements.every(isBrowserElementSnapshot)
    && isSha256(value.sha256)
    && isNonEmptyString(value.createdAt);
}

function isBrowserScreenshot(value: unknown): boolean {
  return isRecord(value)
    && isNonEmptyString(value.sessionId)
    && isNonEmptyString(value.snapshotId)
    && value.mimeType === "image/png"
    && typeof value.base64 === "string"
    && isNonNegativeInteger(value.byteLength)
    && isSha256(value.sha256);
}

function isBrowserActionResult(value: unknown): boolean {
  return isRecord(value)
    && value.verified === true
    && isNonEmptyString(value.beforeSnapshotId)
    && isBrowserDomSnapshot(value.afterSnapshot)
    && (value.action === "click" || value.action === "type");
}

export function isIpcMessage(value: unknown): value is IpcMessage {
  if (!isRecord(value) || typeof value.kind !== "string") {
    return false;
  }

  if (value.kind === "cancel") {
    return hasOnlyKeys(value, ["kind", "id"]) && isNonEmptyString(value.id);
  }

  if (value.kind === "request") {
    if (typeof value.id !== "string" || typeof value.method !== "string" || !REQUEST_METHODS.has(value.method)) {
      return false;
    }
    return isRequestParams(value.method as IpcRequestMethod, value.params);
  }

  if (value.kind === "response") {
    if (typeof value.id !== "string" || typeof value.ok !== "boolean") {
      return false;
    }
    if (value.ok) {
      return "result" in value;
    }
    return isRecord(value.error)
      && typeof value.error.code === "string"
      && ERROR_CODES.has(value.error.code)
      && typeof value.error.message === "string";
  }

  if (value.kind === "event") {
    if (typeof value.method !== "string" || !EVENT_METHODS.has(value.method)) {
      return false;
    }
    return isEventPayload(value.method as IpcEventMethod, value.payload);
  }

  return false;
}

function isPermissionMode(value: unknown): boolean {
  return value === "default" || value === "autoReview" || value === "fullAccess";
}

function isSessionStatus(value: unknown): boolean {
  return value === "idle" || value === "running" || value === "awaitingPermission"
    || value === "completed" || value === "failed" || value === "aborted";
}

function isPlanStatus(value: unknown): boolean {
  return value === "reviewing" || value === "approved" || value === "rejected"
    || value === "executing" || value === "completed" || value === "failed" || value === "cancelled";
}

function isToolRiskLevel(value: unknown): boolean {
  return value === "pure-compute" || value === "workspace-read" || value === "workspace-write"
    || value === "process" || value === "network" || value === "browser"
    || value === "computer-use" || value === "security-core";
}

function isSha256(value: unknown): boolean {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}
