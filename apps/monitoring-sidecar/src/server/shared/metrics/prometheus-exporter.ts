import type { Labels } from '#src/server/shared/metrics/metric-types.js';
import type { MetricsRegistry } from '#src/server/shared/metrics/metrics-registry.service.js';

/** Content type required by Prometheus scrapers for the text exposition format. */
export const PROMETHEUS_CONTENT_TYPE =
  'text/plain; version=0.0.4; charset=utf-8';

/**
 * Escapes a label value per the Prometheus exposition format: backslash, double
 * quote, and newline must be escaped.
 *
 * This matters more than it looks — WebSocket close reasons flow straight into
 * a label, and an unescaped quote would produce a scrape-breaking line.
 */
function escapeLabelValue(value: string): string {
  return value
    .replaceAll('\\', '\\\\')
    .replaceAll('"', '\\"')
    .replaceAll('\n', '\\n');
}

function renderLabels(labels: Labels, extra?: Labels): string {
  const merged = { ...labels, ...extra };
  const entries = Object.entries(merged);
  if (entries.length === 0) return '';
  const rendered = entries
    .map(([k, v]) => `${k}="${escapeLabelValue(v)}"`)
    .join(',');
  return `{${rendered}}`;
}

/**
 * Renders the registry in the Prometheus text exposition format.
 *
 * The deployment does not currently run Prometheus — the user opted out of
 * Grafana — but this endpoint costs almost nothing to maintain and keeps the
 * option of scraping into existing IT monitoring open without a rewrite.
 */
export function renderPrometheus(metrics: MetricsRegistry): string {
  const lines: string[] = [];

  for (const counter of metrics.counters()) {
    lines.push(`# HELP ${counter.name} ${counter.help}`);
    lines.push(`# TYPE ${counter.name} counter`);
    for (const { labels, value } of counter.entries()) {
      lines.push(`${counter.name}${renderLabels(labels)} ${String(value)}`);
    }
  }

  for (const gauge of metrics.gauges()) {
    lines.push(`# HELP ${gauge.name} ${gauge.help}`);
    lines.push(`# TYPE ${gauge.name} gauge`);
    for (const { labels, value } of gauge.entries()) {
      lines.push(`${gauge.name}${renderLabels(labels)} ${String(value)}`);
    }
  }

  for (const histogram of metrics.histograms()) {
    lines.push(`# HELP ${histogram.name} ${histogram.help}`);
    lines.push(`# TYPE ${histogram.name} histogram`);
    for (const labels of histogram.seriesLabels()) {
      for (const { le, count } of histogram.bucketCounts(labels)) {
        lines.push(
          `${histogram.name}_bucket${renderLabels(labels, { le: String(le) })} ${String(count)}`,
        );
      }
      // The +Inf bucket is mandatory and must equal the observation count.
      lines.push(
        `${histogram.name}_bucket${renderLabels(labels, { le: '+Inf' })} ${String(histogram.count(labels))}`,
      );
      lines.push(
        `${histogram.name}_sum${renderLabels(labels)} ${String(histogram.sum(labels))}`,
      );
      lines.push(
        `${histogram.name}_count${renderLabels(labels)} ${String(histogram.count(labels))}`,
      );
    }
  }

  // The exposition format requires a trailing newline.
  return lines.join('\n') + '\n';
}
