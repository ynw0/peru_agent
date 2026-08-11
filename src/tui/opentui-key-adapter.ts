import type { TuiInputKey } from "./input-buffer.js";

/** OpenTUI KeyEvent 的最小稳定结构，避免纯 reducer 测试依赖原生 renderer 包。 */
export interface OpenTuiKeyLike {
  readonly name: string;
  readonly sequence: string;
  readonly ctrl: boolean;
  readonly meta: boolean;
  readonly shift: boolean;
}

export interface OpenTuiInputEvent {
  readonly value: string;
  readonly key: TuiInputKey & {
    readonly escape?: boolean;
    readonly tab?: boolean;
    readonly pageUp?: boolean;
    readonly pageDown?: boolean;
  };
}

/** 把 OpenTUI KeyEvent 映射到既有纯输入 reducer，不复制编辑状态机。 */
export function adaptOpenTuiKey(event: OpenTuiKeyLike): OpenTuiInputEvent {
  const name = event.name.toLocaleLowerCase();
  const key: OpenTuiInputEvent["key"] = {
    ...(event.ctrl ? { ctrl: true } : {}),
    ...(event.meta ? { meta: true } : {}),
    ...(event.shift ? { shift: true } : {}),
    ...(name === "return" || name === "enter" ? { return: true } : {}),
    ...(name === "backspace" ? { backspace: true } : {}),
    ...(name === "delete" ? { delete: true } : {}),
    ...(name === "left" ? { left: true, leftArrow: true } : {}),
    ...(name === "right" ? { right: true, rightArrow: true } : {}),
    ...(name === "up" ? { up: true, upArrow: true } : {}),
    ...(name === "down" ? { down: true, downArrow: true } : {}),
    ...(name === "home" ? { home: true } : {}),
    ...(name === "end" ? { end: true } : {}),
    ...(name === "escape" ? { escape: true } : {}),
    ...(name === "tab" ? { tab: true } : {}),
    ...(name === "pageup" ? { pageUp: true } : {}),
    ...(name === "pagedown" ? { pageDown: true } : {}),
  };

  const controlName = name.length === 1 ? name : "";
  const value = event.ctrl || event.meta
    ? controlName
    : printableSequence(event.sequence, name);
  return { value, key };
}

function printableSequence(sequence: string, name: string): string {
  if (sequence.length === 1 && sequence >= " ") return sequence;
  if (name.length === 1 && name >= " ") return name;
  return "";
}
