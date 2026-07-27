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
 * differenced. The remaining fields describe only the retained sample ring
 * (4096 deep) and are therefore gauges of recent behaviour, not of all time.
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
   * `job_period_ms` per provider key — **the only optional field here, and the
   * only one transcription-service does not send today.**
   *
   * Every other field is required precisely so that drift fails loudly (see
   * above), and this one breaks that rule knowingly. It is the denominator of
   * the derived `scribear_asr_period_utilization` series, which the sidecar
   * currently has to be *told* through `TRANSCRIPTION_JOB_PERIOD_MS` because the
   * value lives in transcription-service's `provider_config.json` and is
   * reported on no surface the sidecar can poll — not here, not on
   * `GET /providers/health`, not on the Redis fleet plane. Two unrelated files
   * therefore state the same number, and when they disagree the series is
   * silently misscaled.
   *
   * Declaring it optional now means the fix is consumer-ready: the moment
   * `metrics_controller.py` adds `"providerJobPeriodMs": {"whisper": 500, ...}`
   * (sourced from each provider's own config, so per-provider variation is
   * preserved), this poller prefers it over anything configured locally and the
   * env var can be deleted with no further sidecar change. Optional rather than
   * required so that landing the two sides in either order never turns a healthy
   * poll into a `malformed` one — the strictness argument above applies to
   * fields the service already sends, not to one it is about to gain.
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
  }),
  histograms: Type.Object({
    asrSchedulingDelayMs: Type.Array(HISTOGRAM_SERIES),
    asrExecutionMs: Type.Array(HISTOGRAM_SERIES),
    asrTotalMs: Type.Array(HISTOGRAM_SERIES),
    asrRtf: Type.Array(HISTOGRAM_SERIES),
  }),
});
