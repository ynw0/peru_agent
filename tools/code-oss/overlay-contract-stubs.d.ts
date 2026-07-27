// 仅用于在未安装完整 Code OSS node_modules 时检查 Overlay 自身的 TypeScript 结构。
declare module 'vs/base/common/codicons' {
  export class Codicon {
    static readonly hubot: Codicon;
    static readonly beaker: Codicon;
    static readonly checklist: Codicon;
    static readonly shield: Codicon;
    static readonly globe: Codicon;
    static readonly deviceDesktop: Codicon;
    static readonly cloudDownload: Codicon;
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
    dispose(): void;
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

declare module 'vs/base/common/lifecycle' {
  export interface IDisposable { dispose(): void; }
}

declare module 'vs/base/common/cancellation' {
  import type { IDisposable } from 'vs/base/common/lifecycle';
  export interface CancellationToken {
    readonly isCancellationRequested: boolean;
    onCancellationRequested(listener: () => void): IDisposable;
  }
}

declare module 'vs/editor/common/core/position' {
  export class Position {
    constructor(lineNumber: number, column: number);
    readonly lineNumber: number;
    readonly column: number;
  }
}

declare module 'vs/editor/common/core/range' {
  export class Range {
    constructor(startLineNumber: number, startColumn: number, endLineNumber: number, endColumn: number);
  }
}

declare module 'vs/editor/common/model' {
  import type { Range } from 'vs/editor/common/core/range';
  export interface ITextModel {
    readonly uri: { toString(): string };
    getLanguageId(): string;
    getVersionId(): number;
    getLineCount(): number;
    getLineMaxColumn(lineNumber: number): number;
    getLineContent(lineNumber: number): string;
    getValueInRange(range: Range): string;
  }
}

declare module 'vs/editor/common/languages' {
  import type { CancellationToken } from 'vs/base/common/cancellation';
  import type { Position } from 'vs/editor/common/core/position';
  import type { Range } from 'vs/editor/common/core/range';
  import type { ITextModel } from 'vs/editor/common/model';
  export interface InlineCompletionContext {}
  export interface InlineCompletion {
    readonly insertText: string | { snippet: string };
    readonly range?: Range;
    readonly command?: { readonly id: string; readonly title: string; readonly arguments?: readonly unknown[] };
  }
  export interface InlineCompletions<TItem extends InlineCompletion = InlineCompletion> { readonly items: readonly TItem[]; }
  export interface InlineCompletionsProvider<T extends InlineCompletions = InlineCompletions> {
    provideInlineCompletions(model: ITextModel, position: Position, context: InlineCompletionContext, token: CancellationToken): Promise<T> | T;
    freeInlineCompletions(completions: T): void;
  }
}

declare module 'vs/editor/common/services/languageFeatures' {
  import type { InlineCompletionsProvider } from 'vs/editor/common/languages';
  import type { IDisposable } from 'vs/base/common/lifecycle';
  export interface ILanguageFeaturesService {
    readonly inlineCompletionsProvider: {
      register(selector: string | { readonly language?: string; readonly scheme?: string }, provider: InlineCompletionsProvider): IDisposable;
    };
  }
  export const ILanguageFeaturesService: ParameterDecorator;
}

declare module 'vs/platform/commands/common/commands' {
  import type { IDisposable } from 'vs/base/common/lifecycle';
  export const CommandsRegistry: {
    registerCommand(id: string, handler: (accessor: unknown, ...args: unknown[]) => void): IDisposable;
  };
}

declare module 'vs/workbench/common/contributions' {
  export interface IWorkbenchContributionsRegistry {
    registerWorkbenchContribution(contribution: new (...args: any[]) => unknown, phase: unknown): void;
  }
  export const Extensions: { readonly Workbench: unknown };
}

declare module 'vs/workbench/services/lifecycle/common/lifecycle' {
  export enum LifecyclePhase { Starting, Ready, Restored, Eventually }
}
