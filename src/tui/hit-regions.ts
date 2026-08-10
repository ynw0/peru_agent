export interface TuiHitRegion {
  readonly id: "timeline" | "input" | "suggestions" | "overlay";
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

/** Mutable per-frame hit map; it stores no business state. */
export class TuiHitRegionRegistry {
  private regions: readonly TuiHitRegion[] = [];

  public set(regions: readonly TuiHitRegion[]): void {
    this.regions = [...regions];
  }

  public hit(x: number, y: number): TuiHitRegion | undefined {
    const exact = this.regions.find(region => x >= region.left && x <= region.right && y >= region.top && y <= region.bottom);
    if (exact !== undefined) return exact;
    // 会话主界面只注册 timeline。全屏 TUI 中滚轮应始终滚当前会话，
    // 不能因为鼠标停在 Header/Input/Footer 就把滚轮丢给终端 scrollback。
    if (this.regions.length === 1 && this.regions[0]?.id === "timeline") return this.regions[0];
    return undefined;
  }

  public clear(): void {
    this.regions = [];
  }
}

