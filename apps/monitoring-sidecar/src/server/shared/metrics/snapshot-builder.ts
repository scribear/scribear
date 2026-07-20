import type { Alert } from '#src/server/shared/alerts/alert-rules.js';
import type { CanaryRunResult } from '#src/server/shared/canary/canary-types.js';
import type { HistogramSummary } from '#src/server/shared/metrics/metric-types.js';
import type { MetricsRegistry } from '#src/server/shared/metrics/metrics-registry.service.js';
import type { ProbeStatus } from '#src/server/shared/probes/probe-poller.service.js';

/** A counter series flattened for JSON transport. */
export interface CounterSeries {
  labels: Record<string, string>;
  value: number;
  /** Increments within the snapshot's rate window. */
  windowValue: number;
}

/** A histogram series with computed percentiles. */
export interface HistogramSeries {
  labels: Record<string, string>;
  summary: HistogramSummary;
}

/** The full snapshot returned to the admin SPA. */
export interface MetricsSnapshot {
  /** When this snapshot was built, epoch ms. */
  generatedAtMs: number;
  /** Window used for every `windowValue` and for rate-based alerts, ms. */
  rateWindowMs: number;
  /** Firing alerts, worst-first. */
  alerts: Alert[];
  /** Probe status matrix (A3). */
  probes: ProbeStatus[];
  /** Log-derived counters, keyed by metric name. */
  counters: Record<string, CounterSeries[]>;
  /** Log-derived histograms with percentiles, keyed by metric name. */
  histograms: Record<string, HistogramSeries[]>;
  /** Ingest self-observability — is the collector actually seeing anything? */
  ingest: IngestHealth;
  /**
   * Most recent synthetic canary probe (A2), or null when the canary is
   * disabled or has not completed a run yet. This is the only field in the
   * snapshot derived from actively exercising the pipeline rather than
   * observing it.
   */
  canary: CanaryRunResult | null;
}

/**
 * The collector's view of itself.
 *
 * Without this a silent sidecar is indistinguishable from a healthy system:
 * zero errors could mean "nothing is wrong" or "no logs are reaching me". A
 * high `unparsed` share specifically indicates log-message drift in a monitored
 * service — the parsers key on literal strings those services don't know exist.
 */
export interface IngestHealth {
  parsedTotal: number;
  unparsedTotal: number;
  malformedTotal: number;
  /** Fraction of decodable lines that no parser claimed. */
  unparsedRatio: number;
}

/**
 * Builds the JSON snapshot consumed by the admin SPA.
 *
 * Shaped for direct rendering rather than as a raw metric dump: percentiles are
 * pre-computed, window counts sit beside lifetime totals, and alerts arrive
 * pre-sorted, so the SPA does no metric maths of its own.
 */
export function buildSnapshot(
  metrics: MetricsRegistry,
  probes: ProbeStatus[],
  alerts: Alert[],
  canary: CanaryRunResult | null,
  rateWindowMs: number,
  nowMs: number = Date.now(),
): MetricsSnapshot {
  const counters: Record<string, CounterSeries[]> = {};
  for (const counter of metrics.counters()) {
    counters[counter.name] = counter.entries().map(({ labels, value }) => ({
      labels: { ...labels },
      value,
      windowValue: counter.windowCount(labels, rateWindowMs, nowMs),
    }));
  }

  const histograms: Record<string, HistogramSeries[]> = {};
  for (const histogram of metrics.histograms()) {
    const series: HistogramSeries[] = [];
    for (const labels of histogram.seriesLabels()) {
      const summary = histogram.summary(labels);
      if (summary === undefined) continue;
      series.push({ labels: { ...labels }, summary });
    }
    histograms[histogram.name] = series;
  }

  const parsedTotal = metrics.logLinesParsedTotal.total();
  const unparsedTotal = metrics.logLinesUnparsedTotal.total();
  const malformedTotal = metrics.logLinesMalformedTotal.total();
  const decodable = parsedTotal + unparsedTotal;

  return {
    generatedAtMs: nowMs,
    rateWindowMs,
    alerts,
    probes,
    counters,
    histograms,
    canary,
    ingest: {
      parsedTotal,
      unparsedTotal,
      malformedTotal,
      unparsedRatio: decodable === 0 ? 0 : unparsedTotal / decodable,
    },
  };
}
