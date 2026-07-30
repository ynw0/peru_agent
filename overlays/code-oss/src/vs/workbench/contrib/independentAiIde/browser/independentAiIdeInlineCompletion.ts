/*---------------------------------------------------------------------------------------------
 * Code OSS 1.74.0 native inline-completion provider.
 *--------------------------------------------------------------------------------------------*/

import { IDisposable } from 'vs/base/common/lifecycle';
import { Position } from 'vs/editor/common/core/position';
import { Range } from 'vs/editor/common/core/range';
import { InlineCompletionContext, InlineCompletions, InlineCompletionsProvider } from 'vs/editor/common/languages';
import { ITextModel } from 'vs/editor/common/model';
import { ILanguageFeaturesService } from 'vs/editor/common/services/languageFeatures';
import { CancellationToken } from 'vs/base/common/cancellation';
import { CommandsRegistry } from 'vs/platform/commands/common/commands';
import { Registry } from 'vs/platform/registry/common/platform';
import { Extensions as WorkbenchExtensions, IWorkbenchContributionsRegistry } from 'vs/workbench/common/contributions';
import { LifecyclePhase } from 'vs/workbench/services/lifecycle/common/lifecycle';
import {
	getIndependentAiIdeCompletionBridge,
} from 'vs/workbench/contrib/independentAiIde/common/independentAiIdeCompletionBridge';

const ACCEPT_COMMAND_ID = 'independentAiIde.inlineCompletionAccepted';
const PREFIX_LINE_LIMIT = 200;
const SUFFIX_LINE_LIMIT = 100;
const PREFIX_CHAR_LIMIT = 24_000;
const SUFFIX_CHAR_LIMIT = 12_000;

class IndependentAiIdeInlineCompletionProvider implements InlineCompletionsProvider {
	public async provideInlineCompletions(
		model: ITextModel,
		position: Position,
		_context: InlineCompletionContext,
		token: CancellationToken,
	): Promise<InlineCompletions> {
		const bridge = getIndependentAiIdeCompletionBridge();
		if (bridge === undefined || token.isCancellationRequested) {
			return { items: [] };
		}

		const prefix = collectPrefix(model, position);
		const suffix = collectSuffix(model, position);
		const controller = new AbortController();
		const cancellation = token.onCancellationRequested(() => controller.abort());
		try {
			const candidate = await bridge.provideCompletion({
				documentUri: model.uri.toString(),
				languageId: model.getLanguageId(),
				version: model.getVersionId(),
				offset: prefix.length,
				text: prefix + suffix,
			}, controller.signal);
			if (candidate === null || controller.signal.aborted || candidate.text === '') {
				return { items: [] };
			}
			return {
				items: [{
					insertText: candidate.text,
					range: new Range(position.lineNumber, position.column, position.lineNumber, position.column),
					command: {
						id: ACCEPT_COMMAND_ID,
						title: 'Record AI completion acceptance',
						arguments: [candidate.requestId],
					},
				}],
			};
		} finally {
			cancellation.dispose();
		}
	}

	public freeInlineCompletions(_completions: InlineCompletions): void {
		// Provider 不在 Workbench 进程持有模型资源。
	}
}

export class IndependentAiIdeInlineCompletionContribution {
	private readonly providerRegistration: IDisposable;
	private readonly commandRegistration: IDisposable;

	public constructor(@ILanguageFeaturesService languageFeaturesService: ILanguageFeaturesService) {
		this.providerRegistration = languageFeaturesService.inlineCompletionsProvider.register(
			{ language: '*', scheme: 'file' },
			new IndependentAiIdeInlineCompletionProvider(),
		);
		this.commandRegistration = CommandsRegistry.registerCommand(ACCEPT_COMMAND_ID, (_accessor, requestId: unknown) => {
			if (typeof requestId !== 'string' || requestId.trim() === '') {
				return;
			}
			const bridge = getIndependentAiIdeCompletionBridge();
			if (bridge !== undefined) {
				void bridge.recordAccepted(requestId);
			}
		});
	}

	public dispose(): void {
		this.providerRegistration.dispose();
		this.commandRegistration.dispose();
	}
}

Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench).registerWorkbenchContribution(
	IndependentAiIdeInlineCompletionContribution,
	LifecyclePhase.Ready,
);

function collectPrefix(model: ITextModel, position: Position): string {
	const parts: string[] = [model.getLineContent(position.lineNumber).slice(0, position.column - 1)];
	let length = parts[0].length;
	const startLine = Math.max(1, position.lineNumber - PREFIX_LINE_LIMIT);
	for (let line = position.lineNumber - 1; line >= startLine && length < PREFIX_CHAR_LIMIT; line -= 1) {
		const content = model.getLineContent(line) + '\n';
		parts.unshift(content);
		length += content.length;
	}
	return parts.join('').slice(-PREFIX_CHAR_LIMIT);
}

function collectSuffix(model: ITextModel, position: Position): string {
	const parts: string[] = [model.getLineContent(position.lineNumber).slice(position.column - 1)];
	let length = parts[0].length;
	const endLine = Math.min(model.getLineCount(), position.lineNumber + SUFFIX_LINE_LIMIT);
	for (let line = position.lineNumber + 1; line <= endLine && length < SUFFIX_CHAR_LIMIT; line += 1) {
		const content = '\n' + model.getLineContent(line);
		parts.push(content);
		length += content.length;
	}
	return parts.join('').slice(0, SUFFIX_CHAR_LIMIT);
}
