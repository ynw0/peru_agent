export type TuiMouseWheelDirection = "up" | "down";
export type TuiMouseButton = "left" | "middle" | "right";

export interface TuiMouseModifiers {
  readonly shift: boolean;
  readonly alt: boolean;
  readonly ctrl: boolean;
}

/**
 * Incremental decoder for terminal mouse reports. Windows Terminal may split a
 * CSI/SGR report across stdin data events, or coalesce several reports into one
 * event while dragging. The decoder owns the partial suffix so callers never
 * have to guess whether a sequence is complete.
 */
export class TuiTerminalInputDecoder {
  private pending = "";

  public feed(value: string): readonly TuiMouseEvent[] {
    if (value.length === 0 && this.pending.length === 0) return [];
    this.pending += value;
    const events: TuiMouseEvent[] = [];
    while (this.pending.length > 0) {
      const candidate = findMouseCandidate(this.pending);
      if (candidate === undefined) {
        this.pending = possibleMousePrefix(this.pending);
        break;
      }
      if (candidate.index > 0) this.pending = this.pending.slice(candidate.index);
      const reportLength = completeMouseReportLength(this.pending);
      if (reportLength === undefined) break;
      const report = this.pending.slice(0, reportLength);
      this.pending = this.pending.slice(reportLength);
      const event = parseTuiMouseInput(report);
      if (event !== undefined) events.push(event);
    }
    return events;
  }

  public reset(): void {
    this.pending = "";
  }
}

export type TuiMouseEvent = TuiMouseModifiers & (
  {
    readonly kind: "wheel";
    /** Zero-based terminal coordinates. */
    readonly x: number;
    readonly y: number;
    readonly direction: TuiMouseWheelDirection;
    readonly amount: number;
  } | {
    readonly kind: "press" | "move" | "release";
    /** Zero-based terminal coordinates. */
    readonly x: number;
    readonly y: number;
    readonly button?: TuiMouseButton;
  }
);

/**
 * Ink 7 parses input before invoking useInput and strips the leading ESC from
 * unknown escape sequences. Accept both forms so SGR mouse events never fall
 * through to the text input reducer.
 */
export function parseTuiMouseInput(value: string): TuiMouseEvent | undefined {
  const sgr = /(?:\u001b)?\[<([0-9]+);([0-9]+);([0-9]+)([mM])/.exec(value);
  if (sgr !== null) {
    const code = Number.parseInt(sgr[1] ?? "", 10);
    const x = Math.max(0, Number.parseInt(sgr[2] ?? "1", 10) - 1);
    const y = Math.max(0, Number.parseInt(sgr[3] ?? "1", 10) - 1);
    const modifiers = mouseModifiers(code);
    if ((code & 64) !== 0) {
      return {
        kind: "wheel",
        x,
        y,
        direction: (code & 1) === 0 ? "up" : "down",
        amount: 3,
        ...modifiers,
      };
    }
    const button = buttonFromCode(code & 3);
    const isMotion = (code & 32) !== 0;
    const isRelease = sgr[4] === "m";
    return {
      kind: isMotion ? "move" : isRelease ? "release" : "press",
      x,
      y,
      ...(button === undefined ? {} : { button }),
      ...modifiers,
    };
  }

  // xterm legacy mouse mode: ESC [ M <button+32> <x+32> <y+32>.
  const legacy = /(?:\u001b)?\[M([\s\S]{3})/.exec(value);
  if (legacy !== null) {
    const first = legacy[1]?.charCodeAt(0) ?? 32;
    const code = first - 32;
    const x = Math.max(0, (legacy[1]?.charCodeAt(1) ?? 32) - 33);
    const y = Math.max(0, (legacy[1]?.charCodeAt(2) ?? 32) - 33);
    const modifiers = mouseModifiers(code);
    if ((code & 64) !== 0) {
      return {
        kind: "wheel",
        x,
        y,
        direction: (code & 1) === 0 ? "up" : "down",
        amount: 3,
        ...modifiers,
      };
    }
    const button = buttonFromCode(code & 3);
    return {
      kind: (code & 32) !== 0 ? "move" : (code & 3) === 3 ? "release" : "press",
      x,
      y,
      ...(button === undefined ? {} : { button }),
      ...modifiers,
    };
  }
  return undefined;
}

/** True for a complete or partial mouse CSI value delivered by Ink. */
export function isTuiMouseInputFragment(value: string): boolean {
  return /^(?:\u001b)?\[<(?:[0-9;]*)?$/.test(value)
    || /^(?:\u001b)?\[M[\s\S]{0,3}$/.test(value)
    || value === "\u001b" || value === "\u001b[";
}

/** Parse every mouse report in a raw stdin chunk; Windows Terminal commonly
 * coalesces several drag or wheel reports into one data event. */
export function parseTuiMouseInputs(value: string): readonly TuiMouseEvent[] {
  return new TuiTerminalInputDecoder().feed(value);
}

interface MouseCandidate { readonly index: number; }

function findMouseCandidate(value: string): MouseCandidate | undefined {
  const candidates: MouseCandidate[] = [];
  for (const token of ["\u001b[<", "[<", "\u001b[M", "[M"]) {
    const index = value.indexOf(token);
    if (index >= 0) candidates.push({ index });
  }
  candidates.sort((left, right) => left.index - right.index);
  return candidates[0];
}

function completeMouseReportLength(value: string): number | undefined {
  const sgr = /^(?:\u001b)?\[<[0-9]+;[0-9]+;[0-9]+[mM]/.exec(value);
  if (sgr !== null) return sgr[0].length;
  const legacy = /^(?:\u001b)?\[M[\s\S]{3}/.exec(value);
  if (legacy !== null) return legacy[0].length;
  return undefined;
}

function possibleMousePrefix(value: string): string {
  for (const prefix of ["\u001b[<", "[<", "\u001b[M", "[M", "\u001b[", "["]) {
    if (value.endsWith(prefix)) return prefix;
  }
  if (value.endsWith("\u001b")) return "\u001b";
  return "";
}

function buttonFromCode(value: number): TuiMouseButton | undefined {
  if (value === 0) return "left";
  if (value === 1) return "middle";
  if (value === 2) return "right";
  return undefined;
}

function mouseModifiers(code: number): TuiMouseModifiers {
  return {
    shift: (code & 4) !== 0,
    alt: (code & 8) !== 0,
    ctrl: (code & 16) !== 0,
  };
}
