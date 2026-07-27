/*---------------------------------------------------------------------------------------------
 * Independent AI IDE interactive Workbench views.
 * 所有按钮只调用 Workbench Bridge；View 不直接执行 Tool、Shell 或文件写入。
 *--------------------------------------------------------------------------------------------*/

import { IContextMenuService } from 'vs/platform/contextview/browser/contextView';
import { IContextKeyService } from 'vs/platform/contextkey/common/contextkey';
import { IConfigurationService } from 'vs/platform/configuration/common/configuration';
import { IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import { IKeybindingService } from 'vs/platform/keybinding/common/keybinding';
import { IOpenerService } from 'vs/platform/opener/common/opener';
import { ITelemetryService } from 'vs/platform/telemetry/common/telemetry';
import { IThemeService } from 'vs/platform/theme/common/themeService';
import { ViewPane } from 'vs/workbench/browser/parts/views/viewPane';
import { IViewletViewOptions } from 'vs/workbench/browser/parts/views/viewsViewlet';
import { IViewDescriptorService } from 'vs/workbench/common/views';
import {
	getIndependentAiIdeWorkbenchBridge,
	onIndependentAiIdeWorkbenchBridgeChanged,
	IndependentAiIdeWorkbenchBridge,
	IndependentAiIdeWorkbenchSnapshot,
} from 'vs/workbench/contrib/independentAiIde/common/independentAiIdeWorkbenchBridge';

export type IndependentAiIdeViewKind = 'agent' | 'tasks' | 'permissions' | 'browser';

export class IndependentAiIdeView extends ViewPane {
	private body: HTMLElement | undefined;
	private bridge: IndependentAiIdeWorkbenchBridge | undefined;
	private bridgeSubscription: { dispose(): void } | undefined;
	private snapshotSubscription: { dispose(): void } | undefined;
	private snapshot: IndependentAiIdeWorkbenchSnapshot | undefined;
	private errorMessage: string | undefined;

	constructor(
		private readonly kind: IndependentAiIdeViewKind,
		options: IViewletViewOptions,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IOpenerService openerService: IOpenerService,
		@IThemeService themeService: IThemeService,
		@ITelemetryService telemetryService: ITelemetryService,
	) {
		super(
			options,
			keybindingService,
			contextMenuService,
			configurationService,
			contextKeyService,
			viewDescriptorService,
			instantiationService,
			openerService,
			themeService,
			telemetryService,
		);
		this.attachBridge(getIndependentAiIdeWorkbenchBridge());
		this.bridgeSubscription = onIndependentAiIdeWorkbenchBridgeChanged(bridge => this.attachBridge(bridge));
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		this.body = container;
		this.render();
	}

	public override dispose(): void {
		this.snapshotSubscription?.dispose();
		this.bridgeSubscription?.dispose();
		super.dispose();
	}

	private attachBridge(bridge: IndependentAiIdeWorkbenchBridge | undefined): void {
		this.snapshotSubscription?.dispose();
		this.bridge = bridge;
		this.errorMessage = undefined;
		if (bridge === undefined) {
			this.snapshot = undefined;
		} else {
			this.snapshot = bridge.getSnapshot();
			this.snapshotSubscription = bridge.onSnapshot(snapshot => {
				this.snapshot = snapshot;
				this.render();
			});
		}
		this.render();
	}

	private render(): void {
		if (this.body === undefined) {
			return;
		}
		this.body.textContent = '';
		const root = createElement('div', 'independent-ai-ide-view');
		root.style.padding = '12px';
		root.style.display = 'flex';
		root.style.flexDirection = 'column';
		root.style.gap = '10px';
		this.body.appendChild(root);

		if (this.bridge === undefined || this.snapshot === undefined) {
			root.appendChild(createNotice('Agent Runtime 未连接。不会执行任何本地操作。'));
			return;
		}
		if (this.errorMessage !== undefined) {
			root.appendChild(createNotice(this.errorMessage));
		}

		switch (this.kind) {
			case 'agent':
				this.renderAgent(root, this.snapshot);
				break;
			case 'tasks':
				this.renderTasks(root, this.snapshot);
				break;
			case 'permissions':
				this.renderPermissions(root, this.snapshot);
				break;
			case 'browser':
				this.renderBrowser(root, this.snapshot);
				break;
		}
	}

	private renderAgent(root: HTMLElement, snapshot: IndependentAiIdeWorkbenchSnapshot): void {
		const status = createElement('div', 'independent-ai-ide-status');
		status.textContent = `状态：${snapshot.sessionStatus}　Token：${snapshot.usage.inputTokens + snapshot.usage.outputTokens}`;
		root.appendChild(status);

		const transcript = createElement('div', 'independent-ai-ide-transcript');
		transcript.style.display = 'flex';
		transcript.style.flexDirection = 'column';
		transcript.style.gap = '8px';
		for (const message of snapshot.chatMessages) {
			const card = createElement('div', `independent-ai-ide-message ${message.role}`);
			card.style.padding = '8px';
			card.style.border = '1px solid var(--vscode-panel-border)';
			const label = createElement('strong');
			label.textContent = message.role === 'user' ? '用户' : message.state === 'streaming' ? 'AI（生成中）' : 'AI';
			card.appendChild(label);
			const content = createElement('pre');
			content.textContent = message.content;
			content.style.whiteSpace = 'pre-wrap';
			content.style.margin = '6px 0 0';
			card.appendChild(content);
			transcript.appendChild(card);
		}
		root.appendChild(transcript);

		const input = document.createElement('textarea');
		input.rows = 4;
		input.placeholder = '输入任务或继续说明…';
		root.appendChild(input);
		const actions = createElement('div');
		actions.style.display = 'flex';
		actions.style.gap = '6px';
		actions.appendChild(this.createActionButton('发送', async () => {
			const value = input.value.trim();
			if (value === '') {
				throw new Error('消息不能为空');
			}
			await this.requireBridge().sendInput(value);
			input.value = '';
		}));
		actions.appendChild(this.createActionButton('停止', () => this.requireBridge().stop()));
		actions.appendChild(this.createActionButton('重试', () => this.requireBridge().retry()));
		root.appendChild(actions);
	}

	private renderTasks(root: HTMLElement, snapshot: IndependentAiIdeWorkbenchSnapshot): void {
		root.appendChild(createHeading('计划审核'));
		for (const plan of snapshot.plans) {
			const card = createCard(`${plan.title}（置信度 ${plan.confidence}）`, plan.summary);
			card.appendChild(createList(plan.affectedFiles));
			if (plan.status === 'reviewing') {
				card.appendChild(this.createActionButton('批准计划', () => this.requireBridge().resolvePlan(plan.planId, 'approved')));
				card.appendChild(this.createActionButton('拒绝计划', () => this.requireBridge().resolvePlan(plan.planId, 'rejected')));
			}
			root.appendChild(card);
		}

		root.appendChild(createHeading('子 Agent'));
		for (const task of snapshot.subagents) {
			const details = [
				`角色：${task.role}`,
				`深度：${task.depth}`,
				`状态：${task.status}`,
				task.verdict === undefined ? '' : `结论：${task.verdict}`,
				task.proposalId === undefined ? '' : `Diff：${task.proposalId}`,
				task.error === undefined ? '' : `错误：${task.error.code} ${task.error.message}`,
			].filter(Boolean).join('\n');
			root.appendChild(createCard(task.taskId, details));
		}

		root.appendChild(createHeading('Tool 调用'));
		for (const tool of snapshot.tools) {
			const details = `${tool.description}\n风险：${tool.riskLevel}\n状态：${tool.state}`;
			const card = createCard(tool.toolName, details);
			card.appendChild(createList(tool.affectedFiles));
			card.appendChild(createList(tool.progressMessages));
			root.appendChild(card);
		}

		root.appendChild(createHeading('Diff Review'));
		for (const proposal of snapshot.diffProposals) {
			const card = createCard(`Diff ${proposal.proposalId}`, `状态：${proposal.status}`);
			card.appendChild(createList(proposal.affectedFiles));
			if (proposal.status === 'proposed') {
				card.appendChild(this.createActionButton('接受修改', () => this.requireBridge().acceptDiff(proposal.proposalId)));
				card.appendChild(this.createActionButton('拒绝修改', () => this.requireBridge().rejectDiff(proposal.proposalId)));
			}
			root.appendChild(card);
		}

		root.appendChild(createHeading('Checkpoint'));
		for (const checkpoint of snapshot.checkpoints) {
			const card = createCard(checkpoint.checkpointId, checkpoint.restored ? '已恢复' : '可恢复');
			if (!checkpoint.restored) {
				card.appendChild(this.createActionButton('恢复', () => this.requireBridge().restoreCheckpoint(checkpoint.checkpointId)));
			}
			root.appendChild(card);
		}
	}


	private renderBrowser(root: HTMLElement, snapshot: IndependentAiIdeWorkbenchSnapshot): void {
		root.appendChild(createHeading('受控 Chromium'));
		const workspaceInput = document.createElement('input');
		workspaceInput.placeholder = 'Workspace ID';
		workspaceInput.value = snapshot.activeSessionId === undefined ? 'workspace' : 'workspace';
		root.appendChild(workspaceInput);
		const mode = document.createElement('select');
		for (const value of ['offline', 'lan', 'internet'] as const) {
			const option = document.createElement('option');
			option.value = value;
			option.textContent = value;
			mode.appendChild(option);
		}
		root.appendChild(mode);
		root.appendChild(this.createActionButton('创建受控浏览器', () => this.requireBridge().createBrowser(
			workspaceInput.value.trim(),
			mode.value as 'offline' | 'lan' | 'internet',
			'zh-CN',
		)));

		for (const session of snapshot.browserSessions) {
			const card = createCard(
				session.title ?? session.id,
				`状态：${session.status}\n网络：${session.networkMode}\nURL：${session.currentUrl ?? '-'}${session.error === undefined ? '' : `\n错误：${session.error.message}`}`,
			);
			if (session.status !== 'closed' && session.status !== 'failed') {
				const urlInput = document.createElement('input');
				urlInput.placeholder = 'https://example.com';
				urlInput.value = session.currentUrl ?? '';
				card.appendChild(urlInput);
				card.appendChild(this.createActionButton('导航', () => this.requireBridge().navigateBrowser(session.id, urlInput.value.trim())));
				card.appendChild(this.createActionButton('受控下载', () => this.requireBridge().downloadBrowser(session.id, urlInput.value.trim())));
				card.appendChild(this.createActionButton('刷新 DOM', () => this.requireBridge().refreshBrowserSnapshot(session.id)));
				card.appendChild(this.createActionButton('关闭', () => this.requireBridge().closeBrowser(session.id)));
			}
			root.appendChild(card);
		}

		const browserSnapshot = snapshot.browserSnapshot;
		if (browserSnapshot === undefined) {
			root.appendChild(createNotice('尚无 DOM Snapshot。浏览器只能通过 Broker Proxy 联网。'));
			return;
		}
		root.appendChild(createHeading(`DOM：${browserSnapshot.title}`));
		const summary = createElement('pre');
		summary.textContent = browserSnapshot.text.slice(0, 4000);
		summary.style.whiteSpace = 'pre-wrap';
		root.appendChild(summary);
		for (const element of browserSnapshot.elements.slice(0, 100)) {
			const card = createCard(`${element.role} · ${element.name || element.id}`, element.value ?? '');
			if (!element.disabled) {
				card.appendChild(this.createActionButton('点击', () => this.requireBridge().clickBrowser(
					browserSnapshot.sessionId,
					browserSnapshot.id,
					element.id,
				)));
				if (element.role === 'input' || element.role === 'textarea' || element.role === 'textbox') {
					const textInput = document.createElement('input');
					textInput.placeholder = '输入文本';
					card.appendChild(textInput);
					card.appendChild(this.createActionButton('输入', () => this.requireBridge().typeBrowser(
						browserSnapshot.sessionId,
						browserSnapshot.id,
						element.id,
						textInput.value,
					)));
				}
			}
			root.appendChild(card);
		}
	}

	private renderPermissions(root: HTMLElement, snapshot: IndependentAiIdeWorkbenchSnapshot): void {
		if (snapshot.pendingPermissions.length === 0) {
			root.appendChild(createNotice('当前没有待处理权限请求。'));
			return;
		}
		for (const permission of snapshot.pendingPermissions) {
			const card = createCard(permission.toolName, `风险：${permission.riskLevel}\n原因：${permission.reason}`);
			card.appendChild(createList(permission.capabilities));
			card.appendChild(createList(permission.affectedFiles));
			card.appendChild(this.createActionButton('允许一次', () => this.requireBridge().resolvePermission(permission.requestId, 'allow')));
			card.appendChild(this.createActionButton('拒绝', () => this.requireBridge().resolvePermission(permission.requestId, 'deny')));
			root.appendChild(card);
		}
	}

	private createActionButton(label: string, action: () => Promise<void>): HTMLButtonElement {
		const button = document.createElement('button');
		button.type = 'button';
		button.textContent = label;
		button.addEventListener('click', () => {
			button.disabled = true;
			this.errorMessage = undefined;
			void action().catch((error: unknown) => {
				this.errorMessage = error instanceof Error ? error.message : '未知操作错误';
			}).finally(() => {
				button.disabled = false;
				this.render();
			});
		});
		return button;
	}

	private requireBridge(): IndependentAiIdeWorkbenchBridge {
		if (this.bridge === undefined) {
			throw new Error('Agent Runtime 未连接');
		}
		return this.bridge;
	}
}

function createElement<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string): HTMLElementTagNameMap[K] {
	const element = document.createElement(tag);
	if (className !== undefined) {
		element.className = className;
	}
	return element;
}

function createHeading(text: string): HTMLElement {
	const heading = createElement('h3');
	heading.textContent = text;
	heading.style.margin = '6px 0 0';
	return heading;
}

function createNotice(text: string): HTMLElement {
	const notice = createElement('p');
	notice.textContent = text;
	notice.style.opacity = '0.8';
	return notice;
}

function createCard(title: string, description: string): HTMLElement {
	const card = createElement('section');
	card.style.padding = '8px';
	card.style.border = '1px solid var(--vscode-panel-border)';
	card.style.display = 'flex';
	card.style.flexDirection = 'column';
	card.style.gap = '6px';
	const heading = createElement('strong');
	heading.textContent = title;
	card.appendChild(heading);
	const body = createElement('div');
	body.textContent = description;
	body.style.whiteSpace = 'pre-wrap';
	card.appendChild(body);
	return card;
}

function createList(items: readonly string[]): HTMLElement {
	const list = createElement('ul');
	list.style.margin = '0';
	list.style.paddingLeft = '20px';
	for (const item of items) {
		const row = createElement('li');
		row.textContent = item;
		list.appendChild(row);
	}
	return list;
}
