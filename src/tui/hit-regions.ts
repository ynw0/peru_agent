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
    return this.regions.find(region => x >= region.left && x <= region.right && y >= region.top && y <= region.bottom);
  }

  public clear(): void {
    this.regions = [];
  }
}

