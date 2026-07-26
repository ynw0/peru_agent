// 子 Agent 默认最多两层，防止无限递归生成任务。
export const MAX_SUBAGENT_DEPTH = 2;

export interface SubagentAssignment {
  readonly depth: number;
  readonly allowedPaths: readonly string[];
  readonly writablePaths: readonly string[];
  readonly tokenBudget: number;
  readonly maxTurns: number;
}

// 子 Agent 创建前执行硬性验证。
export function validateSubagentAssignment(assignment: SubagentAssignment): void {
  if (assignment.depth < 1 || assignment.depth > MAX_SUBAGENT_DEPTH) {
    throw new Error(`子 Agent 深度必须在 1 到 ${MAX_SUBAGENT_DEPTH} 之间`);
  }
  if (assignment.tokenBudget <= 0 || assignment.maxTurns <= 0) {
    throw new Error("子 Agent 预算和最大轮次必须大于 0");
  }
  const invalidWritablePath = assignment.writablePaths.find(
    writablePath => !assignment.allowedPaths.includes(writablePath),
  );
  if (invalidWritablePath !== undefined) {
    throw new Error(`可写路径不在允许路径中：${invalidWritablePath}`);
  }
}
