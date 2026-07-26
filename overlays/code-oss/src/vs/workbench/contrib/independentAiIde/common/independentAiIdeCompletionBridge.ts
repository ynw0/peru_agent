/*---------------------------------------------------------------------------------------------
 * Independent AI IDE inline-completion bridge.
 * Workbench 只传递受限文档上下文，不直接访问模型服务或凭据。
 *--------------------------------------------------------------------------------------------*/

export interface IndependentAiIdeCompletionInput {
	readonly documentUri: string;
	readonly languageId: string;
	readonly version: number;
	readonly offset: number;
	readonly text: string;
}

export interface IndependentAiIdeCompletionCandidate {
	readonly requestId: string;
	readonly text: string;
}

export interface IndependentAiIdeCompletionBridge {
	provideCompletion(input: IndependentAiIdeCompletionInput, signal: AbortSignal): Promise<IndependentAiIdeCompletionCandidate | null>;
	recordAccepted(requestId: string): Promise<void>;
}

let activeBridge: IndependentAiIdeCompletionBridge | undefined;

export function setIndependentAiIdeCompletionBridge(bridge: IndependentAiIdeCompletionBridge | undefined): void {
	activeBridge = bridge;
}

export function getIndependentAiIdeCompletionBridge(): IndependentAiIdeCompletionBridge | undefined {
	return activeBridge;
}
