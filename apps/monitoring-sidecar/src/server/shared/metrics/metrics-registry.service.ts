import {
  Counter,
  Gauge,
  Histogram,
} from '#src/server/shared/metrics/metric-types.js';

/**
 * Latency buckets in milliseconds, spanning the range the pipeline actually
 * operates in: sub-millisecond scheduling delays through multi-second Whisper
 * passes.
 */
const MS_BUCKETS = [
  1, 5, 10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000, 30_000,
] as const;

/**
 * The full metric catalog, held in memory.
 *
 * Naming follows Prometheus convention (`_total` for counters, base unit
 * suffixes) so the `/metrics` output is idiomatic even though the primary
 * consumer is the admin SPA's JSON snapshot.
 */
export class MetricsRegistry {
  // --- B1.1: node-server status endpoint ----------------------------------
  //
  // The four metrics below were originally derived from node-server log text
  // (A1). They now come from `GET /api/node-server/v1/status`, which reports
  // the same events as authoritative in-process counters. The metric names are
  // unchanged, so nothing downstream had to move; only the source did.
  //
  // Log inference was lossy by construction: it depended on the log level, on
  // the collector being attached for the whole window, and on nothing rotating
  // out. See PLAN-B1.1-node-server-status.md §5.

  /**
   * SAFP frames rejected by the decoder. Rising on the node side means the
   * sender is emitting frames this build cannot parse — the version-skew
   * signature (§3 U2 / S4).
   *
   * Two sources, distinguished by the `side` label, and since B1.2 both are
   * endpoint-derived: `node` from `GET /api/node-server/v1/status`,
   * `transcription` from `GET /metrics/status`.
   */
  readonly safpDecodeDropsTotal = new Counter(
    'scribear_safp_decode_drops_total',
    'Malformed SAFP audio frames dropped, by service.',
  );

  /**
   * WebSocket closes on node-server's transcription stream, labelled by close
   * code, reason, role, and initiator (`server` vs `peer`).
   */
  readonly wsCloseTotal = new Counter(
    'scribear_ws_close_total',
    'WebSocket closes by code, reason, role and initiator.',
  );

  /**
   * Upstream (node-server -> transcription-service) connection state
   * transitions, labelled `from`/`to`.
   */
  readonly upstreamStateTotal = new Counter(
    'scribear_node_upstream_state_total',
    'Upstream transcription connection state transitions.',
  );

  /**
   * Upstream churn: connection lost and being retried. This is the BUG.txt /
   * §3 N1 detector — a healthy session contributes zero.
   *
   * Process-wide rather than per-session, which is the one thing that got
   * coarser in the cut-over: node-server counts churn as a whole and reports
   * per-session state as a gauge instead. The trade is worth it — the counter
   * is now lossless, whereas the log-derived per-session count silently missed
   * anything that happened while the collector was detached. The affected
   * sessions are still nameable via {@link nodeSessionUpstreamUp}.
   */
  readonly upstreamChurnTotal = new Counter(
    'scribear_node_upstream_churn_total',
    'Upstream transcription reconnect events.',
  );

  /** Auth handshakes node-server rejected, by reason (§3 U3 / S2). */
  readonly nodeAuthFailuresTotal = new Counter(
    'scribear_node_auth_failures_total',
    'Transcription-stream auth attempts rejected, by reason.',
  );

  /**
   * Auth handshakes that succeeded. The denominator that makes S2 a ratio:
   * a few rejections are normal, near-total rejection is signing-key drift.
   */
  readonly nodeAuthSuccessTotal = new Counter(
    'scribear_node_auth_success_total',
    'Transcription-stream auth attempts that succeeded.',
  );

  /** Connections that never sent `auth` within the watchdog window (§3 U3). */
  readonly nodeAuthTimeoutsTotal = new Counter(
    'scribear_node_auth_timeouts_total',
    'Connections closed for not authenticating in time.',
  );

  /** Source registrations that threw, closing the socket with 1011. */
  readonly nodeOrchestratorFailuresTotal = new Counter(
    'scribear_node_orchestrator_failures_total',
    'Source registrations that failed inside the orchestrator.',
  );

  /**
   * Audio frames evicted at the per-session pending-chunk cap (§3 N3).
   * Sustained eviction means latency correlation is degrading silently.
   */
  readonly nodePendingChunkEvictionsTotal = new Counter(
    'scribear_node_pending_chunk_evictions_total',
    'Uncorrelated audio frames evicted at the per-session cap.',
  );

  /** Latency samples published. Denominator for the two counters below. */
  readonly nodeLatencySamplesTotal = new Counter(
    'scribear_node_latency_samples_total',
    'Latency samples published by node-server.',
  );

  /**
   * Samples whose end-to-end time computed negative — the source clock is
   * ahead of node-server's despite sync (§3 S5). Meaningful as a share of
   * {@link nodeLatencySamplesTotal}, not as a raw count.
   */
  readonly nodeLatencyE2eNegativeTotal = new Counter(
    'scribear_node_latency_e2e_negative_total',
    'Latency samples discarded for a negative end-to-end time (clock skew).',
  );

  /** Samples with no source timestamp, so no end-to-end figure was possible. */
  readonly nodeLatencyE2eUnavailableTotal = new Counter(
    'scribear_node_latency_e2e_unavailable_total',
    'Latency samples with no end-to-end time available.',
  );

  /**
   * Transcript latency as measured by node-server itself (B1.4), by `kind`
   * (`final` / `inProgress`) and `quantile`.
   *
   * Gauges rather than histograms, for the same reason as the `asr*` timing
   * series above: node-server reports pre-computed percentiles over its own
   * retained ring, so there is no distribution left to rebuild, and observing a
   * reported p95 into a local histogram would yield a distribution of p95s.
   *
   * `pipeline` is node-server's monotonic clock only. {@link nodeE2eLatencyMs}
   * additionally covers capture and uplink using the source's clock-corrected
   * send time, so it is the number a user would recognise as "delay" — and the
   * only one that can be poisoned by clock skew (§3 S5).
   *
   * Per-session percentiles are deliberately *not* mirrored here. They exist on
   * node-server's `/status` for the fleet SPA to read directly; folding them in
   * would add twelve series per live session to every scrape, for a cardinality
   * that grows with room count.
   */
  readonly nodePipelineLatencyMs = new Gauge(
    'scribear_node_pipeline_latency_ms',
    'Audio ingress to transcript received, on node-server’s monotonic clock, by kind and quantile.',
  );

  /** End-to-end transcript latency including capture and uplink (§3 S5). */
  readonly nodeE2eLatencyMs = new Gauge(
    'scribear_node_e2e_latency_ms',
    'Source capture to transcript received, by kind and quantile.',
  );

  /** Transcripts referencing an already-evicted or pruned chunk (§3 N3). */
  readonly nodeLatencyUnmatchedChunkTotal = new Counter(
    'scribear_node_latency_unmatched_chunk_total',
    'Transcripts that could not be correlated to an audio frame.',
  );

  // --- Status polling, shared by every polled service ----------------------
  //
  // Written by `AbsoluteStatusPoller` and distinguished by the `service` label,
  // so node-server (B1.1) and transcription-service (B1.2) share them. They
  // were named `scribear_node_*` when node-server was the only polled service;
  // B1.2 renamed them to `scribear_service_*`, which is a breaking change for
  // anything querying the old names.

  /** Restarts of a polled service, observed as a change of `processUid`. */
  readonly serviceProcessRestartsTotal = new Counter(
    'scribear_service_process_restarts_total',
    'Times a polled service process identity changed.',
  );

  /** Status polls that failed, by service and reason. */
  readonly serviceStatusPollErrorsTotal = new Counter(
    'scribear_service_status_poll_errors_total',
    'Failed polls of a service status endpoint, by reason.',
  );

  /**
   * 1 when the last status poll succeeded, 0 otherwise.
   *
   * Distinct from the liveness probe: a service can be alive and still be
   * refusing the sidecar's key, in which case every counter it sources is
   * frozen at its last value. Without this gauge that looks identical to a
   * quiet, healthy system.
   */
  readonly serviceStatusUp = new Gauge(
    'scribear_service_status_up',
    'Whether the last status poll of a service succeeded.',
  );

  /** Sessions currently holding an upstream transcription connection. */
  readonly nodeActiveSessions = new Gauge(
    'scribear_node_active_sessions',
    'Sessions with a live upstream transcription connection.',
  );

  /** Source-role connections feeding a session. */
  readonly nodeSessionSources = new Gauge(
    'scribear_node_session_sources',
    'Source connections per session.',
  );

  /**
   * Connections subscribed to a session, both roles (§3 N4). Nothing measured
   * this before B1.1 — receive-only clients never reach the orchestrator, so
   * fan-out cost in a large room was entirely invisible.
   */
  readonly nodeSessionSubscribers = new Gauge(
    'scribear_node_session_subscribers',
    'Subscribed connections per session, both roles.',
  );

  /** Audio frames awaiting transcript correlation, per session (§3 N3). */
  readonly nodeSessionPendingChunks = new Gauge(
    'scribear_node_session_pending_chunks',
    'Audio frames awaiting transcript correlation, per session.',
  );

  /** 1 when a session's upstream is OPEN, 0 in any other state (§3 N1). */
  readonly nodeSessionUpstreamUp = new Gauge(
    'scribear_node_session_upstream_up',
    'Whether a session’s upstream transcription connection is OPEN.',
  );

  /** Consecutive reconnect attempts for a session's upstream (§3 N1). */
  readonly nodeSessionUpstreamRetryAttempt = new Gauge(
    'scribear_node_session_upstream_retry_attempt',
    'Consecutive upstream reconnect attempts, per session.',
  );

  // --- B1.2: transcription-service metrics endpoint ------------------------
  //
  // Everything below came from log text until B1.2. Three of these counters are
  // incremented *inside a spawned worker process*, so logging them was the only
  // reason they were visible at all; B1.2 PR 4 gave them a transport back to
  // the parent, and PR 5 retired the parsers.
  //
  // The four job-timing series are gauges, not histograms. The endpoint reports
  // pre-computed percentiles over its own retained ring rather than raw
  // samples, so there is nothing to rebuild a distribution from — observing a
  // reported p95 into a local histogram would yield a distribution of
  // percentiles. They carry a `quantile` label instead, the Prometheus summary
  // idiom.

  /** Queue wait before a transcription job starts executing, by quantile. */
  readonly asrSchedulingDelayMs = new Gauge(
    'scribear_asr_scheduling_delay_ms',
    'Delay between a transcription job becoming ready and being scheduled, by quantile.',
  );

  /** Wall time a transcription job spent executing, by quantile. */
  readonly asrExecutionMs = new Gauge(
    'scribear_asr_execution_ms',
    'Transcription job execution time, by quantile.',
  );

  /** Scheduling delay plus execution, by quantile. */
  readonly asrTotalMs = new Gauge(
    'scribear_asr_total_ms',
    'Total transcription job time, by quantile.',
  );

  /**
   * **The real real-time factor** (§4.3): wall-clock execution time per second
   * of audio ingested, measured by transcription-service itself. Above 1.0 the
   * service cannot keep up with realtime audio and backlog accrues.
   *
   * Superseded {@link asrPeriodUtilization} as the T1 saturation signal. Note
   * it is computed over *ingested* audio rather than VAD-kept audio, so silence
   * does not flatter it.
   */
  readonly asrRtf = new Gauge(
    'scribear_asr_rtf',
    'Transcription real-time factor (execution seconds per second of ingested audio), by quantile. 1.0 = saturated.',
  );

  /**
   * Job execution time divided by that provider's job period, derived in the
   * sidecar from {@link asrExecutionMs} and the period in {@link asrJobPeriodMs}.
   *
   * Kept as a secondary series now that {@link asrRtf} exists. It saturates at
   * the same 1.0 line but answers a different question — "is a job finishing
   * within the cadence that schedules it?" — and no longer depends on a log
   * line, so it survived the parser retirement.
   *
   * **A provider whose period is unknown gets no series here at all**, rather
   * than one scaled by a default. The ratio is only as good as its denominator,
   * and a plausible-looking utilization derived from the wrong period is a
   * number an operator will act on.
   */
  readonly asrPeriodUtilization = new Gauge(
    'scribear_asr_period_utilization',
    'Transcription job execution time divided by the job period (1.0 = saturated), by quantile.',
  );

  /**
   * The denominator {@link asrPeriodUtilization} is actually being divided by,
   * per provider, with `source` naming where that number came from —
   * `reported` (transcription-service sent it) or `configured`
   * (`TRANSCRIPTION_JOB_PERIOD_MS` said so).
   *
   * Exported because the period is the one input to the dashboard that the
   * sidecar cannot verify: it lives in transcription-service's
   * `provider_config.json`, and while `source=configured` the two are stated in
   * different files by different people. Publishing the denominator beside the
   * ratio is what turns "this number is silently wrong" into "this number is
   * visibly derived from 1000 ms, which is not what the provider config says" —
   * and its *absence* for a provider is the honest signal that no period is
   * known, matching the missing utilization series exactly.
   */
  readonly asrJobPeriodMs = new Gauge(
    'scribear_asr_job_period_ms',
    'Job period the period-utilization series is scaled by, per provider, labelled with where that number came from.',
  );

  /** Worker processes the deployment is configured to run. */
  readonly asrWorkers = new Gauge(
    'scribear_asr_workers',
    'Configured transcription worker processes.',
  );

  /** Rolling 10-minute busy fraction per worker; the scheduler's own signal. */
  readonly asrWorkerUtilization = new Gauge(
    'scribear_asr_worker_utilization',
    'Rolling utilization of a transcription worker process.',
  );

  /** Jobs currently registered on a worker. Instantaneous, unlike utilization. */
  readonly asrWorkerLiveJobs = new Gauge(
    'scribear_asr_worker_live_jobs',
    'Jobs currently registered on a transcription worker.',
  );

  /**
   * 1 when a worker process is still running, 0 when it has exited (§3 T9).
   *
   * A worker that dies after startup is silent: the pool's result-queue poll
   * loop simply times out forever, and jobs already registered to that worker
   * never return and never raise. Nothing else distinguishes a wedged worker
   * from an idle one.
   */
  readonly asrWorkerAlive = new Gauge(
    'scribear_asr_worker_alive',
    'Whether a transcription worker process is still running.',
  );

  /** Transcription contexts held open on a worker (§3 T9). */
  readonly asrWorkerContexts = new Gauge(
    'scribear_asr_worker_contexts',
    'Transcription contexts held open on a worker.',
  );

  /** Jobs ever registered on a worker, monotonic per worker process. */
  readonly asrWorkerJobsRegisteredTotal = new Counter(
    'scribear_asr_worker_jobs_registered_total',
    'Jobs registered on a transcription worker since it started.',
  );

  /** Transcription jobs that completed successfully. */
  readonly asrJobsCompletedTotal = new Counter(
    'scribear_asr_jobs_completed_total',
    'Transcription jobs that completed successfully, by provider.',
  );

  /**
   * Transcription jobs that raised, by `reason`. The reason is the exception
   * *class* name, never its message — messages are unbounded and would make
   * this series unbounded with them.
   */
  readonly asrJobsFailedTotal = new Counter(
    'scribear_asr_jobs_failed_total',
    'Transcription jobs that raised, by provider and exception class.',
  );

  /** Seconds of audio ingested. The service's throughput, and RTF's denominator. */
  readonly asrAudioSecondsTotal = new Counter(
    'scribear_asr_audio_seconds_total',
    'Seconds of audio ingested by transcription jobs, by provider.',
  );

  /**
   * The two halves of a *windowed mean* RTF, per provider: the sum of the
   * per-job ratios transcription-service observed, and the number of jobs that
   * contributed one.
   *
   * {@link asrRtf} cannot answer "has this been true for a while?", which is
   * the whole question behind §3 T1. It republishes percentiles the far end
   * pre-computed over its own 4096-sample ring, and a percentile cannot be
   * re-averaged, re-windowed or aggregated. Worse, that ring never expires by
   * time — it only evicts when new samples arrive — so a p95 left behind by a
   * finished session reads exactly like a live one. These are lifetime totals
   * instead (`sum` and `count` on the same histogram series, which the endpoint
   * has always reported and nothing consumed), so differencing them across
   * polls yields a mean over an arbitrary window, and yields *nothing at all*
   * while the provider is idle.
   *
   * Named `duty_ratio` rather than `asr_rtf_sum` / `asr_rtf_count` on purpose:
   * those two suffixes belong to the Prometheus summary convention, i.e. to the
   * `scribear_asr_rtf` family, and these are separate counter families over a
   * different window. "Duty ratio" is also what the number means in this
   * deployment — each job period ingests roughly one period of live audio, so
   * execution seconds per second of ingested audio is the fraction of the
   * period budget the job spent. The two readings only diverge for a client
   * pushing audio faster than realtime, which is rejected outright (see
   * {@link asrAudioTooFastTotal}).
   */
  readonly asrDutyRatioSumTotal = new Counter(
    'scribear_asr_duty_ratio_sum_total',
    'Sum of per-job real-time factors observed by transcription-service, by provider.',
  );

  /**
   * Jobs that contributed a real-time-factor observation;
   * {@link asrDutyRatioSumTotal}'s denominator.
   *
   * Not the same population as {@link asrJobsCompletedTotal}: RTF is recorded
   * for failed executions too (a job that raised still consumed worker time)
   * and skipped for a job that ingested no audio (the ratio would divide by
   * zero). Using the jobs counter as a stand-in denominator would therefore
   * quietly bias the mean, which is why this exists at all.
   */
  readonly asrDutyRatioJobsTotal = new Counter(
    'scribear_asr_duty_ratio_jobs_total',
    'Transcription jobs that contributed a real-time-factor observation, by provider.',
  );

  /**
   * **Job periods in which no pass ran**, per provider, because the pass before
   * them overran. Exact, and reported by transcription-service rather than
   * inferred here.
   *
   * This is the failure every other T1 signal only implies. When a pass exceeds
   * `job_period_ms` the worker pool neither queues nor errors: it advances the
   * job's `period_start_ns` by whole periods until it passes now, so the missed
   * periods are simply gone and the effective period becomes a multiple of the
   * configured one. Captions get staler; nothing else moves.
   *
   * Note what it is *not* derived from. An RTF threshold cannot stand in for
   * this, which is the trap it was nearly built as: RTF's denominator is the
   * audio one pass ingested, and a dropped period leaves more audio for the
   * next pass, so RTF *falls* as periods are lost. Measured at 1/2/3/5/8
   * concurrent sessions on one worker, mean RTF went 0.277 -> 0.256 -> 0.229 ->
   * 0.194 -> 0.139 while the worker went 26% -> 94.5% busy and transcripts per
   * 1000 chunks collapsed 190 -> 48. Counting the scheduler's own skipped
   * iterations has no such blind spot.
   */
  readonly asrDroppedPeriodsTotal = new Counter(
    'scribear_asr_dropped_periods_total',
    'Job periods in which no transcription pass ran because the previous one overran, by provider.',
  );

  /**
   * 1 when the polled transcription-service reports
   * {@link asrDroppedPeriodsTotal}, 0 when it is too old to.
   *
   * Needed because "no series" is ambiguous in the other direction: a healthy
   * service reports an empty array, and a counter that never increments creates
   * no series here either, so the absence of a dropped-period series means
   * *either* nothing was dropped or nothing is being counted. Those demand
   * opposite responses from `transcriptionTailOverrunRule` — trust the zero, or
   * fall back to the p99 RTF gauge — so the distinction is published explicitly
   * rather than guessed. Also the honest answer to "why did this alert change
   * shape mid-upgrade" on a mixed-version fleet.
   */
  readonly asrDroppedPeriodsSupported = new Gauge(
    'scribear_asr_dropped_periods_supported',
    'Whether the polled transcription-service reports the dropped-period counter (1) or the sidecar must fall back to the reported p99 RTF (0).',
  );

  /** Jobs whose buffer filled and were force-finalized (§3 T2). */
  readonly asrBufferOverflowTotal = new Counter(
    'scribear_asr_buffer_overflow_total',
    'Transcription buffers force-finalized because they filled.',
  );

  /**
   * Seconds of audio discarded to buffer overflow — *how much* was lost, which
   * the overflow count alone does not say.
   */
  readonly asrBufferOverflowSecondsTotal = new Counter(
    'scribear_asr_buffer_overflow_seconds_total',
    'Seconds of audio discarded when a transcription buffer overflowed.',
  );

  /** Clients pushing audio faster than realtime (§3 T2, hard error). */
  readonly asrAudioTooFastTotal = new Counter(
    'scribear_asr_audio_too_fast_total',
    'Sessions rejected for sending audio faster than realtime.',
  );

  /**
   * Buffers that yielded no speech, labelled `kind`:
   * - `no_words` — the model transcribed nothing from a buffer VAD accepted
   * - `vad_no_speech` — VAD found no speech at all
   *
   * Both were log-derived before B1.2, and `vad_no_speech` was DEBUG-only, i.e.
   * invisible in any production deployment.
   */
  readonly asrNoSpeechTotal = new Counter(
    'scribear_asr_no_speech_total',
    'Transcription buffers that produced no speech, by kind.',
  );

  // --- A3: probe-derived --------------------------------------------------

  /** 1 when the probe returned healthy, 0 otherwise. Labelled service/probe. */
  readonly probeUp = new Gauge(
    'scribear_probe_up',
    'Whether a service probe last returned healthy (1) or not (0).',
  );

  /** Round-trip time of the last probe poll. */
  readonly probeLatencyMs = new Gauge(
    'scribear_probe_latency_ms',
    'Round-trip time of the most recent probe poll.',
  );

  /** Consecutive failed polls, per service/probe. Drives the flap-vs-down distinction. */
  readonly probeConsecutiveFailures = new Gauge(
    'scribear_probe_consecutive_failures',
    'Consecutive failed polls for a service probe.',
  );

  /** Probe transitions, so a flapping dependency is distinguishable from a steady outage. */
  readonly probeTransitionsTotal = new Counter(
    'scribear_probe_transitions_total',
    'Probe health transitions, by service, probe and direction.',
  );

  /**
   * Build/version stamp per service, carried entirely in labels with a constant
   * value of 1 (the Prometheus "info metric" idiom). Drives skew detection (§3 S4).
   */
  readonly serviceBuildInfo = new Gauge(
    'scribear_service_build_info',
    'Build/version stamp per service; value is always 1, information is in the labels.',
  );

  // --- A2: synthetic canary ----------------------------------------------

  /** Canary probes by outcome. The `ok` share is the end-to-end SLI. */
  readonly canaryRunsTotal = new Counter(
    'scribear_canary_runs_total',
    'Synthetic canary probes, by outcome.',
  );

  /**
   * 1 when the last probe succeeded end-to-end, 0 when it failed.
   *
   * Held at 1 when there is no active session to probe: an idle canary room is
   * not an outage, and reporting one nightly would train operators to ignore
   * this metric entirely.
   */
  readonly canaryUp = new Gauge(
    'scribear_canary_up',
    'Whether the last canary probe delivered captions end-to-end.',
  );

  /** Transcript messages the canary viewer received. */
  readonly canaryTranscriptsTotal = new Counter(
    'scribear_canary_transcripts_total',
    'Transcript messages received by the canary viewer.',
  );

  /**
   * First audio frame to first transcript. The plan's headline A2 assertion,
   * and the only measure of caption latency that includes every stage.
   */
  readonly canaryTimeToFirstTranscriptMs = new Histogram(
    'scribear_canary_time_to_first_transcript_ms',
    'Delay from the canary’s first audio frame to its first transcript.',
    MS_BUCKETS,
  );

  /**
   * Fraction of known-script words that came back. Falls when captions
   * degrade or stop. See `transcript-accuracy.ts` — this is a health proxy,
   * not a WER benchmark.
   */
  readonly canaryAccuracyRecall = new Gauge(
    'scribear_canary_accuracy_recall',
    'Fraction of expected words present in the canary transcript.',
  );

  /** Fraction of returned words that were expected; falls on hallucination. */
  readonly canaryAccuracyPrecision = new Gauge(
    'scribear_canary_accuracy_precision',
    'Fraction of canary transcript words that were expected.',
  );

  /** Duplicate-word fraction; the Whisper looping signature. */
  readonly canaryRepetitionRatio = new Gauge(
    'scribear_canary_repetition_ratio',
    'Fraction of canary transcript words that repeat an earlier word.',
  );

  /** p95 skew-free node-side caption latency observed by the canary. */
  readonly canaryPipelineMsP95 = new Gauge(
    'scribear_canary_pipeline_ms_p95',
    'p95 pipeline latency reported to the canary viewer.',
  );

  /** p95 end-to-end latency, including capture and uplink legs. */
  readonly canaryE2eMsP95 = new Gauge(
    'scribear_canary_e2e_ms_p95',
    'p95 end-to-end latency reported to the canary viewer.',
  );

  /** 1 when clock sync converged, 0 otherwise. Direct §3 C6 detector. */
  readonly canaryClockSyncOk = new Gauge(
    'scribear_canary_clock_sync_ok',
    'Whether the canary established a usable server clock offset.',
  );

  /** Every counter in the registry, for generic export. */
  counters(): Counter[] {
    return [
      this.safpDecodeDropsTotal,
      this.wsCloseTotal,
      this.upstreamStateTotal,
      this.upstreamChurnTotal,
      this.nodeAuthFailuresTotal,
      this.nodeAuthSuccessTotal,
      this.nodeAuthTimeoutsTotal,
      this.nodeOrchestratorFailuresTotal,
      this.nodePendingChunkEvictionsTotal,
      this.nodeLatencySamplesTotal,
      this.nodeLatencyE2eNegativeTotal,
      this.nodeLatencyE2eUnavailableTotal,
      this.nodeLatencyUnmatchedChunkTotal,
      this.serviceProcessRestartsTotal,
      this.serviceStatusPollErrorsTotal,
      this.asrWorkerJobsRegisteredTotal,
      this.asrJobsCompletedTotal,
      this.asrJobsFailedTotal,
      this.asrAudioSecondsTotal,
      this.asrDutyRatioSumTotal,
      this.asrDutyRatioJobsTotal,
      this.asrDroppedPeriodsTotal,
      this.asrBufferOverflowTotal,
      this.asrBufferOverflowSecondsTotal,
      this.asrAudioTooFastTotal,
      this.asrNoSpeechTotal,
      this.probeTransitionsTotal,
      this.canaryRunsTotal,
      this.canaryTranscriptsTotal,
    ];
  }

  /** Every gauge in the registry, for generic export. */
  gauges(): Gauge[] {
    return [
      this.probeUp,
      this.probeLatencyMs,
      this.probeConsecutiveFailures,
      this.serviceBuildInfo,
      this.serviceStatusUp,
      this.asrSchedulingDelayMs,
      this.asrExecutionMs,
      this.asrTotalMs,
      this.asrRtf,
      this.asrPeriodUtilization,
      this.asrJobPeriodMs,
      this.asrDroppedPeriodsSupported,
      this.asrWorkers,
      this.asrWorkerUtilization,
      this.asrWorkerAlive,
      this.asrWorkerLiveJobs,
      this.asrWorkerContexts,
      this.nodeActiveSessions,
      this.nodeSessionSources,
      this.nodeSessionSubscribers,
      this.nodeSessionPendingChunks,
      this.nodeSessionUpstreamUp,
      this.nodeSessionUpstreamRetryAttempt,
      this.nodePipelineLatencyMs,
      this.nodeE2eLatencyMs,
      this.canaryUp,
      this.canaryAccuracyRecall,
      this.canaryAccuracyPrecision,
      this.canaryRepetitionRatio,
      this.canaryPipelineMsP95,
      this.canaryE2eMsP95,
      this.canaryClockSyncOk,
    ];
  }

  /** Every histogram in the registry, for generic export. */
  histograms(): Histogram[] {
    return [this.canaryTimeToFirstTranscriptMs];
  }
}
