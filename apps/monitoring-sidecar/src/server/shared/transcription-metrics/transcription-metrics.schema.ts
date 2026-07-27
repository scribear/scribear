import { Type } from 'typebox';

/**
 * The 200 body of transcription-service's `GET /metrics/status` (B1.2).
 *
 * Restated here rather than imported, because transcription-service is Python
 * and shares no schema package with the Node apps — the counterpart to
 * node-server's `STATUS_SCHEMA`, which the node poller imports directly. The
 * source of truth is
 * `transcription_service/src/webserver/features/metrics/metrics_controller.py`;
 * that route returns a bare dict with no `response_model`, so nothing enforces
 * agreement at build time on either side. A mismatch surfaces at runtime as a
 * `malformed` poll error rather than as half-populated metrics, which is why
 * every field below is required.
 *
 * Label keys inside `labels` are snake_case (`provider_key`) even though the
 * envelope is camelCase; that asymmetry is the Python side's, and this schema
 * mirrors it faithfully rather than papering over it.
 */

const COUNTER_SERIES = Type.Object({
  labels: Type.Record(Type.String(), Type.String()),
  value: Type.Number(),
});

/**
 * `count` and `sum` are lifetime totals and behave like counters, so they are
 * differenced. The remaining fields describe only the retained sample ring —
 * bounded by **age** (120 s by default) as well as depth (4096) — and are
 * therefore gauges of recent behaviour, not of all time.
 *
 * A consequence worth stating, because it looks like a bug: `sampleCount` can
 * legitimately be **0 while `count` and `sum` are large**. That is an idle
 * provider whose window has emptied, not a broken series, and it is what lets a
 * gauge-derived alert clear on its own — before the ring expired by age, one
 * heavy session left `asrRtf{quantile=p95}` reporting the same figure forever.
 */
const HISTOGRAM_SERIES = Type.Object({
  labels: Type.Record(Type.String(), Type.String()),
  count: Type.Number(),
  sum: Type.Number(),
  sampleCount: Type.Number(),
  min: Type.Number(),
  max: Type.Number(),
  mean: Type.Number(),
  p50: Type.Number(),
  p95: Type.Number(),
  p99: Type.Number(),
});

export const TRANSCRIPTION_METRICS_BODY_SCHEMA = Type.Object({
  processUid: Type.String(),
  processStartedAt: Type.String(),
  numWorkers: Type.Number(),
  providerKeys: Type.Array(Type.String()),
  /**
   * `job_period_ms` per provider key. Optional, like
   * `counters.asrDroppedPeriodsTotal` below and unlike everything else here.
   *
   * Every other field is required precisely so that drift fails loudly (see
   * above), and this one breaks that rule knowingly. It is the denominator of
   * the derived `scribear_asr_period_utilization` series, which the sidecar used
   * to have to be *told* through `TRANSCRIPTION_JOB_PERIOD_MS` because the value
   * lives in transcription-service's `provider_config.json` and was reported on
   * no surface the sidecar can poll — not here, not on `GET /providers/health`,
   * not on the Redis fleet plane. Two unrelated files therefore stated the same
   * number, and when they disagreed the series was silently misscaled.
   *
   * **transcription-service now sends it**, sourced from each provider itself
   * (`TranscriptionProviderInterface.job_period_ms`) rather than from a `getattr`
   * on its config, because the field is not universal: `debug`'s period is a
   * literal in `debug_provider.py`. A provider that cannot state one is omitted
   * from the map rather than given a placeholder, so the poller's "no period
   * known, publish nothing" path still means what it says. This poller prefers a
   * reported period over anything configured locally, so
   * `TRANSCRIPTION_JOB_PERIOD_MS` is now only a fallback for a service too old to
   * send this.
   *
   * Still optional, not required: it is precisely during the rolling upgrade
   * where one side is older that the field is missing, and turning that into a
   * `malformed` poll would take every transcription metric down to enforce a
   * field the sidecar has a fallback for.
   */
  providerJobPeriodMs: Type.Optional(Type.Record(Type.String(), Type.Number())),
  workers: Type.Array(
    Type.Object({
      workerId: Type.Number(),
      utilization: Type.Number(),
      liveJobCount: Type.Number(),
      totalJobsRegistered: Type.Number(),
      contextIds: Type.Array(Type.Number()),
      alive: Type.Boolean(),
    }),
  ),
  counters: Type.Object({
    jobsCompletedTotal: Type.Array(COUNTER_SERIES),
    jobsFailedTotal: Type.Array(COUNTER_SERIES),
    asrAudioSecondsTotal: Type.Array(COUNTER_SERIES),
    bufferOverflowTotal: Type.Array(COUNTER_SERIES),
    bufferOverflowSecondsTotal: Type.Array(COUNTER_SERIES),
    audioTooFastTotal: Type.Array(COUNTER_SERIES),
    vadNoSpeechTotal: Type.Array(COUNTER_SERIES),
    noWordsTotal: Type.Array(COUNTER_SERIES),
    decodeDropsTotal: Type.Array(COUNTER_SERIES),
    /**
     * Job periods in which a job never ran, because the pass before it overran.
     *
     * The exact count of the failure the T1 rules are all circling: the worker
     * pool neither queues nor errors when a pass exceeds `job_period_ms`, it
     * advances the job's `period_start_ns` by whole periods until it passes now
     * (`worker_process.py`), so the missed periods are dropped and the effective
     * period silently becomes a multiple of the configured one.
     *
     * Optional for the same reason as `providerJobPeriodMs`: a
     * transcription-service predating it does not send it, and during a rolling
     * upgrade the sidecar polls exactly that service. `transcriptionTailOverrunRule`
     * falls back to the reported p99 RTF when it is absent — see
     * {@link MetricsRegistry.asrDroppedPeriodsSupported}, which is how the rule
     * tells "not reported" from "reported as zero". Making this required instead
     * would turn a mixed-version deployment's every transcription metric into a
     * `malformed` poll to enforce a field with a working fallback.
     */
    asrDroppedPeriodsTotal: Type.Optional(Type.Array(COUNTER_SERIES)),
  }),
  histograms: Type.Object({
    asrSchedulingDelayMs: Type.Array(HISTOGRAM_SERIES),
    asrExecutionMs: Type.Array(HISTOGRAM_SERIES),
    asrTotalMs: Type.Array(HISTOGRAM_SERIES),
    asrRtf: Type.Array(HISTOGRAM_SERIES),
  }),
});
