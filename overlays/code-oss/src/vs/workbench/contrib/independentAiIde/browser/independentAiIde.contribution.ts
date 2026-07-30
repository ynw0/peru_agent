import 'vs/workbench/contrib/independentAiIde/browser/independentAiIdeInlineCompletion';
/*---------------------------------------------------------------------------------------------
 * Independent AI IDE Workbench contribution.
 * 这里使用 Code OSS 1.74.0 原生 Registry 注册 Activity Bar、Panel 与 View。
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from 'vs/base/common/codicons';
import { localize } from 'vs/nls';
import { SyncDescriptor } from 'vs/platform/instantiation/common/descriptors';
import { Registry } from 'vs/platform/registry/common/platform';
import { registerIcon } from 'vs/platform/theme/common/iconRegistry';
import { ThemeIcon } from 'vs/platform/theme/common/themeService';
import { ViewPaneContainer } from 'vs/workbench/browser/parts/views/viewPaneContainer';
import {
	Extensions as ViewExtensions,
	IViewContainersRegistry,
	IViewsRegistry,
	ViewContainer,
	ViewContainerLocation,
} from 'vs/workbench/common/views';
import {
	INDEPENDENT_AI_IDE_CONTAINER_IDS,
	INDEPENDENT_AI_IDE_VIEW_IDS,
} from 'vs/workbench/contrib/independentAiIde/common/independentAiIde';
import { IndependentAiIdeView, IndependentAiIdeViewKind } from 'vs/workbench/contrib/independentAiIde/browser/independentAiIdeView';

const containersRegistry = Registry.as<IViewContainersRegistry>(ViewExtensions.ViewContainersRegistry);
const viewsRegistry = Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry);

const agentIcon = registerIcon('independent-ai-ide-agent-icon', Codicon.hubot, localize('independentAiIde.agentIcon', 'AI Agent view icon.'));
const tasksIcon = registerIcon('independent-ai-ide-tasks-icon', Codicon.checklist, localize('independentAiIde.tasksIcon', 'AI task view icon.'));
const permissionsIcon = registerIcon('independent-ai-ide-permissions-icon', Codicon.shield, localize('independentAiIde.permissionsIcon', 'AI permission view icon.'));
const browserIcon = registerIcon('independent-ai-ide-browser-icon', Codicon.globe, localize('independentAiIde.browserIcon', 'AI browser view icon.'));
const computerIcon = registerIcon('independent-ai-ide-computer-icon', Codicon.deviceDesktop, localize('independentAiIde.computerIcon', 'Certified Computer Use view icon.'));
const evolutionIcon = registerIcon('independent-ai-ide-evolution-icon', Codicon.beaker, localize('independentAiIde.evolutionIcon', 'Tool and Skill candidate view icon.'));
const releaseIcon = registerIcon('independent-ai-ide-release-icon', Codicon.cloudDownload, localize('independentAiIde.releaseIcon', 'Release and update view icon.'));

// 容器统一使用 ViewPaneContainer，具体状态和业务逻辑放在各 View 中。
function registerContainer(
	id: string,
	title: string,
	icon: ThemeIcon,
	order: number,
	location: ViewContainerLocation,
): ViewContainer {
	return containersRegistry.registerViewContainer({
		id,
		title,
		icon,
		order,
		ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [id, { mergeViewWithContainerWhenSingleView: true }]),
		storageId: id,
		hideIfEmpty: false,
	}, location);
}

const agentContainer = registerContainer(
	INDEPENDENT_AI_IDE_CONTAINER_IDS.agent,
	localize('independentAiIde.agent', 'AI Agent'),
	agentIcon,
	10,
	ViewContainerLocation.AuxiliaryBar,
);

const tasksContainer = registerContainer(
	INDEPENDENT_AI_IDE_CONTAINER_IDS.tasks,
	localize('independentAiIde.tasks', 'Tasks'),
	tasksIcon,
	20,
	ViewContainerLocation.Panel,
);
const permissionsContainer = registerContainer(
	INDEPENDENT_AI_IDE_CONTAINER_IDS.permissions,
	localize('independentAiIde.permissions', 'Permissions'),
	permissionsIcon,
	30,
	ViewContainerLocation.Panel,
);
const browserContainer = registerContainer(
	INDEPENDENT_AI_IDE_CONTAINER_IDS.browser,
	localize('independentAiIde.browser', 'Browser'),
	browserIcon,
	40,
	ViewContainerLocation.Sidebar,
);
const computerContainer = registerContainer(
	INDEPENDENT_AI_IDE_CONTAINER_IDS.computerUse,
	localize('independentAiIde.computerUse', 'Computer Use'),
	computerIcon,
	50,
	ViewContainerLocation.Sidebar,
);
const evolutionContainer = registerContainer(
	INDEPENDENT_AI_IDE_CONTAINER_IDS.evolution,
	localize('independentAiIde.evolution', 'Evolution'),
	evolutionIcon,
	60,
	ViewContainerLocation.Sidebar,
);
const releaseContainer = registerContainer(
	INDEPENDENT_AI_IDE_CONTAINER_IDS.release,
	localize('independentAiIde.release', 'Release & Updates'),
	releaseIcon,
	70,
	ViewContainerLocation.Sidebar,
);

// View 描述符是 Workbench 创建实际 ViewPane 实例的工厂配置。
function registerInteractiveView(
	container: ViewContainer,
	id: string,
	name: string,
	kind: IndependentAiIdeViewKind,
	icon: ThemeIcon,
	commandId: string,
	order: number,
): void {
	viewsRegistry.registerViews([{
		id,
		name,
		containerIcon: icon,
		canMoveView: true,
		canToggleVisibility: false,
		order,
		ctorDescriptor: new SyncDescriptor(IndependentAiIdeView, [kind]),
		openCommandActionDescriptor: {
			id: commandId,
			title: name,
			order,
		},
	}], container);
}

registerInteractiveView(
	agentContainer,
	INDEPENDENT_AI_IDE_VIEW_IDS.chat,
	localize('independentAiIde.chat', 'AI Agent'),
	'agent',
	agentIcon,
	'workbench.view.independentAiIde.agent',
	10,
);
registerInteractiveView(
	tasksContainer,
	INDEPENDENT_AI_IDE_VIEW_IDS.taskList,
	localize('independentAiIde.taskList', 'Tasks'),
	'tasks',
	tasksIcon,
	'workbench.view.independentAiIde.tasks',
	20,
);
registerInteractiveView(
	permissionsContainer,
	INDEPENDENT_AI_IDE_VIEW_IDS.permissionQueue,
	localize('independentAiIde.permissionQueue', 'Permissions'),
	'permissions',
	permissionsIcon,
	'workbench.view.independentAiIde.permissions',
	30,
);
registerInteractiveView(
	browserContainer,
	INDEPENDENT_AI_IDE_VIEW_IDS.browserSession,
	localize('independentAiIde.browserSession', 'Browser'),
	'browser',
	browserIcon,
	'workbench.view.independentAiIde.browser',
	40,
);
registerInteractiveView(
	computerContainer,
	INDEPENDENT_AI_IDE_VIEW_IDS.computerSession,
	localize('independentAiIde.computerSession', 'Computer Use'),
	'computer',
	computerIcon,
	'workbench.view.independentAiIde.computerUse',
	50,
);

registerInteractiveView(
	evolutionContainer,
	INDEPENDENT_AI_IDE_VIEW_IDS.evolutionCandidates,
	localize('independentAiIde.evolutionCandidates', 'Candidate Center'),
	'evolution',
	evolutionIcon,
	'workbench.view.independentAiIde.evolution',
	60,
);

registerInteractiveView(
	releaseContainer,
	INDEPENDENT_AI_IDE_VIEW_IDS.releaseCenter,
	localize('independentAiIde.releaseCenter', 'Release & Updates'),
	'release',
	releaseIcon,
	'workbench.view.independentAiIde.release',
	70,
);

import { Disposable } from 'vs/base/common/lifecycle';
import { IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import { Extensions as WorkbenchExtensions, IWorkbenchContributionsRegistry } from 'vs/workbench/common/contributions';
import { IPaneCompositePartService } from 'vs/workbench/services/panecomposite/browser/panecomposite';
import { IWorkbenchLayoutService, Parts } from 'vs/workbench/services/layout/browser/layoutService';
import { LifecyclePhase } from 'vs/workbench/services/lifecycle/common/lifecycle';
import { installIndependentAiIdeWorkbenchBridge } from 'vs/workbench/contrib/independentAiIde/common/independentAiIdeWorkbenchBridge';
import { IndependentAiIdeRuntimeBridge } from 'vs/workbench/contrib/independentAiIde/browser/independentAiIdeRuntimeBridge';

class IndependentAiIdeRuntimeContribution extends Disposable {
	constructor(
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super();
		try {
			this._register(installIndependentAiIdeWorkbenchBridge(instantiationService.createInstance(IndependentAiIdeRuntimeBridge)));
		} catch (error) {
			console.error('[Independent AI IDE] Runtime bridge creation failed.', error);
			return;
		}
	}
}

class IndependentAiIdeRightPanelContribution {
	constructor(
		@IPaneCompositePartService private readonly paneCompositePartService: IPaneCompositePartService,
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
	) {
		// The Auxiliary Bar DOM is created as part of layout restoration. Opening
		// the composite before that point silently returns `undefined`, which left
		// the Agent view registered but invisible on a fresh profile. Wait for the
		// native workbench restore barrier, then make the part visible and open the
		// registered native container.
		void this.layoutService.whenRestored.then(async () => {
			try {
				this.layoutService.setPartHidden(false, Parts.AUXILIARYBAR_PART);
				const panel = await this.paneCompositePartService.openPaneComposite(
					INDEPENDENT_AI_IDE_CONTAINER_IDS.agent,
					ViewContainerLocation.AuxiliaryBar,
					false,
				);
				if (!panel) {
					console.error('[Independent AI IDE] Agent panel was not registered in the Auxiliary Bar.');
				}
			} catch (error) {
				console.error('[Independent AI IDE] Unable to open the Agent panel on the right.', error);
			}
		});
	}
}

Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench)
	.registerWorkbenchContribution(IndependentAiIdeRuntimeContribution, LifecyclePhase.Starting);
Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench)
	.registerWorkbenchContribution(IndependentAiIdeRightPanelContribution, LifecyclePhase.Restored);
import { Extensions as ConfigurationExtensions, IConfigurationRegistry } from 'vs/platform/configuration/common/configurationRegistry';

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'independentAiIde',
	title: localize('independentAiIde.configuration', 'Independent AI IDE'),
	properties: {
		'independentAiIde.model.baseUrl': { type: 'string', description: localize('independentAiIde.model.baseUrl', 'OpenAI-compatible model service base URL.') },
		'independentAiIde.model.chatCompletionsPath': { type: 'string', description: localize('independentAiIde.model.chatCompletionsPath', 'Chat Completions API path, for example /v1/chat/completions.') },
		'independentAiIde.model.name': { type: 'string', description: localize('independentAiIde.model.name', 'Model name.') },
		'independentAiIde.model.apiKeyEnvironmentVariable': { type: 'string', description: localize('independentAiIde.model.apiKeyEnvironmentVariable', 'Environment variable containing the API key. The key itself is never saved in settings.') },
	},
});
