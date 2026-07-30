/*---------------------------------------------------------------------------------------------
 * Renderer-side bridge. It only invokes the Code OSS main-process channel.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from 'vs/base/common/lifecycle';
import { IMainProcessService } from 'vs/platform/ipc/electron-sandbox/services';
import { IConfigurationService } from 'vs/platform/configuration/common/configuration';
import { IWorkspaceContextService } from 'vs/platform/workspace/common/workspace';
import {
	IndependentAiIdeWorkbenchBridge,
	IndependentAiIdeWorkbenchSnapshot,
} from 'vs/workbench/contrib/independentAiIde/common/independentAiIdeWorkbenchBridge';

const EMPTY_SNAPSHOT: IndependentAiIdeWorkbenchSnapshot = {
	sessionStatus: 'none', chatMessages: [], plans: [], tools: [], pendingPermissions: [], diffProposals: [], checkpoints: [], subagents: [],
	browserSessions: [], computerWindows: [], computerPreparedActions: [], evolutionGaps: [], evolutionCandidates: [], evolutionWhitelist: [],
	release: { productVersion: '0.13.0', channel: 'stable', locale: 'zh-CN', installedVersions: [], productionReady: false, blockers: [] },
	usage: { inputTokens: 0, outputTokens: 0 },
};

export class IndependentAiIdeRuntimeBridge extends Disposable implements IndependentAiIdeWorkbenchBridge {
	private snapshot: IndependentAiIdeWorkbenchSnapshot = EMPTY_SNAPSHOT;
	private readonly snapshotListeners = new Set<(snapshot: IndependentAiIdeWorkbenchSnapshot) => void>();
	private readonly ready: Promise<void>;

	constructor(
		@IMainProcessService private readonly mainProcessService: IMainProcessService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
	) {
		super();
		this._register(this.mainProcessService.getChannel('independentAiIdeRuntime').listen<IndependentAiIdeWorkbenchSnapshot>('snapshot')(snapshot => this.acceptSnapshot(snapshot)));
		this.ready = this.mainProcessService.getChannel('independentAiIdeRuntime')
			.call<IndependentAiIdeWorkbenchSnapshot>('initialize', this.getModelConfiguration())
			.then(snapshot => this.acceptSnapshot(snapshot))
			.catch(error => {
				console.error('[Independent AI IDE] Runtime initialization failed.', error);
				throw error;
			});
	}

	getSnapshot(): IndependentAiIdeWorkbenchSnapshot { return this.snapshot; }

	onSnapshot(listener: (snapshot: IndependentAiIdeWorkbenchSnapshot) => void): { dispose(): void } {
		this.snapshotListeners.add(listener);
		listener(this.snapshot);
		return { dispose: () => this.snapshotListeners.delete(listener) };
	}

	async sendInput(input: string): Promise<void> {
		await this.ready;
		const folder = this.workspaceContextService.getWorkspace().folders[0];
		if (folder === undefined || folder.uri.scheme !== 'file') {
			throw new Error('请先打开本地文件夹工作区，再启动 AI Agent');
		}
		await this.call('sendInput', { workspaceId: folder.uri.toString(), rootPath: folder.uri.fsPath, input });
	}
	async stop(): Promise<void> { await this.ready; await this.call('stop'); }
	async retry(): Promise<void> { await this.ready; await this.call('retry'); }
	async resolvePlan(planId: string, decision: 'approved' | 'rejected'): Promise<void> { await this.call('resolvePlan', { planId, decision }); }
	async resolvePermission(requestId: string, decision: 'allow' | 'deny'): Promise<void> { await this.call('resolvePermission', { requestId, decision }); }
	async acceptDiff(proposalId: string): Promise<void> { await this.call('acceptDiff', { proposalId }); }
	async rejectDiff(proposalId: string): Promise<void> { await this.call('rejectDiff', { proposalId }); }
	async restoreCheckpoint(checkpointId: string): Promise<void> { await this.call('restoreCheckpoint', { checkpointId }); }

	async createBrowser(): Promise<void> { throw new Error('浏览器 Agent 尚未接入桌面运行时'); }
	async navigateBrowser(): Promise<void> { throw new Error('浏览器 Agent 尚未接入桌面运行时'); }
	async refreshBrowserSnapshot(): Promise<void> { throw new Error('浏览器 Agent 尚未接入桌面运行时'); }
	async downloadBrowser(): Promise<void> { throw new Error('浏览器 Agent 尚未接入桌面运行时'); }
	async clickBrowser(): Promise<void> { throw new Error('浏览器 Agent 尚未接入桌面运行时'); }
	async typeBrowser(): Promise<void> { throw new Error('浏览器 Agent 尚未接入桌面运行时'); }
	async closeBrowser(): Promise<void> { throw new Error('浏览器 Agent 尚未接入桌面运行时'); }
	async refreshComputerWindows(): Promise<void> { throw new Error('Computer Use 尚未接入桌面运行时'); }
	async inspectComputerWindow(): Promise<void> { throw new Error('Computer Use 尚未接入桌面运行时'); }
	async screenshotComputerWindow(): Promise<void> { throw new Error('Computer Use 尚未接入桌面运行时'); }
	async refreshEvolution(): Promise<void> { throw new Error('Evolution 尚未接入桌面运行时'); }
	async validateEvolutionCandidate(): Promise<void> { throw new Error('Evolution 尚未接入桌面运行时'); }
	async approveEvolutionCandidate(): Promise<void> { throw new Error('Evolution 尚未接入桌面运行时'); }
	async promoteEvolutionCandidate(): Promise<void> { throw new Error('Evolution 尚未接入桌面运行时'); }
	async disableEvolutionCandidate(): Promise<void> { throw new Error('Evolution 尚未接入桌面运行时'); }
	async rollbackEvolutionCandidate(): Promise<void> { throw new Error('Evolution 尚未接入桌面运行时'); }
	async refreshRelease(): Promise<void> { throw new Error('发布中心尚未接入桌面运行时'); }
	async setLocale(): Promise<void> { throw new Error('发布中心尚未接入桌面运行时'); }

	private async call(command: string, argument?: unknown): Promise<void> {
		await this.mainProcessService.getChannel('independentAiIdeRuntime').call<void>(command, argument);
	}

	private getModelConfiguration(): object {
		return {
			baseUrl: this.configurationService.getValue<string>('independentAiIde.model.baseUrl'),
			chatCompletionsPath: this.configurationService.getValue<string>('independentAiIde.model.chatCompletionsPath'),
			model: this.configurationService.getValue<string>('independentAiIde.model.name'),
			apiKeyEnvironmentVariable: this.configurationService.getValue<string>('independentAiIde.model.apiKeyEnvironmentVariable'),
		};
	}

	private acceptSnapshot(snapshot: IndependentAiIdeWorkbenchSnapshot): void {
		this.snapshot = {
			...EMPTY_SNAPSHOT,
			...snapshot,
			browserSessions: snapshot.browserSessions ?? EMPTY_SNAPSHOT.browserSessions,
			computerWindows: snapshot.computerWindows ?? EMPTY_SNAPSHOT.computerWindows,
			computerPreparedActions: snapshot.computerPreparedActions ?? EMPTY_SNAPSHOT.computerPreparedActions,
			evolutionGaps: snapshot.evolutionGaps ?? EMPTY_SNAPSHOT.evolutionGaps,
			evolutionCandidates: snapshot.evolutionCandidates ?? EMPTY_SNAPSHOT.evolutionCandidates,
			evolutionWhitelist: snapshot.evolutionWhitelist ?? EMPTY_SNAPSHOT.evolutionWhitelist,
			release: snapshot.release ?? EMPTY_SNAPSHOT.release,
		};
		for (const listener of this.snapshotListeners) {
			listener(this.snapshot);
		}
	}
}
