import {
  CanaryOutcome,
  type CanaryRunResult,
} from '#src/server/shared/canary/canary-types.js';
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
   * which the T1 early warning fires. Below {@link rtfP95}'s 1.0 line on
   * purpose: at 0.8 the provider is still keeping up, but has only a fifth of a
   * period of headroom left and no signal of its own that it is losing it.
   */
  asrDutyRatio: number;
  /** Minimum RTF observations in the window before that mean is trusted. */
  asrDutyRatioMinJobs: number;
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
  rtfP95: 1.0,
  // 80% of the period budget. Measured basis: on an RTX 5070 Ti with whisper
  // `turbo`, a full 30 s buffer costs ~680 ms against the CUDA config's 500 ms
  // job period (1.36x), and the scheduler answers that by silently dropping
  // periods. 0.8 leaves roughly one period of headroom to notice in.
  asrDutyRatio: 0.8,
  // ~10 s of a single stream at a 500 ms period, and at least a couple of poll
  // cycles. Low enough that any real load clears it by two orders of magnitude
  // (a 120 s window is ~240 observations per stream), high enough that a
  // provider which has served a handful of jobs cannot produce an alert.
  asrDutyRatioMinJobs: 20,
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

/** §3 T2 — per-job backlog overflow producing choppy captions. */
export const bufferOverflowRule: AlertRule = (ctx) => {
  const window = ctx.thresholds.rateWindowMs;
  const overflow = ctx.metrics.asrBufferOverflowTotal.windowCount(
    {},
    window,
    ctx.nowMs,
  );
  const tooFast = ctx.metrics.asrAudioTooFastTotal.windowCount(
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

  if (tooFast > 0) {
    alerts.push({
      id: 'asr-audio-too-fast',
      failureModes: ['T2'],
      severity: AlertSeverity.CRITICAL,
      stage: PipelineStage.UPLINK,
      summary: `${String(tooFast)} sessions rejected for sending audio faster than realtime.`,
      likelyCause:
        'A source is pushing audio faster than realtime and was disconnected with close code 1007. Check for a misbehaving or replaying client.',
      value: tooFast,
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
