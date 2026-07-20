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
  /** session-config-stream auth failures within the window before N2 fires. */
  configPollErrorCount: number;
  /** Decode drops within the window before U2/S4 fires. */
  decodeDropCount: number;
  /** Buffer overflows within the window before T2 fires. */
  bufferOverflowCount: number;
  /** p95 period-utilization at or above which T1 fires (1.0 = saturated). */
  periodUtilizationP95: number;
  /** Consecutive failed polls before a probe is called down. */
  probeFailureThreshold: number;
  /** Fraction of WS closes that are auth rejections before S2 fires. */
  authFailureRatio: number;
  /** Minimum WS closes needed before the auth ratio is meaningful. */
  authFailureMinSamples: number;
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
  configPollErrorCount: 1,
  decodeDropCount: 10,
  bufferOverflowCount: 5,
  periodUtilizationP95: 1.0,
  probeFailureThreshold: 2,
  authFailureRatio: 0.5,
  authFailureMinSamples: 5,
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
 * §3 N2 / S3 — session-config-stream long poll rejected.
 *
 * The direct detector for the ISSUES-To-Review.md secret cross-wiring. Any
 * sustained 401 here means sessions never receive their provider config, which
 * in turn produces the N1 churn pattern — so this rule usually fires first and
 * explains the other.
 */
export const configPollErrorRule: AlertRule = (ctx) => {
  const window = ctx.thresholds.rateWindowMs;
  const count = ctx.metrics.smConfigPollErrorsTotal.windowCount(
    {},
    window,
    ctx.nowMs,
  );
  if (count < ctx.thresholds.configPollErrorCount) return [];

  return [
    {
      id: 'config-poll-errors',
      failureModes: ['N2', 'S3'],
      severity: AlertSeverity.CRITICAL,
      stage: PipelineStage.CONTROL_PLANE,
      summary: `session-config-stream rejected ${String(count)} times in ${String(Math.round(window / 1000))}s.`,
      likelyCause:
        'Service API key drift — node-server is presenting a key session-manager does not accept. Compare the service API key env on session-manager and node-server; see ISSUES-To-Review.md.',
      value: count,
      threshold: ctx.thresholds.configPollErrorCount,
    },
  ];
};

/**
 * §3 T1 — transcription falling behind the cadence that schedules it.
 *
 * Keyed on the period-utilization proxy, not true RTF; see the note on
 * `MetricsRegistry.asrPeriodUtilization`.
 */
export const transcriptionSaturationRule: AlertRule = (ctx) => {
  const alerts: Alert[] = [];
  for (const labels of ctx.metrics.asrPeriodUtilization.seriesLabels()) {
    const summary = ctx.metrics.asrPeriodUtilization.summary(labels);
    if (summary === undefined) continue;
    if (summary.p95 < ctx.thresholds.periodUtilizationP95) continue;

    const providerKey = labels['providerKey'] ?? 'unknown';
    alerts.push({
      id: `asr-saturation:${providerKey}`,
      failureModes: ['T1'],
      severity: AlertSeverity.CRITICAL,
      stage: PipelineStage.TRANSCRIPTION,
      summary: `Transcription jobs for ${providerKey} are not keeping up: p95 period utilization ${summary.p95.toFixed(2)} (1.0 = saturated).`,
      likelyCause:
        'Transcription service is saturated — more concurrent streams than num_workers can serve, or the model fell back to CPU. Check worker count and GPU availability; latency will keep climbing until load drops.',
      value: summary.p95,
      threshold: ctx.thresholds.periodUtilizationP95,
    });
  }
  return alerts;
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
 * Detected as a high *ratio* of auth-rejection closes rather than a raw count,
 * because a handful of expired tokens is normal background noise while
 * "essentially every connection is rejected" is a config failure.
 */
export const authFailureRule: AlertRule = (ctx) => {
  const window = ctx.thresholds.rateWindowMs;
  const total = ctx.metrics.wsCloseTotal.windowCount({}, window, ctx.nowMs);
  if (total < ctx.thresholds.authFailureMinSamples) return [];

  const authReasons = ['invalid-token', 'token-expired', 'session-mismatch'];
  let authFailures = 0;
  for (const reason of authReasons) {
    authFailures += ctx.metrics.wsCloseTotal.windowCount(
      { reason },
      window,
      ctx.nowMs,
    );
  }

  const ratio = authFailures / total;
  if (ratio < ctx.thresholds.authFailureRatio) return [];

  return [
    {
      id: 'auth-failure-ratio',
      failureModes: ['S2', 'U3'],
      severity: AlertSeverity.CRITICAL,
      stage: PipelineStage.CONTROL_PLANE,
      summary: `${String(Math.round(ratio * 100))}% of WebSocket closes are auth rejections (${String(authFailures)}/${String(total)}).`,
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
export const nodeStatusUnavailableRule: AlertRule = (ctx) => {
  const alerts: Alert[] = [];
  for (const { labels, value } of ctx.metrics.nodeStatusUp.entries()) {
    if (value === 1) continue;
    const service = labels['service'] ?? 'node-server';

    const reasons = ctx.metrics.nodeStatusPollErrorsTotal
      .entries()
      .filter(({ labels: l }) => l['service'] === service)
      .map(({ labels: l }) => l['reason'] ?? 'unknown');
    const unauthorized = reasons.includes('unauthorized');

    alerts.push({
      id: `node-status-unavailable:${service}`,
      failureModes: ['S3'],
      severity: unauthorized ? AlertSeverity.CRITICAL : AlertSeverity.WARNING,
      stage: PipelineStage.CONTROL_PLANE,
      summary: `Cannot read ${service} status (${reasons.length === 0 ? 'unknown' : reasons.join(', ')}); connection, upstream and auth metrics are stale.`,
      likelyCause: unauthorized
        ? `${service} rejected the sidecar's service API key. Compare NODE_SERVER_SERVICE_API_KEY on both — until it matches, the WebSocket-close, upstream-churn and auth metrics report nothing while every probe stays green.`
        : `${service}'s status endpoint is not answering. Check it is reachable on the internal network (it must not be exposed through nginx) and that the probes agree about its health.`,
      value: 0,
      threshold: 1,
    });
  }
  return alerts;
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
  configPollErrorRule,
  transcriptionSaturationRule,
  bufferOverflowRule,
  decodeDropRule,
  authFailureRule,
  nodeStatusUnavailableRule,
  probeDownRule,
  canaryFailureRule,
  canaryQualityRule,
];
