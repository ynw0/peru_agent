/**
 * 权限规则匹配语义改编自 anomalyco/opencode 的 Permission 服务（MIT）。
 * 原项目许可证见 THIRD_PARTY/opencode-MIT.txt。
 *
 * 关键语义：规则按顺序合并，最后一个同时匹配 permission 与 pattern 的规则生效；
 * 没有匹配项时默认 ask。
 */
export type PermissionAction = "allow" | "ask" | "deny";
export type PermissionReply = "once" | "always" | "reject";

export interface PermissionRule {
  readonly permission: string;
  readonly pattern: string;
  readonly action: PermissionAction;
}

export interface ToolPermissionRequest {
  readonly permission: string;
  readonly patterns: readonly string[];
  readonly always: readonly string[];
  readonly metadata: Readonly<Record<string, unknown>>;
}

export function wildcardMatch(value: string, pattern: string): boolean {
  const normalized = value.replaceAll("\\", "/");
  let escaped = pattern
    .replaceAll("\\", "/")
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  // 与 OpenCode Wildcard.match 一致："git *" 同时匹配 "git" 和 "git ..."。
  if (escaped.endsWith(" .*")) escaped = `${escaped.slice(0, -3)}( .*)?`;
  return new RegExp(`^${escaped}$`, process.platform === "win32" ? "si" : "s").test(normalized);
}


export function evaluatePermission(
  permission: string,
  pattern: string,
  ...rulesets: readonly (readonly PermissionRule[])[]
): PermissionRule {
  const rules = rulesets.flat();
  for (let index = rules.length - 1; index >= 0; index -= 1) {
    const rule = rules[index];
    if (rule !== undefined
      && wildcardMatch(permission, rule.permission)
      && wildcardMatch(pattern, rule.pattern)) {
      return rule;
    }
  }
  return { permission, pattern: "*", action: "ask" };
}

export function mergePermissionRules(...rulesets: readonly (readonly PermissionRule[])[]): readonly PermissionRule[] {
  return rulesets.flat();
}
