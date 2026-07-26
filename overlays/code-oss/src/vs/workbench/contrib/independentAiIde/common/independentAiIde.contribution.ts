// 该文件会复制到固定版本 Code OSS 中，集中保存独立 AI IDE 的稳定标识。
export const INDEPENDENT_AI_IDE_CONTAINER_IDS = {
  agent: "independentAiIde.agent",
  tasks: "independentAiIde.tasks",
  permissions: "independentAiIde.permissions",
  browser: "independentAiIde.browser",
} as const;

export const INDEPENDENT_AI_IDE_VIEW_IDS = {
  chat: "independentAiIde.chat",
  taskList: "independentAiIde.taskList",
  permissionQueue: "independentAiIde.permissionQueue",
  browserSession: "independentAiIde.browserSession",
} as const;

// Code OSS 适配器负责调用真实 Workbench Registry；业务定义不直接依赖具体 API。
export interface IndependentAiIdeWorkbenchAdapter {
  registerActivityBarContainer(id: string, title: string, iconId: string, order: number): void;
  registerPanelContainer(id: string, title: string, iconId: string, order: number): void;
  registerView(containerId: string, viewId: string, title: string): void;
}

// 注册顺序固定，防止不同启动顺序导致容器位置漂移。
export function registerIndependentAiIdeWorkbench(
  adapter: IndependentAiIdeWorkbenchAdapter,
): void {
  adapter.registerActivityBarContainer(INDEPENDENT_AI_IDE_CONTAINER_IDS.agent, "AI Agent", "sparkle", 10);
  adapter.registerPanelContainer(INDEPENDENT_AI_IDE_CONTAINER_IDS.tasks, "Tasks", "tasklist", 20);
  adapter.registerPanelContainer(INDEPENDENT_AI_IDE_CONTAINER_IDS.permissions, "Permissions", "shield", 30);
  adapter.registerActivityBarContainer(INDEPENDENT_AI_IDE_CONTAINER_IDS.browser, "Browser", "globe", 40);

  adapter.registerView(INDEPENDENT_AI_IDE_CONTAINER_IDS.agent, INDEPENDENT_AI_IDE_VIEW_IDS.chat, "AI Agent");
  adapter.registerView(INDEPENDENT_AI_IDE_CONTAINER_IDS.tasks, INDEPENDENT_AI_IDE_VIEW_IDS.taskList, "Tasks");
  adapter.registerView(
    INDEPENDENT_AI_IDE_CONTAINER_IDS.permissions,
    INDEPENDENT_AI_IDE_VIEW_IDS.permissionQueue,
    "Permissions",
  );
  adapter.registerView(
    INDEPENDENT_AI_IDE_CONTAINER_IDS.browser,
    INDEPENDENT_AI_IDE_VIEW_IDS.browserSession,
    "Browser",
  );
}
