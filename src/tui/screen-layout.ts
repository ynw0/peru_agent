export interface TuiScreenLayoutInput {
  readonly rows: number;
  readonly columns?: number;
  readonly headerRows: number;
  readonly suggestionRows: number;
  readonly inputRows?: number;
  readonly footerRows?: number;
  readonly timelineBorderRows?: number;
}

export interface TuiScreenLayout {
  readonly rootHeight: number;
  readonly timelineTopRow: number;
  readonly timelinePageSize: number;
  readonly timelineBoxHeight: number;
  readonly suggestionTopRow: number;
  readonly overlayHeight: number;
  /** Zero-based coordinates of the bordered timeline content area. */
  readonly timelineContentTopRow: number;
  readonly timelineContentBottomRow: number;
  readonly timelineContentLeftColumn: number;
  readonly timelineContentRightColumn: number;
}

/**
 * Calculates the live layout using terminal rows. The timeline page size is
 * content rows; border rows are accounted for separately so Ink never clips
 * the last message line or creates a fullscreen frame on Windows.
 */
export function calculateTuiScreenLayout(input: TuiScreenLayoutInput): TuiScreenLayout {
  const rootHeight = Math.max(1, Math.floor(input.rows) - 1);
  const headerRows = Math.max(0, Math.floor(input.headerRows));
  const suggestionRows = Math.max(0, Math.floor(input.suggestionRows));
  const inputRows = Math.max(1, Math.floor(input.inputRows ?? 3));
  const footerRows = Math.max(1, Math.floor(input.footerRows ?? 1));
  const timelineBorderRows = Math.max(0, Math.floor(input.timelineBorderRows ?? 2));
  const timelinePageSize = Math.max(
    1,
    rootHeight - headerRows - suggestionRows - inputRows - footerRows - timelineBorderRows,
  );
  return {
    rootHeight,
    timelineTopRow: headerRows + 1,
    timelinePageSize,
    timelineBoxHeight: timelinePageSize + timelineBorderRows,
    suggestionTopRow: Math.max(0, rootHeight - footerRows - suggestionRows),
    overlayHeight: rootHeight,
    timelineContentTopRow: headerRows + 1,
    timelineContentBottomRow: Math.max(headerRows + 1, headerRows + timelinePageSize),
    timelineContentLeftColumn: 4,
    timelineContentRightColumn: Math.max(4, Math.floor(input.columns ?? 80) - 3),
  };
}
