/*---------------------------------------------------------------------------------------------
 * Independent AI IDE Workbench identifiers.
 * 本文件只保存稳定 ID，避免 UI、命令和状态存储使用不同字符串。
 *--------------------------------------------------------------------------------------------*/

export const INDEPENDENT_AI_IDE_CONTAINER_IDS = {
	agent: 'independentAiIde.agent',
	tasks: 'independentAiIde.tasks',
	permissions: 'independentAiIde.permissions',
	browser: 'independentAiIde.browser',
	computerUse: 'independentAiIde.computerUse',
	evolution: 'independentAiIde.evolution',
	release: 'independentAiIde.release',
} as const;

export const INDEPENDENT_AI_IDE_VIEW_IDS = {
	chat: 'independentAiIde.chat',
	taskList: 'independentAiIde.taskList',
	permissionQueue: 'independentAiIde.permissionQueue',
	browserSession: 'independentAiIde.browserSession',
	computerSession: 'independentAiIde.computerSession',
	evolutionCandidates: 'independentAiIde.evolutionCandidates',
	releaseCenter: 'independentAiIde.releaseCenter',
} as const;
