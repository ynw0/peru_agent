/*---------------------------------------------------------------------------------------------
 * Independent AI IDE placeholder views.
 * Phase 2 先验证 Workbench 原生容器、视图和生命周期接入，后续再连接 Agent Runtime。
 *--------------------------------------------------------------------------------------------*/

import { $, append } from 'vs/base/browser/dom';
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

// 同一个轻量视图类承载四个入口，减少 Phase 2 的重复 UI 代码。
export class IndependentAiIdePlaceholderView extends ViewPane {
	constructor(
		private readonly heading: string,
		private readonly description: string,
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
		// ViewPane 负责标题栏、布局、生命周期和 Workbench 服务接入。
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
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);

		// 使用 Workbench 自带 DOM 工具创建占位内容，不引入 React 或第三方 UI 依赖。
		const root = append(container, $('.independent-ai-ide-placeholder'));
		root.style.padding = '16px';
		root.style.display = 'flex';
		root.style.flexDirection = 'column';
		root.style.gap = '8px';

		const heading = append(root, $('h2'));
		heading.textContent = this.heading;
		heading.style.margin = '0';
		heading.style.fontSize = '14px';

		const description = append(root, $('p'));
		description.textContent = this.description;
		description.style.margin = '0';
		description.style.opacity = '0.8';
		description.style.lineHeight = '1.5';
	}
}
