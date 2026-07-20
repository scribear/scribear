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
  workers: Type.Array(
    Type.Object({
      workerId: Type.Number(),
      utilization: Type.Number(),
      liveJobCount: Type.Number(),
      totalJobsRegistered: Type.Number(),
      contextIds: Type.Array(Type.Number()),
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
