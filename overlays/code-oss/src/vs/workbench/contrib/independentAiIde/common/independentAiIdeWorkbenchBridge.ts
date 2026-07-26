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

export interface IndependentAiIdeWorkbenchSnapshot {
	readonly activeSessionId?: string;
	readonly sessionStatus: IndependentAiIdeSessionStatus;
	readonly chatMessages: readonly IndependentAiIdeChatMessage[];
	readonly plans: readonly IndependentAiIdePlanView[];
	readonly tools: readonly IndependentAiIdeToolView[];
	readonly pendingPermissions: readonly IndependentAiIdePermissionView[];
	readonly diffProposals: readonly IndependentAiIdeDiffView[];
	readonly checkpoints: readonly IndependentAiIdeCheckpointView[];
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
