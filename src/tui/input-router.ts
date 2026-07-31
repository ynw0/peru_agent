import {
  isTuiMouseInputFragment,
  TuiTerminalInputDecoder,
  type TuiMouseEvent,
} from "./mouse.js";

export type TuiInputEvent =
  | { readonly kind: "mouse"; readonly event: TuiMouseEvent }
  | { readonly kind: "text"; readonly value: string };

/**
 * Ink 是终端输入的唯一读取者。路由器接收 useInput 已分帧的值，在文本
 * reducer 之前消费鼠标报告；decoder 仍保留分片能力，便于自定义 stdin。
 */
export class TuiInputRouter {
  private readonly decoder = new TuiTerminalInputDecoder();

  public constructor(private readonly dispatch: (event: TuiInputEvent) => void) {}

  /** 返回 true 表示该值属于鼠标报告，调用方不得再把它当成文本。 */
  public feed(value: string): boolean {
    const events = this.decoder.feed(value);
    for (const event of events) {
      this.dispatch({ kind: "mouse", event });
    }
    return events.length > 0 || isTuiMouseInputFragment(value);
  }

  public reset(): void {
    this.decoder.reset();
  }
}
