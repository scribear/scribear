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
 * Buckets for the period-utilization ratio (job execution time / job period).
 * 1.0 is the saturation line: above it a job takes longer than the cadence that
 * schedules it, so backlog accrues. See the caveat on
 * {@link MetricsRegistry.asrPeriodUtilization}.
 */
const RATIO_BUCKETS = [
  0.1, 0.25, 0.5, 0.6, 0.75, 0.9, 1.0, 1.25, 1.5, 2.0, 4.0,
] as const;

/**
 * The full metric catalog, held in memory.
 *
 * Naming follows Prometheus convention (`_total` for counters, base unit
 * suffixes) so the `/metrics` output is idiomatic even though the primary
 * consumer is the admin SPA's JSON snapshot.
 */
export class MetricsRegistry {
  // --- A1: log-derived ----------------------------------------------------

  /**
   * SAFP frames rejected by the decoder. Rising on the node side means the
   * sender is emitting frames this build cannot parse — the version-skew
   * signature (§3 U2 / S4).
   */
  readonly safpDecodeDropsTotal = new Counter(
    'scribear_safp_decode_drops_total',
    'Malformed SAFP audio frames dropped, by service.',
  );

  /**
   * WebSocket closes on node-server's transcription stream, labelled by close
   * code, reason, role, and initiator (`server` vs `peer`).
   *
   * Requires the close-logging added to `transcription-stream.controller.ts`;
   * before that change no close was observable from logs at all.
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
   * Upstream churn: transitions that indicate a connection was lost and is
   * being retried, per session. This is the BUG.txt / §3 N1 detector — a
   * healthy session contributes zero.
   */
  readonly upstreamChurnTotal = new Counter(
    'scribear_node_upstream_churn_total',
    'Upstream transcription reconnect events, by session.',
  );

  /** Queue wait before a transcription job starts executing. */
  readonly asrSchedulingDelayMs = new Histogram(
    'scribear_asr_scheduling_delay_ms',
    'Delay between a transcription job becoming ready and being scheduled.',
    MS_BUCKETS,
  );

  /** Wall time a transcription job spent executing. */
  readonly asrProcessingMs = new Histogram(
    'scribear_asr_processing_ms',
    'Transcription job execution time.',
    MS_BUCKETS,
  );

  /**
   * Job execution time divided by the configured job period.
   *
   * NOT the real-time factor the plan (§4.3) specifies. True RTF needs the
   * audio duration of the processed buffer as its denominator, and the
   * `"Completed transcription job"` log line does not carry it — `asdict()`
   * on `JobStatistics` serializes only the four raw timestamps, and the
   * derived properties are absent. This ratio answers the closely-related and
   * still-actionable question "is a job finishing within the cadence that
   * schedules it?", which saturates at the same 1.0 line. Replace with true
   * RTF when B1.2 exposes it.
   */
  readonly asrPeriodUtilization = new Histogram(
    'scribear_asr_period_utilization',
    'Transcription job execution time divided by the job period (1.0 = saturated). Proxy for RTF; see docs.',
    RATIO_BUCKETS,
  );

  /** Jobs whose buffer filled and were force-finalized (§3 T2). */
  readonly asrBufferOverflowTotal = new Counter(
    'scribear_asr_buffer_overflow_total',
    'Transcription buffers force-finalized because they filled.',
  );

  /** Clients pushing audio faster than realtime (§3 T2, hard error). */
  readonly asrAudioTooFastTotal = new Counter(
    'scribear_asr_audio_too_fast_total',
    'Sessions rejected for sending audio faster than realtime.',
  );

  /**
   * Buffers that yielded no speech, labelled `kind`:
   * - `no_words` from `"No words transcribed in buffer."` (INFO, always visible)
   * - `vad_no_speech` from `"VAD detected no speech in buffer"` (DEBUG — only
   *   visible if transcription-service runs at LOG_LEVEL=debug)
   */
  readonly asrNoSpeechTotal = new Counter(
    'scribear_asr_no_speech_total',
    'Transcription buffers that produced no speech, by kind.',
  );

  /**
   * session-manager `session-config-stream` responses that failed auth. The
   * direct detector for the secret cross-wiring in ISSUES-To-Review.md
   * (§3 N2 / S3).
   */
  readonly smConfigPollErrorsTotal = new Counter(
    'scribear_sm_config_poll_errors_total',
    'session-config-stream requests rejected, by HTTP status.',
  );

  /** Successful session-config-stream polls, the denominator for the 401 rate. */
  readonly smConfigPollOkTotal = new Counter(
    'scribear_sm_config_poll_ok_total',
    'session-config-stream requests that succeeded.',
  );

  /** Log lines the ingest saw but no parser claimed. Useful for drift detection. */
  readonly logLinesUnparsedTotal = new Counter(
    'scribear_log_lines_unparsed_total',
    'Ingested log lines that matched no parser, by service.',
  );

  /** Log lines successfully consumed by a parser. */
  readonly logLinesParsedTotal = new Counter(
    'scribear_log_lines_parsed_total',
    'Ingested log lines consumed by a parser, by service and parser.',
  );

  /** Lines that could not be decoded as JSON at all (pretty-print mode, partial writes). */
  readonly logLinesMalformedTotal = new Counter(
    'scribear_log_lines_malformed_total',
    'Ingested log lines that could not be parsed as JSON, by service.',
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
      this.asrBufferOverflowTotal,
      this.asrAudioTooFastTotal,
      this.asrNoSpeechTotal,
      this.smConfigPollErrorsTotal,
      this.smConfigPollOkTotal,
      this.logLinesUnparsedTotal,
      this.logLinesParsedTotal,
      this.logLinesMalformedTotal,
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
    return [
      this.asrSchedulingDelayMs,
      this.asrProcessingMs,
      this.asrPeriodUtilization,
      this.canaryTimeToFirstTranscriptMs,
    ];
  }
}
