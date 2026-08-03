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

/** A gauge series flattened for JSON transport. */
export interface GaugeSeries {
  labels: Record<string, string>;
  value: number;
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
  /** Counters, keyed by metric name. */
  counters: Record<string, CounterSeries[]>;
  /**
   * Point-in-time gauges, keyed by metric name. Where a counter answers "how
   * often has this happened", these answer "what is true right now" - live
   * session counts, per-session upstream state, whether the status poll is
   * working. A session that ends disappears from here rather than freezing.
   */
  gauges: Record<string, GaugeSeries[]>;
  /** Histograms with percentiles, keyed by metric name. */
  histograms: Record<string, HistogramSeries[]>;
  /**
   * Most recent synthetic canary probe (A2), or null when the canary is
   * disabled or has not completed a run yet. This is the only field in the
   * snapshot derived from actively exercising the pipeline rather than
   * observing it.
   */
  canary: CanaryRunResult | null;
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

  const gauges: Record<string, GaugeSeries[]> = {};
  for (const gauge of metrics.gauges()) {
    gauges[gauge.name] = gauge.entries().map(({ labels, value }) => ({
      labels: { ...labels },
      value,
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

  return {
    generatedAtMs: nowMs,
    rateWindowMs,
    alerts,
    probes,
    counters,
    gauges,
    histograms,
    canary,
  };
}
