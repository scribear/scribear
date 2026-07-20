import type { Static } from 'typebox';
import { Value } from 'typebox/value';

import type { BaseLogger } from '@scribear/base-fastify-server';

import type {
  Counter,
  Gauge,
  Labels,
} from '#src/server/shared/metrics/metric-types.js';
import type { MetricsRegistry } from '#src/server/shared/metrics/metrics-registry.service.js';
import {
  AbsoluteStatusPoller,
  type AbsoluteStatusPollerConfig,
} from '#src/server/shared/status-poll/absolute-status-poller.js';
import { TRANSCRIPTION_METRICS_BODY_SCHEMA } from '#src/server/shared/transcription-metrics/transcription-metrics.schema.js';

type TranscriptionMetricsBody = Static<
  typeof TRANSCRIPTION_METRICS_BODY_SCHEMA
>;
type CounterSeries = TranscriptionMetricsBody['counters']['jobsCompletedTotal'];
type HistogramSeries = TranscriptionMetricsBody['histograms']['asrRtf'];

export interface TranscriptionMetricsPollerConfig extends AbsoluteStatusPollerConfig {
  /**
   * `job_period_ms` from the provider config, the denominator of the
   * period-utilization ratio. Zero disables that derived series.
   */
  jobPeriodMs: number;
}

/**
 * Quantiles republished as gauges. The endpoint reports pre-computed
 * percentiles over its own retained ring rather than raw samples, so the
 * sidecar cannot rebuild a histogram from them — observing a p95 into a local
 * histogram would produce a distribution of percentiles, which means nothing.
 * These are exported as a `quantile`-labelled gauge instead, which is the
 * Prometheus summary idiom and says exactly what the value is.
 */
const QUANTILES = ['p50', 'p95', 'p99', 'max'] as const;

/** Provider label on the Python side; `unknown` when the job reported none. */
const PROVIDER_LABEL = 'provider_key';

/**
 * Folds transcription-service's `GET /metrics/status` into the registry (B1.2).
 *
 * **What this retires.** Five log parsers, and with them the last inference of
 * transcription behaviour from log text: buffer overflows, audio-too-fast
 * rejections, no-speech buffers, SAFP decode drops and job timings. Three of
 * those counters were incremented *inside a spawned worker process*, so the
 * only reason they were ever visible was that the worker logged them; B1.2 PR 4
 * gave them a real transport back to the parent.
 *
 * **True RTF at last.** `asrRtf` is wall-clock execution time over seconds of
 * audio ingested, measured by the service itself. It replaces the sidecar's
 * period-utilization proxy in the T1 saturation rule. Period utilization is
 * still derived here as a secondary series — it is the answer to the adjacent
 * question "is a job finishing within the cadence that schedules it?" — but it
 * is now computed from the reported execution quantiles rather than from a log
 * line, so it survives the parser removal.
 */
export class TranscriptionMetricsPollerService extends AbsoluteStatusPoller<TranscriptionMetricsBody> {
  private _jobPeriodMs: number;
  /** Workers seen in the previous poll, so vanished ones can be removed. */
  private _knownWorkers = new Set<string>();
  /** Providers with live quantile series, so stale ones can be removed. */
  private _knownProviders = new Set<string>();

  constructor(
    transcriptionMetricsPollerConfig: TranscriptionMetricsPollerConfig,
    metricsRegistry: MetricsRegistry,
    logger: BaseLogger,
  ) {
    super(transcriptionMetricsPollerConfig, metricsRegistry, logger);
    this._jobPeriodMs = transcriptionMetricsPollerConfig.jobPeriodMs;
  }

  protected _parseBody(parsed: unknown): TranscriptionMetricsBody | null {
    return Value.Check(TRANSCRIPTION_METRICS_BODY_SCHEMA, parsed)
      ? parsed
      : null;
  }

  protected readonly _disabledWarning =
    'transcription-service metrics polling disabled: TRANSCRIPTION_SERVICE_METRICS_KEY is unset. Job timings, RTF and the buffer-overflow counters will be empty.';

  protected _apply(body: TranscriptionMetricsBody): void {
    this._applyCounters(body);
    this._applyWorkerGauges(body);
    this._applyQuantileGauges(body);
  }

  private _applyCounters(body: TranscriptionMetricsBody): void {
    const service = this._config.service;
    const c = body.counters;

    // Straight per-provider counters.
    this._foldProvider(
      c.jobsCompletedTotal,
      this._metrics.asrJobsCompletedTotal,
    );
    this._foldProvider(
      c.asrAudioSecondsTotal,
      this._metrics.asrAudioSecondsTotal,
    );
    this._foldProvider(
      c.bufferOverflowTotal,
      this._metrics.asrBufferOverflowTotal,
    );
    this._foldProvider(
      c.bufferOverflowSecondsTotal,
      this._metrics.asrBufferOverflowSecondsTotal,
    );
    this._foldProvider(c.audioTooFastTotal, this._metrics.asrAudioTooFastTotal);

    // `reason` is the exception class name, a closed set by construction.
    for (const series of c.jobsFailedTotal) {
      this._advance(
        this._metrics.asrJobsFailedTotal,
        {
          service,
          providerKey: providerOf(series.labels),
          reason: series.labels['reason'] ?? 'unknown',
        },
        series.value,
      );
    }

    // Two endpoint counters, one sidecar metric distinguished by `kind` — the
    // same shape the retired log parser produced, so no rule had to change.
    for (const series of c.vadNoSpeechTotal) {
      this._advance(
        this._metrics.asrNoSpeechTotal,
        {
          service,
          providerKey: providerOf(series.labels),
          kind: 'vad_no_speech',
        },
        series.value,
      );
    }
    for (const series of c.noWordsTotal) {
      this._advance(
        this._metrics.asrNoSpeechTotal,
        { service, providerKey: providerOf(series.labels), kind: 'no_words' },
        series.value,
      );
    }

    // Shares `scribear_safp_decode_drops_total` with node-server, separated by
    // `side`. This is the series the Python log parser used to write.
    for (const series of c.decodeDropsTotal) {
      this._advance(
        this._metrics.safpDecodeDropsTotal,
        { service, side: 'transcription' },
        series.value,
      );
    }
  }

  private _foldProvider(series: CounterSeries, counter: Counter): void {
    const service = this._config.service;
    for (const entry of series) {
      this._advance(
        counter,
        { service, providerKey: providerOf(entry.labels) },
        entry.value,
      );
    }
  }

  private _applyWorkerGauges(body: TranscriptionMetricsBody): void {
    const service = this._config.service;
    // Answers one of the two inputs the master plan has carried since the
    // first session: how many worker processes this deployment actually runs.
    this._metrics.asrWorkers.set({ service }, body.numWorkers);

    const seen = new Set<string>();
    for (const worker of body.workers) {
      const workerId = String(worker.workerId);
      const labels = { service, workerId };
      seen.add(workerId);
      this._metrics.asrWorkerUtilization.set(labels, worker.utilization);
      this._metrics.asrWorkerLiveJobs.set(labels, worker.liveJobCount);
      this._metrics.asrWorkerContexts.set(labels, worker.contextIds.length);
      this._metrics.asrWorkerAlive.set(labels, worker.alive ? 1 : 0);
      this._advance(
        this._metrics.asrWorkerJobsRegisteredTotal,
        labels,
        worker.totalJobsRegistered,
      );
    }

    for (const workerId of this._knownWorkers) {
      if (seen.has(workerId)) continue;
      const labels = { service, workerId };
      this._metrics.asrWorkerUtilization.delete(labels);
      this._metrics.asrWorkerLiveJobs.delete(labels);
      this._metrics.asrWorkerContexts.delete(labels);
      this._metrics.asrWorkerAlive.delete(labels);
    }
    this._knownWorkers = seen;
  }

  private _applyQuantileGauges(body: TranscriptionMetricsBody): void {
    const h = body.histograms;
    const seen = new Set<string>();

    this._setQuantiles(
      h.asrSchedulingDelayMs,
      this._metrics.asrSchedulingDelayMs,
      seen,
    );
    this._setQuantiles(h.asrExecutionMs, this._metrics.asrExecutionMs, seen);
    this._setQuantiles(h.asrTotalMs, this._metrics.asrTotalMs, seen);
    this._setQuantiles(h.asrRtf, this._metrics.asrRtf, seen);

    // Derived, not reported: execution time against the cadence that schedules
    // it. Saturates at the same 1.0 line as RTF but answers a different
    // question, so it is kept alongside rather than replaced by it.
    if (this._jobPeriodMs > 0) {
      for (const series of h.asrExecutionMs) {
        if (series.sampleCount === 0) continue;
        const providerKey = providerOf(series.labels);
        for (const quantile of QUANTILES) {
          this._metrics.asrPeriodUtilization.set(
            { service: this._config.service, providerKey, quantile },
            series[quantile] / this._jobPeriodMs,
          );
        }
      }
    }

    // A provider whose ring emptied stops being reported entirely, and a stale
    // p95 left behind would keep a saturation alert firing after the load
    // stopped.
    for (const providerKey of this._knownProviders) {
      if (seen.has(providerKey)) continue;
      for (const quantile of QUANTILES) {
        const labels = {
          service: this._config.service,
          providerKey,
          quantile,
        };
        this._metrics.asrSchedulingDelayMs.delete(labels);
        this._metrics.asrExecutionMs.delete(labels);
        this._metrics.asrTotalMs.delete(labels);
        this._metrics.asrRtf.delete(labels);
        this._metrics.asrPeriodUtilization.delete(labels);
      }
    }
    this._knownProviders = seen;
  }

  private _setQuantiles(
    series: HistogramSeries,
    gauge: Gauge,
    seen: Set<string>,
  ): void {
    const service = this._config.service;
    for (const entry of series) {
      // A series with no retained samples carries meaningless zeroes.
      if (entry.sampleCount === 0) continue;
      const providerKey = providerOf(entry.labels);
      seen.add(providerKey);
      for (const quantile of QUANTILES) {
        gauge.set({ service, providerKey, quantile }, entry[quantile]);
      }
    }
  }
}

/** snake_case on the wire, camelCase in the registry. */
function providerOf(labels: Labels): string {
  return labels[PROVIDER_LABEL] ?? 'unknown';
}
