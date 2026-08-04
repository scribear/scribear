/**
 * Which diagnostic overlays the URL fragment asks for.
 *
 * Metrics overlays are developer/debug affordances, so they stay hidden unless
 * the reader explicitly opts in with `#metrics=<name>[,<name>...]` (or
 * `#metrics=all`). Parsing is deliberately tolerant: unknown names are ignored
 * rather than reported, so a link written for a future build still works on an
 * older one instead of failing the whole fragment.
 */

/** Every metric overlay that can be requested. Extend as more are added. */
export const METRIC_NAMES = ['latency'] as const;

export type MetricName = (typeof METRIC_NAMES)[number];

/** Fragment parameter carrying the comma-separated overlay list. */
const FRAGMENT_KEY = 'metrics';

/** Wildcard value selecting every known overlay. */
const ALL_METRICS = 'all';

/**
 * Parses the requested metric overlays out of a URL fragment.
 *
 * Read with `URLSearchParams` rather than a prefix match so `metrics` can sit
 * alongside other fragment parameters, and so the existing `#config=<base64>`
 * fragment (consumed by the url-config middleware) parses to no metrics rather
 * than tripping over its base64 padding.
 *
 * @param hash - The fragment, with or without its leading `#`.
 * @returns The known overlays requested; empty when none were.
 */
export function parseMetricsFragment(hash: string): ReadonlySet<MetricName> {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  const raw = params.get(FRAGMENT_KEY);
  if (raw === null) return new Set();

  const requested = new Set(
    raw
      .split(',')
      .map((name) => name.trim().toLowerCase())
      .filter((name) => name.length > 0),
  );

  if (requested.has(ALL_METRICS)) return new Set(METRIC_NAMES);
  return new Set(METRIC_NAMES.filter((name) => requested.has(name)));
}
