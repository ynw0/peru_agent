// 仅用于在未安装完整 Code OSS node_modules 时检查 Overlay 自身的 TypeScript 结构。
declare module 'vs/base/common/codicons' {
  export class Codicon {
    static readonly hubot: Codicon;
    static readonly checklist: Codicon;
    static readonly shield: Codicon;
    static readonly globe: Codicon;
  }
}

declare module 'vs/base/browser/dom' {
  export function $(selector: string): HTMLElement;
  export function append<T extends Node>(parent: Node, child: T): T;
}

declare module 'vs/nls' {
  export function localize(key: string, message: string): string;
}

declare module 'vs/platform/instantiation/common/descriptors' {
  export class SyncDescriptor<T = unknown> {
    constructor(ctor: new (...args: any[]) => T, staticArguments?: readonly unknown[]);
  }
}

declare module 'vs/platform/registry/common/platform' {
  export const Registry: {
    as<T>(id: unknown): T;
  };
}

declare module 'vs/platform/theme/common/themeService' {
  export interface ThemeIcon {}
  export interface IThemeService {}
  export const IThemeService: ParameterDecorator;
}

declare module 'vs/platform/theme/common/iconRegistry' {
  import type { ThemeIcon } from 'vs/platform/theme/common/themeService';
  export function registerIcon(id: string, icon: ThemeIcon, description: string): ThemeIcon;
}

declare module 'vs/platform/contextview/browser/contextView' {
  export interface IContextMenuService {}
  export const IContextMenuService: ParameterDecorator;
}

declare module 'vs/platform/contextkey/common/contextkey' {
  export interface IContextKeyService {}
  export const IContextKeyService: ParameterDecorator;
}

declare module 'vs/platform/configuration/common/configuration' {
  export interface IConfigurationService {}
  export const IConfigurationService: ParameterDecorator;
}

declare module 'vs/platform/instantiation/common/instantiation' {
  export interface IInstantiationService {}
  export const IInstantiationService: ParameterDecorator;
}

declare module 'vs/platform/keybinding/common/keybinding' {
  export interface IKeybindingService {}
  export const IKeybindingService: ParameterDecorator;
}

declare module 'vs/platform/opener/common/opener' {
  export interface IOpenerService {}
  export const IOpenerService: ParameterDecorator;
}

declare module 'vs/platform/telemetry/common/telemetry' {
  export interface ITelemetryService {}
  export const ITelemetryService: ParameterDecorator;
}

declare module 'vs/workbench/browser/parts/views/viewsViewlet' {
  export interface IViewletViewOptions {
    readonly id: string;
  }
}

declare module 'vs/workbench/browser/parts/views/viewPane' {
  import type { IViewletViewOptions } from 'vs/workbench/browser/parts/views/viewsViewlet';
  export class ViewPane {
    constructor(options: IViewletViewOptions, ...services: unknown[]);
    protected renderBody(container: HTMLElement): void;
  }
}

declare module 'vs/workbench/browser/parts/views/viewPaneContainer' {
  export class ViewPaneContainer {}
}

declare module 'vs/workbench/common/views' {
  import type { SyncDescriptor } from 'vs/platform/instantiation/common/descriptors';
  import type { ThemeIcon } from 'vs/platform/theme/common/themeService';

  export enum ViewContainerLocation {
    Sidebar,
    Panel,
    AuxiliaryBar,
  }

  export interface ViewContainer {
    readonly id: string;
  }

  export interface IViewContainerDescriptor {
    readonly id: string;
    readonly title: string;
    readonly icon?: ThemeIcon;
    readonly order?: number;
    readonly ctorDescriptor: SyncDescriptor<unknown>;
    readonly storageId?: string;
    readonly hideIfEmpty?: boolean;
  }

  export interface IViewContainersRegistry {
    registerViewContainer(
      descriptor: IViewContainerDescriptor,
      location: ViewContainerLocation,
      options?: { readonly isDefault?: boolean; readonly doNotRegisterOpenCommand?: boolean },
    ): ViewContainer;
  }

  export interface IViewDescriptorService {}
  export const IViewDescriptorService: ParameterDecorator;

  export interface IViewsRegistry {
    registerViews(
      views: readonly {
        readonly id: string;
        readonly name: string;
        readonly containerIcon?: ThemeIcon;
        readonly canMoveView?: boolean;
        readonly canToggleVisibility?: boolean;
        readonly order?: number;
        readonly ctorDescriptor: SyncDescriptor<unknown>;
        readonly openCommandActionDescriptor?: {
          readonly id: string;
          readonly title?: string;
          readonly order?: number;
        };
      }[],
      container: ViewContainer,
    ): void;
  }

  export const Extensions: {
    readonly ViewContainersRegistry: unknown;
    readonly ViewsRegistry: unknown;
  };
}
