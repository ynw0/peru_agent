export type TuiMouseWheelDirection = "up" | "down";
export type TuiMouseButton = "left" | "middle" | "right";

export interface TuiMouseModifiers {
  readonly shift: boolean;
  readonly alt: boolean;
  readonly ctrl: boolean;
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

/** Parse every mouse report in a raw stdin chunk; Windows Terminal commonly
 * coalesces several drag or wheel reports into one data event. */
export function parseTuiMouseInputs(value: string): readonly TuiMouseEvent[] {
  const reports = value.match(/(?:\u001b)?\[<[0-9]+;[0-9]+;[0-9]+[mM]|(?:\u001b)?\[M[\s\S]{3}/g) ?? [];
  return reports.flatMap(report => {
    const event = parseTuiMouseInput(report);
    return event === undefined ? [] : [event];
  });
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
