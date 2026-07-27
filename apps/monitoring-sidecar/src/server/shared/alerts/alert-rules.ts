import {
  CanaryOutcome,
  type CanaryRunResult,
} from '#src/server/shared/canary/canary-types.js';
import type { Labels } from '#src/server/shared/metrics/metric-types.js';
import type { MetricsRegistry } from '#src/server/shared/metrics/metrics-registry.service.js';
import type { ProbeStatus } from '#src/server/shared/probes/probe-poller.service.js';

/** Alert severity, ordered so the dashboard can sort worst-first. */
export enum AlertSeverity {
  CRITICAL = 'critical',
  WARNING = 'warning',
}

/** Numeric ordering for {@link AlertSeverity}; higher is worse. */
export const SEVERITY_RANK: Readonly<Record<AlertSeverity, number>> = {
  [AlertSeverity.CRITICAL]: 2,
  [AlertSeverity.WARNING]: 1,
};

/** A firing alert. */
export interface Alert {
  /** Stable rule id. */
  id: string;
  /** The §3 failure-catalog codes this rule detects (e.g. `['N1']`). */
  failureModes: readonly string[];
  severity: AlertSeverity;
  /** One-line human summary including the observed value. */
  summary: string;
  /**
   * The §6 "likely cause + where to look" line. Every red state must name a
   * next action — this is what makes the dashboard a triage tool rather than a
   * wall of numbers.
   */
  likelyCause: string;
  /** Pipeline stage this implicates, per §1 principle 2. */
  stage: PipelineStage;
  value: number;
  threshold: number;
}

/** The six triage stages from §6. A red alert must name exactly one. */
export enum PipelineStage {
  CAPTURE = 'capture',
  UPLINK = 'uplink',
  NODE = 'node',
  TRANSCRIPTION = 'transcription',
  FANOUT = 'fanout',
  CONTROL_PLANE = 'control-plane',
}

/** Everything a rule can inspect. */
export interface AlertContext {
  metrics: MetricsRegistry;
  probes: readonly ProbeStatus[];
  /** Most recent synthetic canary probe; null when it has never run. */
  canary: CanaryRunResult | null;
  nowMs: number;
  thresholds: AlertThresholds;
}

/**
 * Tunable thresholds. Defaults come from §4; the plan is explicit that every
 * threshold must be configurable rather than baked in, because the right value
 * is deployment-specific.
 */
export interface AlertThresholds {
  /** Upstream reconnects within the window before N1 fires. */
  upstreamChurnCount: number;
  /** Window over which churn and error rates are counted. */
  rateWindowMs: number;
  /** Decode drops within the window before U2/S4 fires. */
  decodeDropCount: number;
  /** Buffer overflows within the window before T2 fires. */
  bufferOverflowCount: number;
  /** p95 real-time factor at or above which T1 fires (1.0 = realtime). */
  rtfP95: number;
  /**
   * Mean real-time factor over `rateWindowMs` — the duty ratio — at or above
   * which the T1 early warning fires. Below {@link rtfP95} on purpose: it warns
   * while the provider is still keeping up, where the p95 critical is the outage.
   */
  asrDutyRatio: number;
  /** Minimum RTF observations in the window before that mean is trusted. */
  asrDutyRatioMinJobs: number;
  /**
   * Share of a provider's scheduled job periods that may be dropped over
   * `rateWindowMs` before the T1 tail warning fires. A dropped period is one in
   * which no pass ran at all because the previous pass overran it.
   */
  asrDroppedPeriodRatio: number;
  /**
   * Reported p99 RTF at or above which the tail warning fires **when the
   * provider does not report dropped periods**. Its own threshold rather than
   * the 1.0 realtime line, because passes exceeding realtime are routine: see
   * {@link asrDroppedPeriodRatio} for the measurements.
   */
  asrTailP99Rtf: number;
  /**
   * Minimum RTF observations in the window before that share — or the reported
   * p99 RTF standing in for it — is trusted. Higher than
   * {@link asrDutyRatioMinJobs} because a p99 is only a p99 given enough
   * samples; see {@link transcriptionTailOverrunRule}.
   */
  asrTailMinJobs: number;
  /** Consecutive failed polls before a probe is called down. */
  probeFailureThreshold: number;
  /** Fraction of WS closes that are auth rejections before S2 fires. */
  authFailureRatio: number;
  /** Minimum auth attempts (or WS closes) before the auth ratio is meaningful. */
  authFailureMinSamples: number;
  /** Share of latency samples with a negative e2e time before S5 fires. */
  clockSkewRatio: number;
  /** Minimum latency samples before the skew ratio is meaningful. */
  clockSkewMinSamples: number;
  /** Pending-chunk evictions within the window before N3 fires. */
  pendingChunkEvictionCount: number;
  /** Canary time-to-first-transcript above which the latency alert fires. */
  canaryFirstTranscriptMs: number;
  /** Canary word recall below which the accuracy alert fires. */
  canaryMinRecall: number;
  /** Canary repetition ratio above which the hallucination alert fires. */
  canaryMaxRepetitionRatio: number;
}

export const DEFAULT_THRESHOLDS: AlertThresholds = {
  upstreamChurnCount: 3,
  rateWindowMs: 120_000,
  decodeDropCount: 10,
  bufferOverflowCount: 5,
  // 2.0, raised from the 1.0 realtime line after live verification showed 1.0
  // firing this CRITICAL on a **healthy** single session. Measured on an RTX
  // 5070 Ti (whisper `turbo`, 500 ms period, 30 s buffer): healthy p95 RTF
  // 0.96-1.28 across runs, p99 2.17, while captions arrived normally and the
  // service dropped ~11% of its periods absorbing the long-buffer tail.
  //
  // 1.0 looked principled - a pass at RTF 1.0 took longer than the period that
  // scheduled it - and that is exactly why it misled: passes exceeding realtime
  // are routine here, because cost tracks the unfinalized buffer and a full 30 s
  // buffer costs ~680 ms against a 500 ms period. "The worst 5% of passes
  // overran" is this design working, not an outage.
  //
  // 2.0 clears the worst healthy observation by 1.56x. It is a stopgap: the exact
  // signal is now `asr_dropped_periods_total`, and re-keying this CRITICAL onto a
  // high drop share (measured: 11% healthy, 26% at 3 sessions, 66% at 6) would
  // beat any p95 bar. That is a bigger change than a threshold and is recorded in
  // NEXTSTEPS-CPU-Whisper.md instead.
  rtfP95: 2.0,
  // 45% of the period budget, set from a measured healthy baseline rather than
  // guessed. 42 minutes of `npm run asr:load` against a live RTX 5070 Ti stack
  // (whisper `turbo`, cuda, 500 ms period, 30 s buffer, num_workers 1) put
  // healthy single-session operation at **0.28** on the speech-sparse fixture
  // and **0.33** on a speech-dense one, and the worst of 388 rolling 120 s
  // windows anywhere in that capture at **0.355**. So 0.45 clears the measured
  // worst by 27% with zero false alarms, and also clears the noisiest 30 s
  // transient seen (0.440, a session-onset ramp) in case the window is ever
  // shortened.
  //
  // The first value here was 0.8, which the same capture showed is not an early
  // warning at all: at run A's 0.526 s of audio per job it needs mean execution
  // to reach 421 ms against the measured 144 ms — a 2.9x per-pass regression, by
  // which point the provider is at 80% of realtime and this is the outage rather
  // than the hour before it. 0.45 catches ~1.6x. The windowed mean is a very
  // low-noise statistic (sd <= 0.012 within every run), so tightening the
  // threshold costs nothing in flapping and does not change detection latency,
  // which is the 120 s window either way. 0.5 is the conservative pick for
  // workloads denser than the fixtures; below 0.4 the margin over measured
  // healthy operation is too thin.
  //
  // **This default is GPU-calibrated and a CPU deployment must raise it.**
  // Measured healthy, keeping-up CPU configurations: `base`/4 threads 0.173,
  // `small`/8 0.319, and **`small`/4 - what the CPU template ships - 0.471**,
  // with speech-dense audio pushing `base` to 0.540 and `small`/8 to 0.745. So
  // the shipped CPU template trips this rule in normal working operation. The
  // rule is not wrong; one threshold cannot serve hardware an order of magnitude
  // apart. The wiki's "Transcription on CPU-Only Hardware" page carries the
  // re-baselining override.
  asrDutyRatio: 0.45,
  // ~10 s of a single stream at a 500 ms period, and at least a couple of poll
  // cycles. Low enough that any real load clears it by two orders of magnitude
  // (a 120 s window is ~240 observations per stream), high enough that a
  // provider which has served a handful of jobs cannot produce an alert.
  asrDutyRatioMinJobs: 20,
  // 25% of scheduled periods dropped, **measured**. This started at 1% on the
  // reasoning that a dropped period is a lost caption update rather than a
  // tolerance, so a healthy stack should drop none. Live verification demolished
  // that premise: dropping periods is how this provider self-throttles, not a
  // fault.
  //
  // Measured on an RTX 5070 Ti (whisper `turbo`, cuda, 500 ms period, 30 s
  // buffer, num_workers 1), share of scheduled periods that ran no pass:
  //
  //   1 session   11.3%   (212 passes, 27 dropped) — captions perfectly fine
  //   3 sessions  26.4%   (395 passes, 142 dropped)
  //   6 sessions  66.3%   (353 passes, 695 dropped)
  //
  // The reason a *healthy* session drops periods at all: cost tracks the
  // unfinalized buffer, and a full 30 s buffer costs ~680 ms against the 500 ms
  // period, so the long-buffer tail overruns by design and the pool absorbs it
  // by skipping. 1% would have fired continuously on a stack with nothing wrong.
  //
  // 25% is 2.2x the measured healthy single-session share and sits at the
  // 3-session point, where transcripts per 1000 chunks had already fallen ~19%.
  // A denser workload raises the healthy floor (a speech-dense fixture measured
  // 18% higher per-pass cost), so a deployment whose single-session share exceeds
  // ~15% should raise this rather than tolerate the noise. **This is the metric
  // to trust for saturation** — unlike mean RTF, it rose monotonically through
  // the same sweep where the mean fell.
  asrDroppedPeriodRatio: 0.25,
  // 3.0, from the same capture: a healthy single session measured p99 RTF 2.17
  // while dropping 11% of periods and captioning correctly. The fallback was 1.0
  // — the realtime line — which is the *definition* of an overrunning pass and
  // therefore looked principled, but a p99 at 1.0 only says the worst 1% of
  // passes overran, which is routine here. 3.0 clears the one healthy
  // observation by 1.4x.
  //
  // **Thinner evidence than the ratio above**: one healthy p99, and no p99 from a
  // degraded provider, because the counter path made that measurement
  // unnecessary for the primary signal. This is the fallback for a
  // transcription-service too old to report drops, so it governs a shrinking set
  // of deployments; prefer upgrading the service to tuning this.
  asrTailP99Rtf: 3.0,
  // 100 observations, five times `asrDutyRatioMinJobs`, for two reasons that
  // land on the same number.
  //
  // A reported p99 is only a percentile given samples: at 100 it is the
  // second-worst pass, at 24 (a 120 s window at lumen_granite's 3000 ms period)
  // it *is* the single worst pass, and a rule on that flaps on one slow
  // inference. And on the counter path 100 is what stops a 1% threshold firing
  // on a single dropped period: at 100 passes one drop is 0.99% and does not
  // fire, two do.
  //
  // The cost is explicit: a provider whose period is long enough that
  // `rateWindowMs` holds fewer than this many passes gets no tail alert at all.
  // At the default 120 s window that is any period above ~1.2 s, which includes
  // lumen_granite. Widen ALERT_RATE_WINDOW_SEC for such a deployment rather than
  // lowering this — a floor below ~100 makes the p99 path meaningless, and the
  // two paths must stay comparable.
  asrTailMinJobs: 100,
  probeFailureThreshold: 2,
  authFailureRatio: 0.5,
  authFailureMinSamples: 5,
  // A fifth of samples arriving "before they were sent" is well past anything
  // jitter explains, and well below the ~1.0 a fully unsynced clock produces -
  // so it catches partial skew without firing on a single odd device.
  clockSkewRatio: 0.2,
  clockSkewMinSamples: 20,
  // Eviction is not routine: the map holds 2000 frames, minutes of audio at a
  // normal frame rate. A handful means correlation is already degrading.
  pendingChunkEvictionCount: 10,
  // 15 s. Generous on purpose: the whisper-streaming provider only emits after
  // it has accumulated a buffer, so a healthy first caption is seconds out.
  // Tune against a known-good baseline before tightening.
  canaryFirstTranscriptMs: 15_000,
  // Deliberately low. This is a "captions are basically wrong" tripwire, not a
  // quality bar — real ASR on real audio loses words routinely, and a strict
  // threshold here produces noise rather than signal.
  canaryMinRecall: 0.5,
  canaryMaxRepetitionRatio: 0.8,
};

/** A rule returns zero or more alerts for the current state. */
export type AlertRule = (context: AlertContext) => Alert[];

/**
 * §3 N1 — upstream WS to transcription-service flapping.
 *
 * The live `BUG.txt` failure: the session reports "running" but no captions
 * arrive because the upstream link keeps dropping and reconnecting.
 *
 * Each churn series is evaluated against its own labels rather than a fixed
 * label name, because the source changed shape in B1.1: node-server's status
 * endpoint counts churn per process, where the old log-derived counter counted
 * it per session. Matching on whatever labels a series actually carries keeps
 * this rule correct under either, and the affected rooms are still named — from
 * the per-session upstream gauge, which the endpoint reports directly.
 */
export const upstreamChurnRule: AlertRule = (ctx) => {
  const alerts: Alert[] = [];
  const window = ctx.thresholds.rateWindowMs;

  for (const { labels } of ctx.metrics.upstreamChurnTotal.entries()) {
    const count = ctx.metrics.upstreamChurnTotal.windowCount(
      labels,
      window,
      ctx.nowMs,
    );
    if (count < ctx.thresholds.upstreamChurnCount) continue;

    const sessionUid = labels['sessionUid'];
    const affected = sessionUid ?? sessionsWithUpstreamDown(ctx).join(', ');
    const scope =
      affected.length > 0 ? ` for session ${affected}` : ' across all sessions';

    alerts.push({
      id:
        sessionUid === undefined
          ? 'upstream-churn'
          : `upstream-churn:${sessionUid}`,
      failureModes: ['N1'],
      severity: AlertSeverity.CRITICAL,
      stage: PipelineStage.NODE,
      summary: `Upstream transcription link flapping${scope}: ${String(count)} reconnects in ${String(Math.round(window / 1000))}s.`,
      likelyCause:
        'Transcription upstream flapping — check session-manager 401s on session-config-stream (secret drift between SESSION_MANAGER service API key and node-server), then transcription-service availability.',
      value: count,
      threshold: ctx.thresholds.upstreamChurnCount,
    });
  }
  return alerts;
};

/**
 * Sessions whose upstream is currently not OPEN, newest label order.
 *
 * Used to name rooms in the churn alert now that the counter itself is
 * process-wide. A session that has already recovered by evaluation time will
 * not appear, which is why the count — not this list — is what fires the rule.
 */
function sessionsWithUpstreamDown(ctx: AlertContext): string[] {
  return ctx.metrics.nodeSessionUpstreamUp
    .entries()
    .filter(({ value }) => value === 0)
    .map(({ labels }) => labels['sessionUid'] ?? 'unknown');
}

/**
 * **The N2/S3 config-poll detector was removed in B1.2 PR 5b**, along with the
 * log-ingest pipeline that fed it. It was the last consumer of Docker log
 * ingestion, and keeping the socket mount and the whole ingest path alive for
 * one rule was not a trade worth making.
 *
 * The capability is genuinely gone, not relocated: nothing currently detects a
 * session-config-stream 401, which is the direct signature of the
 * ISSUES-To-Review.md secret cross-wiring. The N1 churn it causes is still
 * detected by `upstreamChurnRule`, so the *symptom* alerts — but the alert no
 * longer names the cause. Restoring it needs a session-manager status endpoint
 * (a future B-item), which is the same shape B1.1 and B1.2 gave node-server and
 * transcription-service.
 */

/**
 * §3 T1 — transcription not keeping up with realtime audio.
 *
 * Keyed on **true RTF** since B1.2: execution seconds per second of ingested
 * audio, measured by transcription-service itself. Before that this rule read
 * the period-utilization proxy, which saturated at the same 1.0 line but was
 * derived from a log line that carried no audio duration.
 *
 * `asrPeriodUtilization` is still collected as a secondary series and is
 * deliberately not alerted on: two alerts firing for one saturation event is
 * noise, and RTF is the one that means what it says.
 */
export const transcriptionSaturationRule: AlertRule = (ctx) => {
  const alerts: Alert[] = [];
  for (const { labels, value: rtf } of ctx.metrics.asrRtf.entries()) {
    if (labels['quantile'] !== 'p95') continue;
    if (rtf < ctx.thresholds.rtfP95) continue;

    const providerKey = labels['providerKey'] ?? 'unknown';
    alerts.push({
      id: `asr-saturation:${providerKey}`,
      failureModes: ['T1'],
      severity: AlertSeverity.CRITICAL,
      stage: PipelineStage.TRANSCRIPTION,
      summary: `Transcription for ${providerKey} is slower than realtime: p95 RTF ${rtf.toFixed(2)} (1.0 = realtime).`,
      likelyCause:
        'Transcription service is saturated — more concurrent streams than num_workers can serve, or the model fell back to CPU. Check worker count and GPU availability; latency will keep climbing until load drops.',
      value: rtf,
      threshold: ctx.thresholds.rtfP95,
    });
  }
  return alerts;
};

/**
 * §3 T1, early — the provider is spending most of its period budget on every
 * pass, which is how falling behind starts and is entirely silent.
 *
 * {@link transcriptionSaturationRule} above is the outage: p95 RTF at or past
 * the 1.0 realtime line. This is the hour before it, and it exists because
 * nothing else in the stack notices. When a job overruns `job_period_ms` the
 * worker pool does not queue or error — `worker_process.py` advances the job's
 * `period_start_ns` by whole periods in a loop until it passes now, so missed
 * periods are simply *dropped*. The effective period becomes a multiple of the
 * configured one; captions get staler while transcript counts, health checks
 * and every error counter stay clean. Measured on an RTX 5070 Ti with whisper
 * `turbo`, a full 30 s buffer costs ~680 ms against a 500 ms period — 1.36x
 * budget, invisible everywhere.
 *
 * **A mean over the alert window, not the reported p95.** The p95 was the
 * obvious candidate and is wrong twice over for a sub-1.0 tripwire. Per-job cost
 * tracks the length of the *unfinalized* buffer, which grows between
 * finalizations and is re-transcribed in full each period, so in healthy
 * operation the worst few percent of jobs sit several times above the typical
 * one: a p95 pinned at 0.8 would fire on a provider whose real duty cycle is
 * 0.3. (A second reason applied when this rule was written: the reported p95 came
 * from a ring with no time-based expiry, so a gauge-only rule could never clear
 * after a heavy session ended. That ring now expires by age, so the staleness
 * argument no longer holds — the burstiness one above is the reason this rule
 * uses a mean.) The windowed mean has neither problem, and it makes
 * "sustained" structural rather
 * than bolted on — it is an average over `rateWindowMs` (120 s ≈ 240 job
 * periods), which no single spiky period can move. There is no cross-poll
 * hysteresis mechanism in this subsystem to reuse, and this rule does not need
 * one.
 *
 * `asrDutyRatioJobsTotal` in the window doubles as the floor, the same
 * minimum-samples guard {@link authFailureRule} and {@link clockSkewRule} use:
 * under it the mean is a handful of jobs, and zero means the provider is idle
 * rather than healthy.
 *
 * **What this rule cannot see: concurrency saturation of the shared worker.**
 * Do not read a quiet duty ratio as "transcription is fine". RTF's denominator
 * is the audio ingested *by that job*, and an overrun period is dropped whole,
 * so as sessions pile onto one worker the audio each pass swallows grows while
 * per-pass cost grows sublinearly (fixed model overhead amortises over a longer
 * buffer). Duty ratio therefore *falls* as the service saturates. Measured on a
 * live stack at 1/2/3/5/8 concurrent sessions: mean RTF 0.277 -> 0.256 -> 0.229
 * -> 0.194 -> 0.139 while the worker went 26% -> 94.5% busy and transcripts per
 * 1000 chunks collapsed 190 -> 48. At 8 sessions captions were badly behind and
 * this rule was not merely silent, it was moving *further* from firing. The
 * algebra: worker busy ~= N x mean RTF, so a shared worker saturates at
 * RTF = 1/N — 1.0 at one session, 0.125 at eight.
 *
 * So this rule covers the *per-pass cost regression* mechanism (a slower model, a
 * CPU fallback, buffers that stop shortening), where one session's RTF rises
 * directly and RTF is the right metric. The saturation mechanism needs a metric
 * with the right slope, and {@link transcriptionTailOverrunRule} below now
 * supplies one: dropped periods are counted, not inferred from RTF, so they rise
 * with concurrency instead of falling with it. Note the handoff runs in this
 * direction — a provider whose duty ratio *falls* out of this rule's band while
 * dropping periods lands there rather than in silence. Still unwatched by any
 * rule: the worker busy fraction itself, `asrExecutionMs.sum` over elapsed time,
 * which measured monotonically upward (26/50/66/88/94.5%) through exactly that
 * sweep and is the one signal that attributes saturation to the pool rather than
 * to a provider.
 *
 * **`buffer_overflow_seconds` is corroboration in the message, not a
 * condition.** It has its own rule already ({@link bufferOverflowRule}, T2),
 * and it is a *consequence* — audio force-finalized because the buffer hit
 * `max_buffer_len_sec`. Requiring it would blind this rule to the common case:
 * VAD gating and finalization usually keep the buffer well short of the cap, so
 * a provider can burn its entire period budget and overflow nothing. Reporting
 * it when it is non-zero is still worth it, because the two travel together and
 * it tells the operator whether audio is already being lost.
 */
export const transcriptionFallingBehindRule: AlertRule = (ctx) => {
  const window = ctx.thresholds.rateWindowMs;
  const windowSec = String(Math.round(window / 1000));
  const alerts: Alert[] = [];

  // Series are enumerated from the counter rather than from a fixed label name,
  // as `upstreamChurnRule` does: `{service, providerKey}` is what the poller
  // writes, and matching on whatever a series carries keeps the rule correct if
  // a second transcription service is ever polled.
  for (const { labels } of ctx.metrics.asrDutyRatioJobsTotal.entries()) {
    const jobs = ctx.metrics.asrDutyRatioJobsTotal.windowCount(
      labels,
      window,
      ctx.nowMs,
    );
    if (jobs < ctx.thresholds.asrDutyRatioMinJobs) continue;

    const ratio =
      ctx.metrics.asrDutyRatioSumTotal.windowCount(labels, window, ctx.nowMs) /
      jobs;
    if (ratio < ctx.thresholds.asrDutyRatio) continue;

    // Same `{service, providerKey}` label set, so this matches the overflow
    // series for exactly this provider.
    const overflowSeconds =
      ctx.metrics.asrBufferOverflowSecondsTotal.windowCount(
        labels,
        window,
        ctx.nowMs,
      );
    const overflowNote =
      overflowSeconds > 0
        ? `; ${overflowSeconds.toFixed(1)}s of audio already force-finalized`
        : '';

    const providerKey = labels['providerKey'] ?? 'unknown';
    alerts.push({
      id: `asr-falling-behind:${providerKey}`,
      failureModes: ['T1'],
      // A warning, not critical: captions are still arriving. Escalating at 1.0
      // would double-report the event `transcriptionSaturationRule` already
      // owns at that line.
      severity: AlertSeverity.WARNING,
      stage: PipelineStage.TRANSCRIPTION,
      summary: `Transcription for ${providerKey} is using ${String(Math.round(ratio * 100))}% of its realtime budget (mean RTF ${ratio.toFixed(2)} over ${windowSec}s, threshold ${ctx.thresholds.asrDutyRatio.toFixed(2)}, ${String(Math.round(jobs))} jobs)${overflowNote}.`,
      likelyCause: `${providerKey} cannot comfortably keep up: each pass costs ${ratio.toFixed(2)}s of compute per second of audio it ingests, and a period the job overruns is dropped rather than queued — so the only symptom is captions falling further behind while every counter and probe stays green. The levers are provider config, not capacity: raise job_period_ms (fewer, larger passes), lower max_buffer_len_sec (each pass re-transcribes the whole unfinalized buffer, so cost tracks its length), or run a smaller model. Adding workers or CPU will not help — one stream is one job, and its passes run one at a time.`,
      value: ratio,
      threshold: ctx.thresholds.asrDutyRatio,
    });
  }
  return alerts;
};

/**
 * §3 T1, the tail — a provider whose *typical* pass is comfortable but whose
 * expensive passes overrun their period, so periods are being dropped while
 * every windowed average still looks fine.
 *
 * This is the band between the two rules above, and it is a real place to be
 * rather than a theoretical gap. Per-pass cost tracks the length of the
 * unfinalized buffer, which grows between finalizations and is re-transcribed in
 * full every period, so a healthy provider's distribution is wide by
 * construction: measured sub-job spread on a single session was p50 0.235 / p95
 * 0.653 / max 0.840, and a full 30 s buffer costs ~680 ms against the CUDA
 * config's 500 ms period. A provider can therefore sit at a 0.24 median — nowhere
 * near {@link transcriptionFallingBehindRule}'s 0.45 mean, let alone
 * {@link transcriptionSaturationRule}'s p95 1.0 — and still drop a period every
 * time its buffer gets long.
 *
 * **Two signals, preferred in order, because one of them is exact.**
 *
 * 1. `asrDroppedPeriodsTotal` — the count of periods in which no pass ran,
 *    reported by transcription-service, which is the only thing that can see it
 *    (the worker pool advances `period_start_ns` past the periods it missed; no
 *    error, no queue, no log). Expressed as a share of scheduled periods —
 *    `drops / (drops + passes)` — rather than a raw rate, so the threshold does
 *    not have to be restated per `job_period_ms`, and so the first poll after a
 *    sidecar restart (which folds a service's whole lifetime total as one delta)
 *    reads as a lifetime average rather than as a window's worth of drops.
 * 2. `asrRtf{quantile=p99} >= 1.0` — the fallback, and not a hypothetical one:
 *    during a rolling upgrade this sidecar polls a transcription-service that
 *    predates the counter, and the p99 gauge has been on the wire since B1.2.
 *    Same prefer-reported-then-fall-back shape the per-provider job-period work
 *    in this file established, except that the fallback here is a different
 *    metric rather than a configured value. It is strictly worse — a percentile
 *    pinned to a fixed 1% grid,
 *    computed over the far end's own ring, telling you nothing about how far past
 *    the line those passes went — which is why it is second and why
 *    `asrDroppedPeriodsSupported` exists to tell "not reported" from "reported
 *    zero". Without that gauge a healthy new service (empty counter array, no
 *    series) would be indistinguishable from an old one and would silently fall
 *    back.
 *
 * **Why not an RTF *threshold* counter, which was the obvious build.** Counting
 * observations where `asr_rtf >= 1.0` inherits the exact blind spot this exists
 * to close. RTF's denominator is the audio a pass ingested, and a dropped period
 * leaves that audio for the next pass, so RTF falls as drops accumulate: measured
 * at 1/2/3/5/8 concurrent sessions on one worker, mean RTF went 0.277 -> 0.256 ->
 * 0.229 -> 0.194 -> 0.139 while the worker went 26% -> 94.5% busy and transcripts
 * per 1000 chunks collapsed 190 -> 48. At eight sessions periods were certainly
 * being dropped and RTF read 0.139. The scheduler's own skipped iterations have no
 * such slope, which is why the counter counts those.
 *
 * **Suppression, so this cannot be the third alert for one event.**
 *
 * - Silent when `asrRtf{p95} >= rtfP95`, which is
 *   {@link transcriptionSaturationRule}'s CRITICAL. Percentiles are monotone, so
 *   p95 >= 1.0 implies p99 >= 1.0 and the fallback path would *always* co-fire;
 *   and on the counter path a p95 at realtime means at least 5% of passes overrun,
 *   which is the outage the critical already owns and names.
 * - Silent when {@link transcriptionFallingBehindRule}'s mean is over its
 *   threshold. This is a judgement, not a mechanical implication: both are
 *   WARNING, both are `stage: transcription`, both name the same provider, and
 *   both prescribe the same three levers, so a second card adds a line of prose
 *   and no decision. This rule owns exactly the band the mean rule does not —
 *   mean healthy, tail overrunning — which is what it was built for. The
 *   dropped-period count stays visible as a metric either way, and the mean
 *   rule's own text already explains that overrun periods are dropped. Note the
 *   two hand off in the right direction: severe dropping *lowers* mean RTF (see
 *   above), so a provider that falls out of the mean rule's band lands in this
 *   one rather than in silence.
 *
 * **Floored on sample count**, like {@link authFailureRule} and
 * {@link clockSkewRule}, and higher than the mean rule's floor: see
 * {@link AlertThresholds.asrTailMinJobs} for why 100 and what it costs a
 * long-period provider.
 *
 * The levers are deliberately not the critical's. One stream is one job and its
 * passes run one at a time, so neither workers nor CPU shortens a pass that is
 * already alone on the GPU. What moves this number is `max_buffer_len_sec` (cost
 * tracks buffer length, and this rule fires on the long-buffer tail specifically),
 * `job_period_ms` (a longer period is a bigger budget), and model size.
 */
export const transcriptionTailOverrunRule: AlertRule = (ctx) => {
  const window = ctx.thresholds.rateWindowMs;
  const windowSec = String(Math.round(window / 1000));
  const alerts: Alert[] = [];

  // Enumerated from the RTF-observation counter rather than a fixed label name,
  // as the sibling rules do: it is the one series present on both signal paths,
  // and it is this rule's sample floor either way.
  for (const { labels } of ctx.metrics.asrDutyRatioJobsTotal.entries()) {
    const passes = ctx.metrics.asrDutyRatioJobsTotal.windowCount(
      labels,
      window,
      ctx.nowMs,
    );
    if (passes < ctx.thresholds.asrTailMinJobs) continue;

    const providerKey = labels['providerKey'] ?? 'unknown';
    if (suppressedByColderRule(ctx, labels, providerKey, passes)) continue;

    const reported =
      (ctx.metrics.asrDroppedPeriodsSupported.get({
        service: labels['service'] ?? '',
      }) ?? 0) === 1;

    const evidence = reported
      ? droppedPeriodEvidence(ctx, labels, passes, windowSec)
      : tailRtfEvidence(ctx, labels, providerKey, windowSec);
    if (evidence === null) continue;

    alerts.push({
      id: `asr-tail-overrun:${providerKey}`,
      failureModes: ['T1'],
      // A warning: the median pass is still comfortable and captions are still
      // arriving, just with periods missing from them. The 1.0 line and its
      // CRITICAL belong to `transcriptionSaturationRule`, which this defers to.
      severity: AlertSeverity.WARNING,
      stage: PipelineStage.TRANSCRIPTION,
      summary: `Transcription for ${providerKey} is overrunning its period on its slowest passes: ${evidence.summary}`,
      likelyCause: `${providerKey}'s expensive passes cost more than one job period, and a period a pass overruns is dropped rather than queued — so captions lose updates while the mean stays healthy and no counter or probe goes red. Cost tracks the length of the unfinalized buffer, which is re-transcribed in full every period, so the tail is the long-buffer case: lower max_buffer_len_sec to cap it, raise job_period_ms to widen the budget, or run a smaller model. More workers or CPU will not help — one stream is one job and its passes run one at a time.`,
      value: evidence.value,
      threshold: evidence.threshold,
    });
  }
  return alerts;
};

/** What fired the tail rule, as the alert needs to report it. */
interface TailEvidence {
  summary: string;
  value: number;
  threshold: number;
}

/**
 * True when a rule that already owns this provider's saturation is firing, so
 * the tail warning would be a duplicate card for one event.
 *
 * Both conditions are restated here rather than shared with the rules that own
 * them, because a rule taking another rule's output as input would make
 * evaluation order significant — {@link DEFAULT_RULES} is deliberately an
 * unordered list of independent predicates.
 */
function suppressedByColderRule(
  ctx: AlertContext,
  labels: Labels,
  providerKey: string,
  passes: number,
): boolean {
  // p95 >= 1.0 is the CRITICAL. It implies p99 >= 1.0, so without this the
  // fallback path would double-report every saturation event.
  const p95 = ctx.metrics.asrRtf.get({
    service: labels['service'] ?? '',
    providerKey,
    quantile: 'p95',
  });
  if (p95 !== undefined && p95 >= ctx.thresholds.rtfP95) return true;

  // The mean-based WARNING. `passes` already cleared this rule's floor, which is
  // the higher of the two, so the mean rule's own floor is necessarily met and
  // this comparison alone decides whether it is firing.
  const meanRtf =
    ctx.metrics.asrDutyRatioSumTotal.windowCount(
      labels,
      ctx.thresholds.rateWindowMs,
      ctx.nowMs,
    ) / passes;
  return meanRtf >= ctx.thresholds.asrDutyRatio;
}

/**
 * The preferred signal: the share of scheduled periods in which no pass ran.
 *
 * `drops + passes` is the denominator because a period either ran or was
 * dropped, which makes the figure a share rather than a rate and keeps one
 * threshold valid across every `job_period_ms`. Returns null when the share is
 * under the threshold, including the common case of no drops at all.
 */
function droppedPeriodEvidence(
  ctx: AlertContext,
  labels: Labels,
  passes: number,
  windowSec: string,
): TailEvidence | null {
  const drops = ctx.metrics.asrDroppedPeriodsTotal.windowCount(
    labels,
    ctx.thresholds.rateWindowMs,
    ctx.nowMs,
  );
  const share = drops / (drops + passes);
  if (share < ctx.thresholds.asrDroppedPeriodRatio) return null;

  return {
    summary: `${String(Math.round(drops))} of ${String(Math.round(drops + passes))} job periods ran no pass at all in ${windowSec}s (${(share * 100).toFixed(1)}%, threshold ${(ctx.thresholds.asrDroppedPeriodRatio * 100).toFixed(1)}%).`,
    value: share,
    threshold: ctx.thresholds.asrDroppedPeriodRatio,
  };
}

/**
 * The fallback for a transcription-service too old to count dropped periods:
 * the reported p99 RTF at or past the realtime line, meaning the worst 1% of
 * passes took longer than the audio they consumed — and therefore longer than
 * the period that scheduled them.
 *
 * Weaker than the counter in three ways worth keeping in mind while reading an
 * alert that fired on it: the 1% grid is fixed, so it cannot distinguish 1% of
 * passes overrunning from 4%; it says nothing about how far past the line those
 * passes went; and it is computed over transcription-service's own retained ring
 * rather than over `rateWindowMs`. The sample floor is applied to the windowed
 * pass count instead, which is a fair proxy only because that ring expires by age
 * on the same 120 s scale.
 */
function tailRtfEvidence(
  ctx: AlertContext,
  labels: Labels,
  providerKey: string,
  windowSec: string,
): TailEvidence | null {
  const p99 = ctx.metrics.asrRtf.get({
    service: labels['service'] ?? '',
    providerKey,
    quantile: 'p99',
  });
  if (p99 === undefined || p99 < ctx.thresholds.asrTailP99Rtf) return null;

  return {
    summary: `p99 RTF ${p99.toFixed(2)} over the last ${windowSec}s of passes (1.0 = the pass took as long as the audio it consumed). This service does not report dropped periods, so the exact count is unavailable.`,
    value: p99,
    threshold: ctx.thresholds.asrTailP99Rtf,
  };
}

/**
 * §3 T9 — a transcription worker process has died.
 *
 * The quietest failure in the stack. Nothing inside the worker pool notices a
 * worker exiting after startup: the result-queue poll loop times out forever,
 * and every job already registered to that worker never returns and never
 * raises. Sessions pinned to its context simply stop producing captions while
 * the service keeps answering liveness. B1.3 gave readiness teeth for this;
 * this rule names the worker.
 */
export const workerDeadRule: AlertRule = (ctx) => {
  const dead = ctx.metrics.asrWorkerAlive
    .entries()
    .filter(({ value }) => value === 0)
    .map(({ labels }) => labels['workerId'] ?? 'unknown');
  if (dead.length === 0) return [];

  return [
    {
      id: 'asr-worker-dead',
      failureModes: ['T9'],
      severity: AlertSeverity.CRITICAL,
      stage: PipelineStage.TRANSCRIPTION,
      summary: `${String(dead.length)} transcription worker process(es) have exited (worker ${dead.join(', ')}).`,
      likelyCause:
        'A worker died after startup — most often a model-load crash, a GPU fault or an OOM kill. Jobs already registered to it will never complete, so any room pinned to its context has silently stopped transcribing. Restart transcription-service; check dmesg/GPU logs for the cause.',
      value: dead.length,
      threshold: 0,
    },
  ];
};

/**
 * §3 T2 — per-job backlog overflow producing choppy captions.
 *
 * Two shapes of the same pressure: audio cut *early* (force-finalized, so it is
 * still transcribed, just badly) and audio cut *entirely* (dropped because the
 * buffer had no room for the batch at all).
 *
 * The second one was `asr-audio-too-fast`, CRITICAL on the UPLINK stage,
 * telling the operator to "check for a misbehaving or replaying client". All
 * three of those were wrong. The check behind it has no clock: it fires when a
 * single decode batch exceeds the buffer's free space, and a batch is whatever
 * arrived since the worker last reached that job — `client_rate ×
 * scheduling_gap`, with the gap owned by the service. So it belongs to
 * TRANSCRIPTION, not UPLINK: it was firing on our own stalls, and pointing the
 * operator at the one component that was behaving.
 *
 * It is also no longer CRITICAL, because it no longer disconnects anyone. The
 * job used to raise, and any job exception deregisters the job, so a stall took
 * every saturated session down at once and blamed each of them for it; the tail
 * is now dropped and the session continues. What is left is degradation of the
 * same kind as the force-finalize case beside it — WARNING, and the T1 rules
 * still own the CRITICAL for the saturation that causes it.
 *
 * Threshold stays at zero rather than picking up a tolerance knob: dropped
 * audio is caption loss with nothing transcribed in its place, so a healthy
 * deployment reads zero and any non-zero window is worth a card.
 */
export const bufferOverflowRule: AlertRule = (ctx) => {
  const window = ctx.thresholds.rateWindowMs;
  const overflow = ctx.metrics.asrBufferOverflowTotal.windowCount(
    {},
    window,
    ctx.nowMs,
  );
  const droppedBatches = ctx.metrics.asrAudioDroppedBufferFullTotal.windowCount(
    {},
    window,
    ctx.nowMs,
  );
  const droppedSeconds =
    ctx.metrics.asrAudioDroppedBufferFullSecondsTotal.windowCount(
      {},
      window,
      ctx.nowMs,
    );
  const alerts: Alert[] = [];

  if (overflow >= ctx.thresholds.bufferOverflowCount) {
    alerts.push({
      id: 'asr-buffer-overflow',
      failureModes: ['T2'],
      severity: AlertSeverity.WARNING,
      stage: PipelineStage.TRANSCRIPTION,
      summary: `${String(overflow)} transcription buffers force-finalized in ${String(Math.round(window / 1000))}s.`,
      likelyCause:
        'Audio is arriving faster than it can be transcribed, so buffers fill and are cut early — captions will be choppy or truncated. Usually downstream of T1 saturation.',
      value: overflow,
      threshold: ctx.thresholds.bufferOverflowCount,
    });
  }

  if (droppedBatches > 0) {
    alerts.push({
      id: 'asr-audio-dropped-buffer-full',
      failureModes: ['T2'],
      severity: AlertSeverity.WARNING,
      stage: PipelineStage.TRANSCRIPTION,
      summary: `${droppedSeconds.toFixed(1)}s of audio dropped across ${String(droppedBatches)} decode batch(es) the ASR buffer had no room for, in ${String(Math.round(window / 1000))}s.`,
      likelyCause:
        'The service did not get back to these jobs before more audio piled up than their buffers hold, so the excess was dropped — those seconds produce no captions at all. A batch is everything that arrived since the worker last reached the job, so its size is set by the scheduling gap as much as by the arrival rate; expect this downstream of T1 saturation and read it alongside dropped periods and RTF. A source genuinely sending faster than realtime would have to reach roughly 6x (CPU) or 60x (GPU) to cause this by itself.',
      value: droppedBatches,
      threshold: 0,
    });
  }

  return alerts;
};

/** §3 U2 / S4 — SAFP decode drops, the version-skew signature. */
export const decodeDropRule: AlertRule = (ctx) => {
  const window = ctx.thresholds.rateWindowMs;
  const count = ctx.metrics.safpDecodeDropsTotal.windowCount(
    {},
    window,
    ctx.nowMs,
  );
  if (count < ctx.thresholds.decodeDropCount) return [];

  return [
    {
      id: 'safp-decode-drops',
      failureModes: ['U2', 'S4'],
      severity: AlertSeverity.WARNING,
      stage: PipelineStage.UPLINK,
      summary: `${String(count)} malformed SAFP frames dropped in ${String(Math.round(window / 1000))}s.`,
      likelyCause:
        'Audio frames are being silently discarded — captions will stop with no visible error. Most often a partial deploy leaving the sender and receiver on different audio-frame-protocol versions; compare build stamps across services.',
      value: count,
      threshold: ctx.thresholds.decodeDropCount,
    },
  ];
};

/**
 * §3 S2 — session token signing key mismatch.
 *
 * Detected as a high *ratio* of rejected auth attempts rather than a raw count,
 * because a handful of expired tokens is normal background noise while
 * "essentially every connection is rejected" is a config failure.
 *
 * The denominator is auth *attempts* (failures + successes) when node-server's
 * status endpoint is supplying them, which is what the plan specifies. Before
 * B1.1 that number did not exist anywhere and the rule had to divide by all
 * WebSocket closes — a denominator inflated by every normal end-of-session
 * close, which pushes the ratio down and makes real drift look milder than it
 * is. The close-based form is kept as a fallback for a deployment with status
 * polling disabled, where it is the only thing available.
 */
export const authFailureRule: AlertRule = (ctx) => {
  const window = ctx.thresholds.rateWindowMs;
  const attempts =
    ctx.metrics.nodeAuthFailuresTotal.windowCount({}, window, ctx.nowMs) +
    ctx.metrics.nodeAuthSuccessTotal.windowCount({}, window, ctx.nowMs);

  const { authFailures, total } =
    attempts > 0
      ? {
          authFailures: ctx.metrics.nodeAuthFailuresTotal.windowCount(
            {},
            window,
            ctx.nowMs,
          ),
          total: attempts,
        }
      : closeDerivedAuthCounts(ctx, window);

  if (total < ctx.thresholds.authFailureMinSamples) return [];

  const ratio = authFailures / total;
  if (ratio < ctx.thresholds.authFailureRatio) return [];

  return [
    {
      id: 'auth-failure-ratio',
      failureModes: ['S2', 'U3'],
      severity: AlertSeverity.CRITICAL,
      stage: PipelineStage.CONTROL_PLANE,
      summary: `${String(Math.round(ratio * 100))}% of authentication attempts are being rejected (${String(authFailures)}/${String(total)}).`,
      likelyCause:
        'Nearly every token is being rejected — SESSION_TOKEN_SIGNING_KEY almost certainly differs between session-manager and node-server. Compare the signing key env on both.',
      value: ratio,
      threshold: ctx.thresholds.authFailureRatio,
    },
  ];
};

/**
 * The node-server status poll is failing, so the metrics sourced from it are
 * stale.
 *
 * This rule exists because of the B1.1 cut-over. WebSocket closes, upstream
 * churn, upstream state and node-side decode drops used to be inferred from log
 * text; they now come only from the status endpoint. An unreachable node-server
 * is already covered by the probe poller — but a node-server that is perfectly
 * healthy and simply *rejecting the sidecar's service key* is not: probes stay
 * green, and four metrics quietly report nothing forever. Without this rule
 * that state is indistinguishable from a quiet, healthy deployment.
 */
export const statusPollUnavailableRule: AlertRule = (ctx) => {
  const alerts: Alert[] = [];
  for (const { labels, value } of ctx.metrics.serviceStatusUp.entries()) {
    if (value === 1) continue;
    const service = labels['service'] ?? 'unknown';

    const reasons = ctx.metrics.serviceStatusPollErrorsTotal
      .entries()
      .filter(({ labels: l }) => l['service'] === service)
      .map(({ labels: l }) => l['reason'] ?? 'unknown');

    // Both are configuration faults that no amount of waiting fixes, and both
    // leave probes green while the metrics they feed report nothing.
    const unauthorized = reasons.includes('unauthorized');
    const notFound = reasons.includes('not-found');
    const misconfigured = unauthorized || notFound;

    let likelyCause: string;
    if (unauthorized) {
      likelyCause = `${service} rejected the sidecar's API key. Compare the key on both sides — until it matches, the metrics this endpoint feeds report nothing while every probe stays green.`;
    } else if (notFound) {
      likelyCause = `${service} has no status endpoint registered, which is what it does when its own metrics key is empty. Set the key on the service as well as on the sidecar; a key on only one side leaves the endpoint switched off.`;
    } else {
      likelyCause = `${service}'s status endpoint is not answering. Check it is reachable on the internal network (it must not be exposed through nginx) and that the probes agree about its health.`;
    }

    alerts.push({
      id: `status-poll-unavailable:${service}`,
      failureModes: ['S3'],
      severity: misconfigured ? AlertSeverity.CRITICAL : AlertSeverity.WARNING,
      stage: PipelineStage.CONTROL_PLANE,
      summary: `Cannot read ${service} status (${reasons.length === 0 ? 'unknown' : reasons.join(', ')}); the metrics it sources are stale.`,
      likelyCause,
      value: 0,
      threshold: 1,
    });
  }
  return alerts;
};

/**
 * Auth rejections and their denominator inferred from close codes.
 *
 * Only used when node-server's status endpoint is not being polled. `total`
 * counts every close, not every auth attempt, so the resulting ratio is
 * systematically low — good enough as a tripwire, which is why it survives as a
 * fallback rather than as the primary.
 */
function closeDerivedAuthCounts(
  ctx: AlertContext,
  window: number,
): { authFailures: number; total: number } {
  const authReasons = ['invalid-token', 'token-expired', 'session-mismatch'];
  let authFailures = 0;
  for (const reason of authReasons) {
    authFailures += ctx.metrics.wsCloseTotal.windowCount(
      { reason },
      window,
      ctx.nowMs,
    );
  }
  return {
    authFailures,
    total: ctx.metrics.wsCloseTotal.windowCount({}, window, ctx.nowMs),
  };
}

/**
 * §3 S5 — the source's clock is ahead of node-server's despite sync.
 *
 * A ratio, not a count: on a busy node a handful of negative end-to-end times
 * is noise, while a large share means every end-to-end latency figure on the
 * dashboard is wrong. Pipeline latency is unaffected — it uses the monotonic
 * clock — so captions are fine and only the measurement is broken, which is
 * exactly why this needs saying out loud rather than being inferred from a
 * suspiciously empty latency panel.
 */
export const clockSkewRule: AlertRule = (ctx) => {
  const window = ctx.thresholds.rateWindowMs;
  const samples = ctx.metrics.nodeLatencySamplesTotal.windowCount(
    {},
    window,
    ctx.nowMs,
  );
  if (samples < ctx.thresholds.clockSkewMinSamples) return [];

  const negative = ctx.metrics.nodeLatencyE2eNegativeTotal.windowCount(
    {},
    window,
    ctx.nowMs,
  );
  const ratio = negative / samples;
  if (ratio < ctx.thresholds.clockSkewRatio) return [];

  return [
    {
      id: 'clock-skew',
      failureModes: ['S5'],
      severity: AlertSeverity.WARNING,
      stage: PipelineStage.CAPTURE,
      summary: `${String(Math.round(ratio * 100))}% of latency samples had a negative end-to-end time (${String(negative)}/${String(samples)}).`,
      likelyCause:
        'Source clocks are ahead of node-server’s, so end-to-end latency is being discarded as implausible. Captions are unaffected and pipeline latency still reports; check NTP on the source devices and on the node-server host. Uplink delay (U4) is invisible until this is fixed.',
      value: ratio,
      threshold: ctx.thresholds.clockSkewRatio,
    },
  ];
};

/**
 * §3 N3 — the per-session pending-chunk map is overflowing.
 *
 * Eviction means an audio frame left the correlation map before its transcript
 * came back, so latency for that frame can never be computed. The captions
 * themselves are unaffected, which is what makes this worth alerting on: it
 * degrades the measurements the rest of the dashboard depends on, silently, and
 * the numbers that remain look healthy because the slow frames are the ones
 * being dropped.
 */
export const pendingChunkEvictionRule: AlertRule = (ctx) => {
  const window = ctx.thresholds.rateWindowMs;
  const count = ctx.metrics.nodePendingChunkEvictionsTotal.windowCount(
    {},
    window,
    ctx.nowMs,
  );
  if (count < ctx.thresholds.pendingChunkEvictionCount) return [];

  return [
    {
      id: 'pending-chunk-evictions',
      failureModes: ['N3'],
      severity: AlertSeverity.WARNING,
      stage: PipelineStage.NODE,
      summary: `${String(count)} audio frames evicted from latency correlation in ${String(Math.round(window / 1000))}s.`,
      likelyCause:
        'Frames are being sent upstream and never matched to a transcript, so the correlation map is overflowing — usually transcription falling far behind (T1) or a provider that stopped returning chunk ids. Latency figures are under-reporting the worst cases while this fires.',
      value: count,
      threshold: ctx.thresholds.pendingChunkEvictionCount,
    },
  ];
};

/** §3 N5 / S1 / T9 — a service probe is down. */
export const probeDownRule: AlertRule = (ctx) => {
  const alerts: Alert[] = [];
  for (const probe of ctx.probes) {
    if (probe.healthy) continue;
    if (probe.consecutiveFailures < ctx.thresholds.probeFailureThreshold) {
      continue;
    }

    const failing =
      probe.checks === null
        ? null
        : Object.entries(probe.checks)
            .filter(([, v]) => v !== 'ok')
            .map(([k]) => k);

    const cause =
      failing !== null && failing.length > 0
        ? `Dependency failing: ${failing.join(', ')}. Check that dependency before the service itself.`
        : `Service is not responding on its ${probe.probe} probe (${probe.error ?? 'unknown error'}). Check the container is running and reachable on the backend network.`;

    alerts.push({
      id: `probe-down:${probe.service}:${probe.probe}`,
      failureModes: probe.probe === 'readiness' ? ['S1', 'T9'] : ['N5'],
      severity: AlertSeverity.CRITICAL,
      stage: PipelineStage.CONTROL_PLANE,
      summary: `${probe.service} ${probe.probe} failing (${String(probe.consecutiveFailures)} consecutive).`,
      likelyCause: cause,
      value: probe.consecutiveFailures,
      threshold: ctx.thresholds.probeFailureThreshold,
    });
  }
  return alerts;
};

/**
 * §3 C6/U1/N1/N5/S1/S2 — the synthetic canary could not get captions.
 *
 * This is the one rule that speaks for the whole pipeline at once. Every other
 * rule infers health from a component's logs or probes; this one streams known
 * audio through the real public flows and reports what a viewer would actually
 * have seen. A green board with this rule firing means the inference is wrong
 * somewhere — which is precisely why it is worth having.
 */
export const canaryFailureRule: AlertRule = (ctx) => {
  const canary = ctx.canary;
  if (canary === null) return [];

  // Nothing scheduled in the canary room is not a fault. Alerting on it would
  // make the canary red every night and worthless by morning.
  if (canary.outcome === CanaryOutcome.NO_SESSION) return [];
  if (canary.outcome === CanaryOutcome.OK) return [];

  const detail: Record<CanaryOutcome, { cause: string; stage: PipelineStage }> =
    {
      [CanaryOutcome.NO_TRANSCRIPTS]: {
        cause:
          'The canary streamed audio for a full run and no caption came back. Everything upstream reported healthy, so check the transcription upstream for this session (N1 churn), then the provider itself. This is the failure users report as "captions just stopped".',
        stage: PipelineStage.TRANSCRIPTION,
      },
      [CanaryOutcome.AUTH_FAILED]: {
        cause:
          'The canary could not exchange its device token for a session token. Check session-manager health and that the canary device is still registered and assigned to the canary room; if real devices are also failing, suspect a signing-key or service-key mismatch.',
        stage: PipelineStage.CONTROL_PLANE,
      },
      [CanaryOutcome.CONNECT_FAILED]: {
        cause:
          'The canary could not open an authenticated WebSocket to node-server. Check node-server liveness and the proxy upgrade path; a 1008 close here means the token was rejected.',
        stage: PipelineStage.NODE,
      },
      [CanaryOutcome.UPSTREAM_DOWN]: {
        cause:
          'Node-server accepted the canary but never reported a transcription upstream for the session. Check transcription-service availability and the session-config-stream poll (N2) that supplies the provider config.',
        stage: PipelineStage.NODE,
      },
      [CanaryOutcome.ERROR]: {
        cause:
          'The canary itself failed unexpectedly. Check the sidecar logs before trusting this as a pipeline fault.',
        stage: PipelineStage.CONTROL_PLANE,
      },
      // Unreachable: both are returned above.
      [CanaryOutcome.OK]: { cause: '', stage: PipelineStage.TRANSCRIPTION },
      [CanaryOutcome.NO_SESSION]: {
        cause: '',
        stage: PipelineStage.CONTROL_PLANE,
      },
    };

  const { cause, stage } = detail[canary.outcome];
  return [
    {
      id: 'canary-failed',
      failureModes: ['U1', 'N1', 'N5', 'S1', 'S2'],
      severity: AlertSeverity.CRITICAL,
      stage,
      summary: `Synthetic canary failed: ${canary.outcome}${canary.error === null ? '' : ` (${canary.error})`}.`,
      likelyCause: cause,
      value: 0,
      threshold: 1,
    },
  ];
};

/**
 * Canary got captions, but late, wrong, or looping.
 *
 * Split from {@link canaryFailureRule} because these are degradations rather
 * than outages: captions are flowing, so the operator's next action is
 * different. Only evaluated on a successful run — scoring a failed run would
 * double-report the same outage as both "down" and "inaccurate".
 */
export const canaryQualityRule: AlertRule = (ctx) => {
  const canary = ctx.canary;
  if (canary?.outcome !== CanaryOutcome.OK) return [];
  const alerts: Alert[] = [];

  const ttft = canary.timeToFirstTranscriptMs;
  if (ttft !== null && ttft > ctx.thresholds.canaryFirstTranscriptMs) {
    alerts.push({
      id: 'canary-slow-first-transcript',
      failureModes: ['T1'],
      severity: AlertSeverity.WARNING,
      stage: PipelineStage.TRANSCRIPTION,
      summary: `Canary waited ${String(Math.round(ttft / 1000))}s for its first caption (threshold ${String(Math.round(ctx.thresholds.canaryFirstTranscriptMs / 1000))}s).`,
      likelyCause:
        'Captions are arriving but slowly — usually transcription saturation (T1). Check period utilization and the number of concurrent sessions against num_workers.',
      value: ttft,
      threshold: ctx.thresholds.canaryFirstTranscriptMs,
    });
  }

  if (
    canary.accuracy !== null &&
    canary.accuracy.recall < ctx.thresholds.canaryMinRecall
  ) {
    alerts.push({
      id: 'canary-low-accuracy',
      failureModes: ['T8'],
      severity: AlertSeverity.WARNING,
      stage: PipelineStage.TRANSCRIPTION,
      summary: `Canary transcript recall ${canary.accuracy.recall.toFixed(2)} against the known script (threshold ${ctx.thresholds.canaryMinRecall.toFixed(2)}).`,
      likelyCause:
        'Captions are returning but do not match the known audio — suspect a wrong or degraded model, a provider fallback, or VAD discarding speech. Compare against the baseline this fixture scores on a healthy deployment.',
      value: canary.accuracy.recall,
      threshold: ctx.thresholds.canaryMinRecall,
    });
  }

  if (
    canary.repetitionRatio !== null &&
    canary.repetitionRatio > ctx.thresholds.canaryMaxRepetitionRatio
  ) {
    alerts.push({
      id: 'canary-repetition',
      failureModes: ['T8'],
      severity: AlertSeverity.WARNING,
      stage: PipelineStage.TRANSCRIPTION,
      summary: `Canary transcript is ${String(Math.round(canary.repetitionRatio * 100))}% repeated words.`,
      likelyCause:
        'The model is looping the same phrase — the classic Whisper hallucination on thin or silent audio. Check the source audio level and the VAD configuration.',
      value: canary.repetitionRatio,
      threshold: ctx.thresholds.canaryMaxRepetitionRatio,
    });
  }

  // Clock sync failing is C6: pipeline latency still reports, but end-to-end
  // latency is permanently unavailable, so uplink problems become invisible.
  if (!canary.clockSyncEstablished) {
    alerts.push({
      id: 'canary-clock-sync',
      failureModes: ['C6'],
      severity: AlertSeverity.WARNING,
      stage: PipelineStage.CAPTURE,
      summary:
        'Canary never established a server clock offset; e2e latency is unavailable.',
      likelyCause:
        'Clock sync never converged, so end-to-end latency cannot be measured for this session — uplink delay (U4) will be invisible on the dashboard. Pipeline latency is unaffected.',
      value: 0,
      threshold: 1,
    });
  }

  return alerts;
};

/** Every rule, evaluated on each snapshot. */
export const DEFAULT_RULES: readonly AlertRule[] = [
  upstreamChurnRule,
  transcriptionSaturationRule,
  transcriptionFallingBehindRule,
  transcriptionTailOverrunRule,
  workerDeadRule,
  bufferOverflowRule,
  decodeDropRule,
  authFailureRule,
  clockSkewRule,
  pendingChunkEvictionRule,
  statusPollUnavailableRule,
  probeDownRule,
  canaryFailureRule,
  canaryQualityRule,
];
