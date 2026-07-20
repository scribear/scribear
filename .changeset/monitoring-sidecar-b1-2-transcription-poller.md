---
'@scribear/monitoring-sidecar': minor
---

Source transcription-service telemetry from `GET /metrics/status` instead of log text (B1.2 PR 5).

`NodeStatusPollerService` is generalized into `AbsoluteStatusPoller`, which owns
transport, bearer auth, the closed set of poll-error reasons, transition-only
failure logging, `processUid` restart rebasing and the absolute-to-delta
arithmetic. Subclasses supply only a body schema and a fold function.
`TranscriptionMetricsPollerService` is the second consumer.

This retires the last five log parsers: `pythonDecodeDropParser`,
`createJobCompletionParser`, `bufferOverflowParser`, `audioTooFastParser` and
`noSpeechParser`. Three of the counters behind them are incremented inside a
spawned worker process, so logging them was the only reason they were ever
visible.

The T1 saturation rule now keys on **true RTF** — execution seconds per second
of ingested audio, measured by transcription-service — rather than the
period-utilization proxy. Period utilization survives as a secondary series,
derived from the reported execution quantiles and `TRANSCRIPTION_JOB_PERIOD_MS`,
so it no longer depends on a log line.

**Breaking metric changes.** `scribear_node_status_up`,
`scribear_node_status_poll_errors_total` and
`scribear_node_process_restarts_total` are renamed to `scribear_service_*`, now
that they carry a `service` label for more than one service.
`scribear_asr_scheduling_delay_ms` and `scribear_asr_period_utilization` change
from histograms to `quantile`-labelled gauges, and `scribear_asr_processing_ms`
is replaced by `scribear_asr_execution_ms`; the endpoint reports pre-computed
percentiles rather than samples, so there is no distribution to rebuild.
`ALERT_PERIOD_UTILIZATION_P95` is renamed `ALERT_RTF_P95`.

New env: `TRANSCRIPTION_SERVICE_METRICS_KEY`, `TRANSCRIPTION_METRICS_INTERVAL_SEC`.
A key set on the sidecar but not on the service yields a 404, reported as the
new `not-found` poll reason and alerted as a configuration fault rather than an
outage.
