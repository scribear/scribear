# @scribear/monitoring-sidecar

## 0.2.0

### Minor Changes

- aa0cb65: Detect and alert on a transcription worker that died after startup (B1.3).

  transcription-service's readiness was a hard-coded 200. It now fails when a
  worker process has exited and reports `degraded` (still 200) when every worker
  is saturated. The sidecar gains `scribear_asr_worker_alive` and a `workerDeadRule`
  naming the worker.

- 6f8e5b9: Add the monitoring sidecar (Part A items A1 + A3) and the node-server
  observability log lines it depends on.

  The sidecar is a standalone service that parses the other services' JSON logs
  into metrics, polls their liveness/readiness probes, evaluates the failure-mode
  alert rules in-process, and serves both a JSON snapshot and a Prometheus text
  endpoint. All state is in memory.

  node-server gains three `info` log lines that carry signals which previously
  existed only in memory: WebSocket close code/reason (server- and
  peer-initiated) and upstream transcription connection state transitions.
  Without these the upstream-flap and close-code metrics are not derivable from
  logs at all. No behaviour changes, and the added lines are off the audio hot
  path.

- 6f8e5b9: Add the synthetic canary (Part A item A2) to the monitoring sidecar.

  The canary authenticates as a registered ScribeAR device, joins the session
  active in that device's room, streams a known recording as a source using the
  real SAFP encoder, subscribes as a viewer on the `/client` route, and scores
  the captions that come back against the fixture's reference text.

  This is the first signal in the sidecar derived from actively exercising the
  pipeline rather than observing it: log parsing and probes can both report green
  while viewers receive nothing, and the canary is what catches that.

  New metrics (`scribear_canary_*`): run outcomes, time-to-first-transcript,
  word recall and precision, repetition ratio, pipeline and e2e latency
  percentiles, and clock-sync state. Two new alert rules — one for outright
  failure, one for degraded-but-flowing captions — plus C6 clock-sync detection.

  Disabled by default. It requires `CANARY_DEVICE_TOKEN`; without it the canary
  does not run. The device must belong to a dedicated canary room, since the
  canary streams synthetic speech into a real session. It deliberately holds no
  admin API key and no token-signing key, so it cannot reach any other room.

- 6f8e5b9: Add the standalone audio meter (Part A item A4) to the monitoring sidecar.

  The meter is a single self-contained HTML page — no imports, no build step and
  no network access of any kind. An audio engineer can copy it onto the source
  machine and open it straight from `file://`, which is the point: the whole
  value of A4 is being able to measure a room's input when the pipeline is the
  thing under suspicion. It picks up the same microphone the source browser
  would, and it uses an AudioWorklet where one is available, falling back to a
  `ScriptProcessorNode` when the blob worklet module is refused (as it is under
  `file://`), with identical readings either way.

  It reports RMS and fast RMS, sample peak with hold and decay, true (inter-
  sample) peak, clipping percentage, noise floor, a silence flag, and K-weighted
  loudness — momentary, short-term and gated integrated LUFS — plus short-term
  level against the loudness target in LU. Selectable conventions: dBFS reference
  (plain or AES17), loudness target, peak zone boundaries and silence threshold.
  SNR is deliberately absent; it needs voice-activity detection, which arrives
  with the service-side DSP work in Part B.

  The page's DSP is isolated in one DOM-free script block, and the unit suite
  extracts and evaluates that same block rather than a copy, so the shipped
  maths and the tested maths cannot drift. Gate A4 is verified end to end: a
  −18 dBFS alignment tone reads within ±0.5 dB on both audio paths.

  The sidecar also serves the page at `GET /api/monitoring/v1/audio-meter` as a
  convenience. That is a convenience only — the sidecar is not exposed through
  nginx, so reaching that URL from a source room needs a port-forward or an
  nginx rule. If the page file is missing the route is simply dropped with a
  warning rather than failing startup.

- 05a8b40: Source node-server telemetry from its status endpoint instead of its log text
  (monitoring plan B1.1, last of four PRs). This completes the cut-over: the log
  parsers for WebSocket closes, upstream state transitions, upstream churn and
  node-side decode drops are **removed**, and a new status poller feeds those same
  four metric names from `GET /api/node-server/v1/status`.

  Log inference worked, but it was lossy by construction — it depended on the log
  level, on the collector being attached for the whole window, and on nothing
  rotating out — and several signals had no log line at all. The endpoint also
  carries things logs never could: subscriber counts per session (nothing measured
  fan-out before), auth successes as the denominator that turns the S2 signal into
  a ratio, pending-chunk evictions, and the clock-skew discards behind S5.

  **Absolute totals, not increments.** The endpoint reports counters that are
  monotonic since node-server booted, so the poller tracks the previous absolute
  per series and applies only the difference. That keeps the sidecar's own
  counters monotonic and — importantly — keeps the rolling windows the alert rules
  evaluate against meaningful, which a plain `set()` would have destroyed.

  **Restarts rebase rather than diff.** A restarted node-server reports every
  counter back at zero. `processUid` changes on every boot, so a change clears the
  baselines and the fresh totals are attributed in full, since they are all events
  this sidecar has not seen. A counter that goes backwards without a uid change is
  treated the same way, so a restart between two polls can never produce a
  negative rate.

  **One metric got coarser, deliberately.** `scribear_node_upstream_churn_total`
  was per-session from logs; node-server counts it per process. The N1 rule now
  matches each series against its own labels and names the affected rooms from the
  new per-session upstream gauge instead. The trade is worth it: the counter is
  lossless where the log-derived one silently missed anything that happened while
  the collector was detached.

  **New alert for the blind spot this creates.** A node-server that is healthy but
  rejecting the sidecar's service key leaves four metrics reporting nothing while
  every probe stays green — a state the old log-based collector could not get
  into. `nodeStatusUnavailableRule` fires on that, critical when the key is
  rejected and warning when the endpoint is merely unreachable (which the probe
  poller already alerts on).

  The snapshot served to the admin SPA now includes a `gauges` block. Point-in-time
  values had nowhere to go before, and per-session state is exactly what the
  dashboard needs to draw a room rather than a number. Gauges for a session that
  ends are deleted rather than frozen at their last value — except when the
  response was truncated, where absence means "not told about" rather than
  "ended".

  Polling is disabled when `NODE_SERVER_SERVICE_API_KEY` is unset, matching how
  the canary treats its device token: a default deployment must not 401 against
  node-server on every interval forever. The startup log says so once, and the
  metrics it would have fed stay empty rather than wrong.

  transcription-service's decode-drop parser stays — that service has no status
  endpoint yet (B1.2), so its side of the metric is still only visible in logs.
  node-server's three A1 log lines also stay, as the per-event forensic record
  behind the counters.

- 1ad53e3: Delete Docker log ingestion entirely (B1.2 PR 5b).

  PR 5a retired the last five log parsers, leaving the ingest pipeline with one
  consumer: the session-manager config-poll correlator. Keeping the Docker Engine
  socket mount, the container discovery, the line normalizer and the correlator
  alive for a single detector was not a trade worth making, so all of it is gone.

  **The sidecar no longer needs the Docker socket.** That mount was
  root-equivalent access to the host. Every signal it fed now comes from an authed
  HTTP endpoint instead.

  **A real coverage regression, stated plainly.** Nothing now detects a
  `session-config-stream` 401 — the direct signature of the secret cross-wiring in
  ISSUES-To-Review.md. The N1 upstream churn it causes is still detected, so the
  symptom alerts, but the alert no longer names the cause. Restoring it needs a
  session-manager status endpoint, the same shape B1.1 and B1.2 gave node-server
  and transcription-service.

  Removed: the `configPollErrorRule` (N2/S3) and its `ALERT_CONFIG_POLL_ERROR_COUNT`
  threshold; the `scribear_sm_config_poll_*` and `scribear_log_lines_*` metrics;
  the snapshot's `ingest` block; and the `DOCKER_SOCKET_PATH` / `COMPOSE_PROJECT`
  env vars.

  **Readiness is re-keyed.** It required an ingested log line, which no longer
  exists. It now requires at least one probe result, and additionally reports
  unready when a status poll is being rejected with `unauthorized` or `not-found`
  — closing the follow-up B1.1 left open, where a sidecar whose status poll was
  refused reported ready while the metrics behind it silently froze. A merely
  unreachable service does not fail readiness; that is the monitored service's
  outage, not the sidecar's. The readiness `checks` key is renamed `logIngest` to
  `collectors`.

  > **Bump type note.** Recorded as `minor` rather than `major` because the
  > packages are pre-1.0, where the semver convention is that a minor bump
  > carries breaking changes and 1.0.0 is reserved for declaring the API
  > stable. Changesets does not apply that convention itself — a `major`
  > entry here would have taken every package straight to 1.0.0. The breaking
  > changes themselves are unchanged and are described above.

- 3b5ed13: Source transcription-service telemetry from `GET /metrics/status` instead of log text (B1.2 PR 5).

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

- 4350c80: Alert on the two signals B1.1 started collecting but nothing evaluated, and fix
  the S2 denominator.

  `clockSkewRule` (§3 S5) fires when a large share of latency samples come back
  with a negative end-to-end time, meaning source clocks are ahead of
  node-server's despite sync. This is worth its own alert precisely because it is
  invisible otherwise: captions are unaffected and pipeline latency still reports,
  so the only symptom is an end-to-end panel that quietly stops being populated.
  It is a ratio with a minimum sample count, because a couple of odd devices are
  noise while a large fraction is a deployment fault.

  `pendingChunkEvictionRule` (§3 N3) fires when audio frames are evicted from the
  correlation map before their transcript returns. The captions are fine; what
  degrades is the latency measurement, and it degrades in the most misleading
  possible direction — the frames being dropped are the slow ones, so the
  remaining numbers look healthier than reality.

  `authFailureRule` now divides by auth _attempts_ rather than by all WebSocket
  closes. Attempts are what the plan specifies for S2, and they only became
  available with B1.1's status endpoint; dividing by every close includes normal
  end-of-session traffic, which drags the ratio down and can hide real signing-key
  drift entirely. The close-based form is kept as a fallback for deployments
  running without status polling, where it remains the only thing available.

  All three thresholds are configurable, as every threshold in this service is.

- d947523: Aggregate transcript latency server-side and report percentiles (B1.4).

  Node Server correlated every transcript back to the audio frame that produced
  it, published a `latencyUpdate` to whoever was subscribed, and then threw the
  number away. The only way to see a room's latency was to be a client watching
  that room, which is exactly the wrong property for an operations dashboard.

  `GET /api/node-server/v1/status` now carries bounded latency windows:
  - a process-wide `latency[]`, and a `latency[]` on each entry of `sessions[]`;
  - one series per `(measure, kind)` — `pipeline` (audio ingress to transcript,
    monotonic clock only) versus `e2e` (source capture to transcript, using the
    clock-corrected send time), each split into `final` and `inProgress`;
  - each series carries `count`/`sum` (lifetime, difference them like a counter)
    plus `sampleCount`/`min`/`max`/`mean`/`p50`/`p95`/`p99` over the retained ring
    (4096 process-wide, 512 per session).

  Interim and final transcripts are reported separately rather than pooled: a
  final is only emitted once the provider decides an utterance ended, so pooling
  would give a p50 describing interims and a p95 describing finals. A series with
  no samples is omitted rather than reported as zeroes — an `e2e` series is absent
  entirely when no source supplies a send timestamp, which is not the same as an
  end-to-end latency of zero. Percentiles are nearest-rank, matching what the
  sidecar and transcription-service already use.

  These are the first non-integer fields in the status response.

  Per-session windows are discarded when the session's last connection closes,
  the same lifetime as `subscriberCount`. A sample for a session with no recorded
  connection still counts process-wide but creates no per-session entry, so the
  map stays bounded by live rooms.

  The sidecar exports the process-wide figures as
  `scribear_node_pipeline_latency_ms` and `scribear_node_e2e_latency_ms`, labelled
  `kind` and `quantile` — gauges, not histograms, because Node Server reports
  pre-computed percentiles and observing a p95 into a local histogram would yield
  a distribution of p95s. Per-session percentiles are deliberately not mirrored
  into Prometheus; they would add a dozen series per live room to every scrape,
  and the fleet SPA can read them from `/status` directly.

## 0.1.0

### Minor Changes

- Initial monitoring sidecar implementing Part A items A1 (log-metrics
  collector) and A3 (probe & version poller) from
  `PLAN-MONITORING-DASHBOARD.md`.

  Parses the JSON logs of node-server, session-manager, admin-server, and
  transcription-service into counters and histograms; polls every service's
  liveness/readiness probes; evaluates the §3 failure-catalog alert rules
  in-process; and serves both a JSON snapshot for the admin SPA and a
  Prometheus text endpoint.

  All state is in memory — restarting the sidecar zeroes every metric, and
  historical trends are out of scope for this version.
