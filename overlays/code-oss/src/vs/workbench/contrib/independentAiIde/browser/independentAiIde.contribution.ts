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
import { IndependentAiIdePlaceholderView } from 'vs/workbench/contrib/independentAiIde/browser/independentAiIdeView';

const containersRegistry = Registry.as<IViewContainersRegistry>(ViewExtensions.ViewContainersRegistry);
const viewsRegistry = Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry);

const agentIcon = registerIcon('independent-ai-ide-agent-icon', Codicon.hubot, localize('independentAiIde.agentIcon', 'AI Agent view icon.'));
const tasksIcon = registerIcon('independent-ai-ide-tasks-icon', Codicon.checklist, localize('independentAiIde.tasksIcon', 'AI task view icon.'));
const permissionsIcon = registerIcon('independent-ai-ide-permissions-icon', Codicon.shield, localize('independentAiIde.permissionsIcon', 'AI permission view icon.'));
const browserIcon = registerIcon('independent-ai-ide-browser-icon', Codicon.globe, localize('independentAiIde.browserIcon', 'AI browser view icon.'));

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
	ViewContainerLocation.Sidebar,
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

// View 描述符是 Workbench 创建实际 ViewPane 实例的工厂配置。
function registerPlaceholderView(
	container: ViewContainer,
	id: string,
	name: string,
	heading: string,
	description: string,
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
		ctorDescriptor: new SyncDescriptor(IndependentAiIdePlaceholderView, [heading, description]),
		openCommandActionDescriptor: {
			id: commandId,
			title: name,
			order,
		},
	}], container);
}

registerPlaceholderView(
	agentContainer,
	INDEPENDENT_AI_IDE_VIEW_IDS.chat,
	localize('independentAiIde.chat', 'AI Agent'),
	localize('independentAiIde.chatHeading', 'AI Agent'),
	localize('independentAiIde.chatDescription', 'Agent Runtime will connect through the typed IPC boundary in the next phase.'),
	agentIcon,
	'workbench.view.independentAiIde.agent',
	10,
);
registerPlaceholderView(
	tasksContainer,
	INDEPENDENT_AI_IDE_VIEW_IDS.taskList,
	localize('independentAiIde.taskList', 'Tasks'),
	localize('independentAiIde.taskHeading', 'Agent Tasks'),
	localize('independentAiIde.taskDescription', 'Foreground, background, and sub-agent task states will appear here.'),
	tasksIcon,
	'workbench.view.independentAiIde.tasks',
	20,
);
registerPlaceholderView(
	permissionsContainer,
	INDEPENDENT_AI_IDE_VIEW_IDS.permissionQueue,
	localize('independentAiIde.permissionQueue', 'Permissions'),
	localize('independentAiIde.permissionHeading', 'Permission Queue'),
	localize('independentAiIde.permissionDescription', 'Pending file, process, network, browser, and Computer Use requests will require an explicit decision.'),
	permissionsIcon,
	'workbench.view.independentAiIde.permissions',
	30,
);
registerPlaceholderView(
	browserContainer,
	INDEPENDENT_AI_IDE_VIEW_IDS.browserSession,
	localize('independentAiIde.browserSession', 'Browser'),
	localize('independentAiIde.browserHeading', 'Controlled Browser'),
	localize('independentAiIde.browserDescription', 'Only isolated browser sessions governed by the configured network policy will be shown here.'),
	browserIcon,
	'workbench.view.independentAiIde.browser',
	40,
);
