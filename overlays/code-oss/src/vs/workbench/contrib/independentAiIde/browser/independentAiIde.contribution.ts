import {
  registerIndependentAiIdeWorkbench,
  type IndependentAiIdeWorkbenchAdapter,
} from "../common/independentAiIde.contribution.js";

// 真实 Code OSS API 绑定集中在这里；上游接口变化时只修改这一层。
export function activateIndependentAiIdeContribution(
  adapter: IndependentAiIdeWorkbenchAdapter,
): void {
  registerIndependentAiIdeWorkbench(adapter);
}
