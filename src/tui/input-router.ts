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
  private leftDragActive = false;
  private leftDragMoved = false;

  public constructor(private readonly dispatch: (event: TuiInputEvent) => void) {}

  /** 返回 true 表示该值属于鼠标报告，调用方不得再把它当成文本。 */
  public feed(value: string): boolean {
    const events = this.decoder.feed(value);
    for (const event of events) {
      if (event.kind === "press" && event.button === "left") {
        this.leftDragActive = true;
        this.leftDragMoved = false;
      } else if (event.kind === "move" && this.leftDragActive) {
        this.leftDragMoved = true;
      }

      this.dispatch({ kind: "mouse", event });

      if (event.kind === "release" && this.leftDragActive) {
        const shouldCopySelection = this.leftDragMoved;
        this.leftDragActive = false;
        this.leftDragMoved = false;
        if (shouldCopySelection) {
          // 复用 TuiApp 已有的右键复制路径：拖选松开后立即复制，
          // 不新增第二套 Clipboard 或 Selection 实现。
          this.dispatch({
            kind: "mouse",
            event: {
              kind: "press",
              button: "right",
              x: event.x,
              y: event.y,
              shift: event.shift,
              alt: event.alt,
              ctrl: event.ctrl,
            },
          });
        }
      }
    }
    return events.length > 0 || isTuiMouseInputFragment(value);
  }

  public reset(): void {
    this.decoder.reset();
    this.leftDragActive = false;
    this.leftDragMoved = false;
  }
}
