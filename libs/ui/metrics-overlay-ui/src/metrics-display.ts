/**
 * Shared presentation for the metric overlay cards, so two of them stacked
 * read as one instrument rather than two unrelated boxes.
 *
 * Kept out of the component file because a module that exports both components
 * and plain values breaks Vite's fast refresh.
 */

/** Header cell: both the column headings and the row labels down the side. */
export const metricHeaderCellSx = {
  px: 0.75,
  py: 0.25,
  fontWeight: 600,
  whiteSpace: 'nowrap',
} as const;

/** Value cell: right-aligned so digits line up down a column. */
export const metricValueCellSx = {
  px: 0.75,
  py: 0.25,
  textAlign: 'right',
  fontVariantNumeric: 'tabular-nums',
} as const;

/**
 * Render a measurement in whole milliseconds, or an em dash when there is no
 * usable value yet (0 or non-finite).
 */
export function formatMs(valueMs: number): string {
  if (!Number.isFinite(valueMs) || valueMs <= 0) return '—';
  return Math.round(valueMs).toString();
}
