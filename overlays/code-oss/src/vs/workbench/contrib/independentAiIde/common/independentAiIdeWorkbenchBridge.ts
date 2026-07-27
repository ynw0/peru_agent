/*---------------------------------------------------------------------------------------------
 * Workbench 与独立 Agent Runtime 的最小桥接协议。
 * View 只能调用这些方法，不能直接访问文件系统、Shell 或 Tool 实例。
 *--------------------------------------------------------------------------------------------*/

export type IndependentAiIdeSessionStatus =
	| 'none'
	| 'idle'
	| 'running'
	| 'awaitingPermission'
	| 'completed'
	| 'failed'
	| 'aborted';

export interface IndependentAiIdeChatMessage {
	readonly id: string;
	readonly role: 'user' | 'assistant';
	readonly content: string;
	readonly state: 'streaming' | 'completed';
}

export interface IndependentAiIdePlanView {
	readonly planId: string;
	readonly title: string;
	readonly summary: string;
	readonly confidence: number;
	readonly affectedFiles: readonly string[];
	readonly status: 'reviewing' | 'approved' | 'rejected' | 'executing' | 'completed' | 'failed' | 'cancelled';
}

export interface IndependentAiIdeToolView {
	readonly toolCallId: string;
	readonly toolName: string;
	readonly description: string;
	readonly riskLevel: string;
	readonly affectedFiles: readonly string[];
	readonly progressMessages: readonly string[];
	readonly state: 'requested' | 'running' | 'completed' | 'failed';
}

export interface IndependentAiIdePermissionView {
	readonly requestId: string;
	readonly toolName: string;
	readonly riskLevel: string;
	readonly capabilities: readonly string[];
	readonly affectedFiles: readonly string[];
	readonly reason: string;
}

export interface IndependentAiIdeDiffView {
	readonly proposalId: string;
	readonly status: 'proposed' | 'accepted' | 'rejected' | 'conflict';
	readonly affectedFiles: readonly string[];
}

export interface IndependentAiIdeCheckpointView {
	readonly checkpointId: string;
	readonly restored: boolean;
}

export interface IndependentAiIdeSubagentView {
	readonly taskId: string;
	readonly role: 'planner' | 'explorer' | 'implementer' | 'reviewer' | 'tester';
	readonly depth: number;
	readonly status: 'queued' | 'running' | 'completed' | 'failed' | 'aborted' | 'patchProposed' | 'merged';
	readonly verdict?: 'approved' | 'rejected';
	readonly proposalId?: string;
	readonly error?: { readonly code: string; readonly message: string };
}

export interface IndependentAiIdeBrowserSessionView {
	readonly id: string;
	readonly workspaceId: string;
	readonly networkMode: 'offline' | 'lan' | 'internet';
	readonly status: 'starting' | 'ready' | 'navigating' | 'failed' | 'closed';
	readonly currentUrl?: string;
	readonly title?: string;
	readonly lastSnapshotId?: string;
	readonly error?: { readonly code: string; readonly message: string };
}

export interface IndependentAiIdeBrowserElementView {
	readonly id: string;
	readonly role: string;
	readonly name: string;
	readonly value?: string;
	readonly disabled: boolean;
}

export interface IndependentAiIdeBrowserSnapshotView {
	readonly id: string;
	readonly sessionId: string;
	readonly url: string;
	readonly title: string;
	readonly text: string;
	readonly elements: readonly IndependentAiIdeBrowserElementView[];
}


export interface IndependentAiIdeComputerCertificationView {
	readonly status: 'certified' | 'inspect-only' | 'blocked';
	readonly applicationId?: string;
	readonly displayName?: string;
	readonly reasons: readonly string[];
}

export interface IndependentAiIdeComputerWindowView {
	readonly processId: number;
	readonly windowHandle: string;
	readonly windowTitle: string;
	readonly executableName: string;
	readonly version: string;
	readonly windowClass: string;
	readonly integrityLevel: 'low' | 'medium' | 'high' | 'system' | 'unknown';
	readonly secureDesktop: boolean;
	readonly certification: IndependentAiIdeComputerCertificationView;
}

export interface IndependentAiIdeComputerElementView {
	readonly id: string;
	readonly role: string;
	readonly name: string;
	readonly automationId: string;
	readonly enabled: boolean;
	readonly offscreen: boolean;
	readonly isPassword: boolean;
	readonly patterns: readonly string[];
}

export interface IndependentAiIdeComputerSnapshotView {
	readonly id: string;
	readonly windowHandle: string;
	readonly windowTitle: string;
	readonly certification: IndependentAiIdeComputerCertificationView;
	readonly elements: readonly IndependentAiIdeComputerElementView[];
}

export interface IndependentAiIdeComputerActionView {
	readonly id: string;
	readonly action: 'click' | 'type' | 'shortcut';
	readonly applicationId: string;
	readonly reason: string;
	readonly expiresAt: string;
}


export interface IndependentAiIdeEvolutionGapView {
	readonly id: string;
	readonly outcome: string;
	readonly occurrenceCount: number;
	readonly requiredCapabilities: readonly string[];
	readonly autoForgeAllowed: boolean;
}

export interface IndependentAiIdeEvolutionCandidateView {
	readonly id: string;
	readonly kind: 'tool' | 'skill';
	readonly name: string;
	readonly version: string;
	readonly description: string;
	readonly riskLevel: string;
	readonly capabilities: readonly string[];
	readonly status: 'draft' | 'validating' | 'validationFailed' | 'awaitingManualApproval' | 'promoted' | 'disabled' | 'rolledBack';
	readonly validationComplete: boolean;
	readonly autoPromotionAllowed: boolean;
	readonly signerKeyId?: string;
	readonly manualDecision?: 'approved' | 'rejected';
}

export interface IndependentAiIdeEvolutionWhitelistView {
	readonly candidateId: string;
	readonly name: string;
	readonly version: string;
	readonly status: 'active' | 'disabled' | 'rolledBack';
	readonly promotionMode: 'automatic' | 'manual';
	readonly signerKeyId: string;
}

export interface IndependentAiIdeReleaseView {
	readonly productVersion: string;
	readonly channel: 'stable' | 'preview';
	readonly locale: 'zh-CN' | 'en-US';
	readonly currentVersion?: string;
	readonly previousVersion?: string;
	readonly installedVersions: readonly string[];
	readonly productionReady: boolean;
	readonly blockers: readonly string[];
	readonly lastCheckedAt?: string;
}

export interface IndependentAiIdeWorkbenchSnapshot {
	readonly activeSessionId?: string;
	readonly sessionStatus: IndependentAiIdeSessionStatus;
	readonly chatMessages: readonly IndependentAiIdeChatMessage[];
	readonly plans: readonly IndependentAiIdePlanView[];
	readonly tools: readonly IndependentAiIdeToolView[];
	readonly pendingPermissions: readonly IndependentAiIdePermissionView[];
	readonly diffProposals: readonly IndependentAiIdeDiffView[];
	readonly checkpoints: readonly IndependentAiIdeCheckpointView[];
	readonly subagents: readonly IndependentAiIdeSubagentView[];
	readonly browserSessions: readonly IndependentAiIdeBrowserSessionView[];
	readonly browserSnapshot?: IndependentAiIdeBrowserSnapshotView;
	readonly computerWindows: readonly IndependentAiIdeComputerWindowView[];
	readonly computerSnapshot?: IndependentAiIdeComputerSnapshotView;
	readonly computerPreparedActions: readonly IndependentAiIdeComputerActionView[];
	readonly evolutionGaps: readonly IndependentAiIdeEvolutionGapView[];
	readonly evolutionCandidates: readonly IndependentAiIdeEvolutionCandidateView[];
	readonly evolutionWhitelist: readonly IndependentAiIdeEvolutionWhitelistView[];
	readonly release: IndependentAiIdeReleaseView;
	readonly usage: { readonly inputTokens: number; readonly outputTokens: number };
	readonly failed?: { readonly code: string; readonly message: string };
}

export interface IndependentAiIdeWorkbenchBridge {
	getSnapshot(): IndependentAiIdeWorkbenchSnapshot;
	onSnapshot(listener: (snapshot: IndependentAiIdeWorkbenchSnapshot) => void): { dispose(): void };
	sendInput(input: string): Promise<void>;
	stop(): Promise<void>;
	retry(): Promise<void>;
	resolvePlan(planId: string, decision: 'approved' | 'rejected'): Promise<void>;
	resolvePermission(requestId: string, decision: 'allow' | 'deny'): Promise<void>;
	acceptDiff(proposalId: string): Promise<void>;
	rejectDiff(proposalId: string): Promise<void>;
	restoreCheckpoint(checkpointId: string): Promise<void>;
	createBrowser(workspaceId: string, networkMode: 'offline' | 'lan' | 'internet', locale: 'zh-CN' | 'en-US'): Promise<void>;
	navigateBrowser(browserSessionId: string, url: string): Promise<void>;
	refreshBrowserSnapshot(browserSessionId: string): Promise<void>;
	downloadBrowser(browserSessionId: string, url: string, maxBytes?: number): Promise<void>;
	clickBrowser(browserSessionId: string, snapshotId: string, elementId: string): Promise<void>;
	typeBrowser(browserSessionId: string, snapshotId: string, elementId: string, text: string): Promise<void>;
	closeBrowser(browserSessionId: string): Promise<void>;
	refreshComputerWindows(): Promise<void>;
	inspectComputerWindow(windowHandle: string): Promise<void>;
	screenshotComputerWindow(snapshotId: string): Promise<void>;
	refreshEvolution(): Promise<void>;
	validateEvolutionCandidate(candidateId: string): Promise<void>;
	approveEvolutionCandidate(candidateId: string, approverId: string, decision: 'approved' | 'rejected', reason: string): Promise<void>;
	promoteEvolutionCandidate(candidateId: string): Promise<void>;
	disableEvolutionCandidate(candidateId: string, reason: string): Promise<void>;
	rollbackEvolutionCandidate(candidateId: string, reason: string): Promise<void>;
	refreshRelease(): Promise<void>;
	setLocale(locale: 'zh-CN' | 'en-US'): Promise<void>;
}

let installedBridge: IndependentAiIdeWorkbenchBridge | undefined;
const bridgeListeners = new Set<(bridge: IndependentAiIdeWorkbenchBridge | undefined) => void>();

// Runtime 启动后显式安装桥接；未安装时 View 必须显示不可用状态。
export function installIndependentAiIdeWorkbenchBridge(
	bridge: IndependentAiIdeWorkbenchBridge,
): { dispose(): void } {
	if (installedBridge !== undefined) {
		throw new Error('Independent AI IDE Workbench bridge is already installed.');
	}
	installedBridge = bridge;
	for (const listener of bridgeListeners) {
		listener(bridge);
	}
	return {
		dispose: () => {
			if (installedBridge !== bridge) {
				return;
			}
			installedBridge = undefined;
			for (const listener of bridgeListeners) {
				listener(undefined);
			}
		},
	};
}

export function getIndependentAiIdeWorkbenchBridge(): IndependentAiIdeWorkbenchBridge | undefined {
	return installedBridge;
}

export function onIndependentAiIdeWorkbenchBridgeChanged(
	listener: (bridge: IndependentAiIdeWorkbenchBridge | undefined) => void,
): { dispose(): void } {
	bridgeListeners.add(listener);
	return { dispose: () => bridgeListeners.delete(listener) };
}
