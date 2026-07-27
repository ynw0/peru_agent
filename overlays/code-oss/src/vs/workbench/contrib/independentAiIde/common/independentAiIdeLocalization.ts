export type IndependentAiIdeLocale = 'zh-CN' | 'en-US';

const catalogs = {
	'zh-CN': {
		runtimeDisconnected: 'Agent Runtime 未连接。不会执行任何本地操作。', unknownError: '未知操作错误',
		status: '状态：{status}', tokens: 'Token：{tokens}', user: '用户', ai: 'AI', aiStreaming: 'AI（生成中）',
		chatPlaceholder: '输入任务或继续说明…', send: '发送', stop: '停止', retry: '重试',
		planReview: '计划审核', subagents: '子 Agent', toolCalls: 'Tool 调用', diffReview: 'Diff Review', checkpoints: 'Checkpoint',
		permissionsEmpty: '当前没有待处理权限请求。', allowOnce: '允许一次', deny: '拒绝',
		browserTitle: '受控 Chromium', browserCreate: '创建受控浏览器', computerTitle: '认证应用 Computer Use',
		computerNotice: '未认证应用只能检查。点击、输入和快捷键必须由 Agent Tool 经权限中心批准。',
		evolutionTitle: 'Tool / Skill 候选中心', evolutionRefresh: '刷新候选中心',
		releaseTitle: '发布与更新', locale: '界面语言', version: '当前版本：{version}', channel: '发布通道：{channel}',
		productionReady: '生产发布就绪：{ready}', blockers: '发布阻塞项', refresh: '刷新发布状态', yes: '是', no: '否',
	},
	'en-US': {
		runtimeDisconnected: 'Agent Runtime is not connected. No local action will be executed.', unknownError: 'Unknown operation error',
		status: 'Status: {status}', tokens: 'Tokens: {tokens}', user: 'User', ai: 'AI', aiStreaming: 'AI (streaming)',
		chatPlaceholder: 'Enter a task or continue the conversation…', send: 'Send', stop: 'Stop', retry: 'Retry',
		planReview: 'Plan Review', subagents: 'Subagents', toolCalls: 'Tool Calls', diffReview: 'Diff Review', checkpoints: 'Checkpoints',
		permissionsEmpty: 'There are no pending permission requests.', allowOnce: 'Allow once', deny: 'Deny',
		browserTitle: 'Controlled Chromium', browserCreate: 'Create controlled browser', computerTitle: 'Certified Computer Use',
		computerNotice: 'Uncertified applications are inspect-only. Click, type and shortcuts require Agent Tool permission approval.',
		evolutionTitle: 'Tool / Skill Candidate Center', evolutionRefresh: 'Refresh candidates',
		releaseTitle: 'Release and Updates', locale: 'Interface language', version: 'Current version: {version}', channel: 'Release channel: {channel}',
		productionReady: 'Production release ready: {ready}', blockers: 'Release blockers', refresh: 'Refresh release status', yes: 'Yes', no: 'No',
	},
} as const;

export type IndependentAiIdeMessageKey = keyof typeof catalogs['zh-CN'];

export function independentAiIdeLocalize(
	locale: IndependentAiIdeLocale,
	key: IndependentAiIdeMessageKey,
	parameters: Readonly<Record<string, string | number>> = {},
): string {
	const template = catalogs[locale][key];
	return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (_match, name: string) => {
		const value = parameters[name];
		if (value === undefined) {
			throw new Error(`Missing localization parameter: ${name}`);
		}
		return String(value);
	});
}
