// 独立 IDE 第一阶段只定义容器，不在此处实现具体 UI 框架。
export type WorkbenchContainerId =
  | "independentAiIde.agent"
  | "independentAiIde.tasks"
  | "independentAiIde.permissions"
  | "independentAiIde.browser"
  | "independentAiIde.computerUse"
  | "independentAiIde.evolution";

export interface LocalizedText {
  readonly "zh-CN": string;
  readonly "en-US": string;
}

export interface WorkbenchContainerDefinition {
  readonly id: WorkbenchContainerId;
  readonly title: LocalizedText;
  readonly iconId: string;
  readonly defaultLocation: "activityBar" | "panel";
  readonly order: number;
}

export const WORKBENCH_CONTAINERS: readonly WorkbenchContainerDefinition[] = [
  {
    id: "independentAiIde.agent",
    title: { "zh-CN": "AI Agent", "en-US": "AI Agent" },
    iconId: "sparkle",
    defaultLocation: "activityBar",
    order: 10,
  },
  {
    id: "independentAiIde.tasks",
    title: { "zh-CN": "任务", "en-US": "Tasks" },
    iconId: "tasklist",
    defaultLocation: "panel",
    order: 20,
  },
  {
    id: "independentAiIde.permissions",
    title: { "zh-CN": "权限", "en-US": "Permissions" },
    iconId: "shield",
    defaultLocation: "panel",
    order: 30,
  },
  {
    id: "independentAiIde.browser",
    title: { "zh-CN": "浏览器", "en-US": "Browser" },
    iconId: "globe",
    defaultLocation: "activityBar",
    order: 40,
  },
  {
    id: "independentAiIde.computerUse",
    title: { "zh-CN": "Computer Use", "en-US": "Computer Use" },
    iconId: "device-desktop",
    defaultLocation: "activityBar",
    order: 50,
  },
  {
    id: "independentAiIde.evolution",
    title: { "zh-CN": "候选中心", "en-US": "Evolution" },
    iconId: "beaker",
    defaultLocation: "activityBar",
    order: 60,
  },
];

export function validateWorkbenchContainers(
  definitions: readonly WorkbenchContainerDefinition[],
): void {
  const ids = new Set<string>();
  const orders = new Set<number>();

  for (const definition of definitions) {
    if (ids.has(definition.id)) {
      throw new Error(`Workbench 容器 ID 重复：${definition.id}`);
    }
    if (orders.has(definition.order)) {
      throw new Error(`Workbench 容器排序值重复：${definition.order}`);
    }
    if (definition.title["zh-CN"].trim() === "" || definition.title["en-US"].trim() === "") {
      throw new Error(`Workbench 容器标题不能为空：${definition.id}`);
    }
    ids.add(definition.id);
    orders.add(definition.order);
  }
}
