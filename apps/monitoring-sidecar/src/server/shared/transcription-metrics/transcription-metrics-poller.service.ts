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
   * `job_period_ms` per provider key, the denominator of the period-utilization
   * ratio, parsed from `TRANSCRIPTION_JOB_PERIOD_MS`.
   *
   * Per provider rather than a single number because the field is per provider
   * in transcription-service's `provider_config.json` and the shipped templates
   * really do differ (CUDA: whisper 500 ms, lumen_granite 3000 ms). A provider
   * missing from this map — and not reported by the service either — publishes
   * no period-utilization series. See `job-period-config.ts` for the format and
   * for why a bare number is rejected.
   */
  jobPeriodMsByProvider: ReadonlyMap<string, number>;
  /**
   * Problems found parsing that variable, logged once at construction. Passed in
   * rather than logged by the config layer, which has no logger and is
   * deliberately free of side effects.
   */
  jobPeriodSpecErrors: readonly string[];
}

/** Where a job period came from; becomes the `source` label. */
const PERIOD_SOURCE = {
  /** transcription-service sent it on `/metrics/status`. */
  REPORTED: 'reported',
  /** `TRANSCRIPTION_JOB_PERIOD_MS` said so. */
  CONFIGURED: 'configured',
} as const;

/** A job period with its provenance. */
interface JobPeriod {
  ms: number;
  source: string;
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
 *
 * **The cadence is now reported, not configured.** `job_period_ms` is
 * per-provider config inside transcription-service, and for a long time it was on
 * no surface the sidecar could poll, so it had to be restated in
 * `TRANSCRIPTION_JOB_PERIOD_MS` and the two agreed only by luck. The service
 * sends `providerJobPeriodMs` now; the denominator is resolved per provider from
 * that in preference to local config, falls back to the env var for a service too
 * old to send it, and where neither exists the series is not published at all.
 * See {@link _applyPeriodUtilization}.
 *
 * The same reported-then-configured shape applies to the dropped-period counter,
 * for which the fallback is not another config value but a different metric
 * entirely — see `transcriptionTailOverrunRule`.
 */
export class TranscriptionMetricsPollerService extends AbsoluteStatusPoller<TranscriptionMetricsBody> {
  private readonly _configuredPeriods: ReadonlyMap<string, number>;
  /** Workers seen in the previous poll, so vanished ones can be removed. */
  private _knownWorkers = new Set<string>();
  /** Providers with live quantile series, so stale ones can be removed. */
  private _knownProviders = new Set<string>();
  /**
   * `source` label currently published per provider, so a provider whose period
   * starts being reported does not leave a duplicate `configured` series behind.
   */
  private _publishedPeriodSource = new Map<string, string>();
  /**
   * Providers already warned about, so a missing period is said once rather than
   * every interval forever — the same transition-only logging the base class
   * applies to poll failures.
   */
  private _warnedUnknownPeriod = new Set<string>();

  constructor(
    transcriptionMetricsPollerConfig: TranscriptionMetricsPollerConfig,
    metricsRegistry: MetricsRegistry,
    logger: BaseLogger,
  ) {
    super(transcriptionMetricsPollerConfig, metricsRegistry, logger);
    this._configuredPeriods =
      transcriptionMetricsPollerConfig.jobPeriodMsByProvider;

    // Logged at error level, not warn: this is a config value that cannot be
    // used at all, and the consequence (one series missing) is invisible on the
    // dashboard by design.
    for (const message of transcriptionMetricsPollerConfig.jobPeriodSpecErrors) {
      this._logger.error(
        { service: transcriptionMetricsPollerConfig.service },
        `${message}. scribear_asr_period_utilization will not be published for the affected providers; scribear_asr_rtf and the duty-ratio alert are unaffected, since transcription-service measures those itself.`,
      );
    }
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
    this._applyRtfTotals(body);
    this._applyWorkerGauges(body);
    this._applyQuantileGauges(body);
  }

  /**
   * Folds the RTF histogram's lifetime `sum` and `count` into counters.
   *
   * Both fields have been on the wire since B1.2 and the schema comment beside
   * them already says they "behave like counters, so they are differenced" —
   * nothing differenced them until the T1 early-warning rule needed a *mean*
   * RTF over the sidecar's own alert window. The quantile gauges below cannot
   * supply one: a pre-computed percentile is not re-averageable, and it is
   * taken over a ring that never expires by time, so it stays high after the
   * load that produced it has gone. A differenced total does both correctly.
   *
   * Deliberately *not* gated on `sampleCount`, unlike the gauges. An empty ring
   * makes a percentile meaningless, but says nothing about the lifetime totals,
   * and skipping the fold would drop that poll's delta permanently.
   */
  private _applyRtfTotals(body: TranscriptionMetricsBody): void {
    const service = this._config.service;
    for (const series of body.histograms.asrRtf) {
      const labels = { service, providerKey: providerOf(series.labels) };
      this._advance(this._metrics.asrDutyRatioSumTotal, labels, series.sum);
      this._advance(this._metrics.asrDutyRatioJobsTotal, labels, series.count);
    }
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
    // Optional on the wire (renamed from `audioTooFastTotal`), so a service
    // predating the rename simply reports no drops rather than failing the
    // whole poll. Nothing here needs to tell "not reported" from "zero" —
    // unlike dropped periods, no rule falls back to a different signal.
    if (c.audioDroppedBufferFullTotal !== undefined) {
      this._foldProvider(
        c.audioDroppedBufferFullTotal,
        this._metrics.asrAudioDroppedBufferFullTotal,
      );
    }
    if (c.audioDroppedBufferFullSecondsTotal !== undefined) {
      this._foldProvider(
        c.audioDroppedBufferFullSecondsTotal,
        this._metrics.asrAudioDroppedBufferFullSecondsTotal,
      );
    }

    // Optional on the wire (the reconnect-loop fix predates these on older
    // transcription-service builds), so a service too old to send them simply
    // reports no drops rather than failing the whole poll — same shape as the
    // buffer-full pair above, and for the same reason.
    if (c.binaryDroppedBeforeAuthTotal !== undefined) {
      this._foldProvider(
        c.binaryDroppedBeforeAuthTotal,
        this._metrics.asrBinaryDroppedBeforeAuthTotal,
      );
    }
    if (c.binaryDroppedBeforeConfigTotal !== undefined) {
      this._foldProvider(
        c.binaryDroppedBeforeConfigTotal,
        this._metrics.asrBinaryDroppedBeforeConfigTotal,
      );
    }

    // Dropped periods, and whether they are being reported at all.
    //
    // The support gauge is not redundant with the counter. A healthy service
    // sends an empty array, and `_advance` writes nothing for a zero delta, so
    // "no dropped-period series" means either "nothing was dropped" or "nothing
    // is counting" — and `transcriptionTailOverrunRule` must do opposite things
    // in those two cases (trust the zero, or fall back to the p99 RTF gauge).
    // Same "prefer reported, fall back, and publish which" pattern as
    // `asrJobPeriodMs` above.
    const droppedPeriods = c.asrDroppedPeriodsTotal;
    this._metrics.asrDroppedPeriodsSupported.set(
      { service },
      droppedPeriods === undefined ? 0 : 1,
    );
    if (droppedPeriods !== undefined) {
      this._foldProvider(droppedPeriods, this._metrics.asrDroppedPeriodsTotal);
    }

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

    this._applyPeriodUtilization(body);

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
      this._forgetJobPeriod(providerKey);
    }
    this._knownProviders = seen;
  }

  /**
   * Derived, not reported: execution time against the cadence that schedules it.
   * Saturates at the same 1.0 line as RTF but answers a different question, so it
   * is kept alongside rather than replaced by it.
   *
   * **The denominator is resolved per provider**, because `job_period_ms` is a
   * per-provider field and a deployment can serve whisper at 500 ms and
   * lumen_granite at 3000 ms at the same time. Scaling both by one global number
   * — which is what this did until now — publishes a ratio that is wrong by that
   * factor for at least one of them, with nothing to indicate it.
   *
   * A provider with no known period publishes **nothing**, and any series it
   * previously had is deleted rather than left to freeze. The rejected
   * alternatives were both worse: falling back to a default is the original bug,
   * and holding the last good value would keep asserting a utilization for a
   * provider whose denominator the sidecar just lost.
   *
   * Not raised as an alert. `asrPeriodUtilization` is deliberately not alerted on
   * at all (see `transcriptionSaturationRule`) — T1 is owned by true RTF and the
   * duty-ratio counters, neither of which depends on the job period — so an alert
   * about this series' *denominator* would fire on config hygiene while nothing
   * consumes the series it protects. The published period, the missing series and
   * a once-per-provider log are the visibility; an operator's next action is to
   * edit config either way.
   */
  private _applyPeriodUtilization(body: TranscriptionMetricsBody): void {
    const periods = this._resolvePeriods(body);
    const service = this._config.service;

    for (const series of body.histograms.asrExecutionMs) {
      if (series.sampleCount === 0) continue;
      const providerKey = providerOf(series.labels);
      const period = periods.get(providerKey);

      if (period === undefined) {
        this._suppressPeriodUtilization(providerKey);
        continue;
      }

      this._publishJobPeriod(providerKey, period);
      for (const quantile of QUANTILES) {
        this._metrics.asrPeriodUtilization.set(
          { service, providerKey, quantile },
          series[quantile] / period.ms,
        );
      }
    }
  }

  /**
   * Job period per provider for this poll, reported values winning.
   *
   * The precedence is the point: a period transcription-service reports is the
   * one it is actually scheduling with, while a configured one is a number
   * hand-copied out of `provider_config.json` into the sidecar's environment by
   * someone who may since have changed one and not the other. When the service
   * starts sending `providerJobPeriodMs`, every provider it names stops depending
   * on local config without anyone having to remove the variable first.
   */
  private _resolvePeriods(
    body: TranscriptionMetricsBody,
  ): Map<string, JobPeriod> {
    const resolved = new Map<string, JobPeriod>();
    for (const [providerKey, ms] of this._configuredPeriods) {
      resolved.set(providerKey, { ms, source: PERIOD_SOURCE.CONFIGURED });
    }
    for (const [providerKey, ms] of Object.entries(
      body.providerJobPeriodMs ?? {},
    )) {
      // A non-positive period is not a cadence, and dividing by it would give
      // Infinity — treated as "not reported" so a configured value can still
      // stand in.
      if (!Number.isFinite(ms) || ms <= 0) continue;
      resolved.set(providerKey, { ms, source: PERIOD_SOURCE.REPORTED });
    }
    return resolved;
  }

  private _publishJobPeriod(providerKey: string, period: JobPeriod): void {
    const service = this._config.service;
    const previous = this._publishedPeriodSource.get(providerKey);
    if (previous !== undefined && previous !== period.source) {
      this._metrics.asrJobPeriodMs.delete({
        service,
        providerKey,
        source: previous,
      });
    }
    this._metrics.asrJobPeriodMs.set(
      { service, providerKey, source: period.source },
      period.ms,
    );
    this._publishedPeriodSource.set(providerKey, period.source);
    // A provider that regains a period should warn again if it loses one later.
    this._warnedUnknownPeriod.delete(providerKey);
  }

  private _forgetJobPeriod(providerKey: string): void {
    const source = this._publishedPeriodSource.get(providerKey);
    if (source === undefined) return;
    this._metrics.asrJobPeriodMs.delete({
      service: this._config.service,
      providerKey,
      source,
    });
    this._publishedPeriodSource.delete(providerKey);
  }

  /**
   * Drops the utilization series for a provider whose period is unknown, and says
   * so once.
   *
   * The delete matters as much as the skip: without it, a provider that was being
   * scaled by a configured period and then lost it (a reported period going
   * non-positive, say) would keep serving its last ratio forever.
   */
  private _suppressPeriodUtilization(providerKey: string): void {
    const service = this._config.service;
    for (const quantile of QUANTILES) {
      this._metrics.asrPeriodUtilization.delete({
        service,
        providerKey,
        quantile,
      });
    }
    this._forgetJobPeriod(providerKey);

    if (this._warnedUnknownPeriod.has(providerKey)) return;
    this._warnedUnknownPeriod.add(providerKey);
    this._logger.warn(
      { service, providerKey },
      `no job period known for provider "${providerKey}", so scribear_asr_period_utilization is not published for it. Add "${providerKey}=<job_period_ms>" to TRANSCRIPTION_JOB_PERIOD_MS, matching that provider's job_period_ms in the deployed provider_config.json. scribear_asr_rtf and the T1 duty-ratio alert are unaffected — transcription-service measures those itself.`,
    );
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
