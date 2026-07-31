import { TuiTerminalInputDecoder, type TuiMouseEvent } from "./mouse.js";

export type TuiInputEvent =
  | { readonly kind: "mouse"; readonly event: TuiMouseEvent }
  | { readonly kind: "text"; readonly value: string };

/**
 * Single owner for bytes arriving directly from the terminal. Ink continues
 * to provide normalized keyboard events; this router consumes mouse reports
 * before they can be mistaken for query text and preserves split sequences.
 */
export class TuiInputRouter {
  private readonly decoder = new TuiTerminalInputDecoder();

  public constructor(private readonly dispatch: (event: TuiInputEvent) => void) {}

  public feed(value: string): void {
    for (const event of this.decoder.feed(value)) {
      this.dispatch({ kind: "mouse", event });
    }
  }

  public reset(): void {
    this.decoder.reset();
  }
}

