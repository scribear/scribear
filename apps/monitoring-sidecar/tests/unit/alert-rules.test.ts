import { describe, expect } from 'vitest';

import {
  type AlertContext,
  AlertSeverity,
  type AlertThresholds,
  DEFAULT_THRESHOLDS,
  PipelineStage,
  authFailureRule,
  canaryFailureRule,
  canaryQualityRule,
  clockSkewRule,
  decodeDropRule,
  pendingChunkEvictionRule,
  probeDownRule,
  statusPollUnavailableRule,
  transcriptionFallingBehindRule,
  transcriptionSaturationRule,
  transcriptionTailOverrunRule,
  upstreamChurnRule,
  workerDeadRule,
} from '#src/server/shared/alerts/alert-rules.js';
import {
  CanaryOutcome,
  type CanaryRunResult,
} from '#src/server/shared/canary/canary-types.js';
import { MetricsRegistry } from '#src/server/shared/metrics/metrics-registry.service.js';
import type { ProbeStatus } from '#src/server/shared/probes/probe-poller.service.js';

const NOW = 1_755_624_000_000;

function context(
  metrics: MetricsRegistry,
  probes: ProbeStatus[] = [],
  overrides: Partial<AlertThresholds> = {},
  canary: CanaryRunResult | null = null,
): AlertContext {
  return {
    metrics,
    probes,
    canary,
    nowMs: NOW,
    thresholds: { ...DEFAULT_THRESHOLDS, ...overrides },
  };
}

/** A healthy canary run, so each test varies only the field it is about. */
function canaryResult(
  overrides: Partial<CanaryRunResult> = {},
): CanaryRunResult {
  return {
    outcome: CanaryOutcome.OK,
    startedAtMs: NOW,
    durationMs: 40_000,
    sessionUid: 'sess-canary',
    error: null,
    timeToFirstTranscriptMs: 2_000,
    transcriptCount: 25,
    chunksSent: 400,
    transcriptText: 'the birch canoe slid on the smooth planks',
    accuracy: {
      recall: 1,
      precision: 1,
      f1: 1,
      missing: [],
      expectedWordCount: 5,
      actualWordCount: 5,
    },
    repetitionRatio: 0.05,
    pipelineMsP50: 120,
    pipelineMsP95: 200,
    e2eMsP95: 260,
    clockSyncEstablished: true,
    transcriptionServiceConnected: true,
    sourceDeviceConnected: true,
    closeCodes: [],
    ...overrides,
  };
}

function probe(overrides: Partial<ProbeStatus> = {}): ProbeStatus {
  return {
    service: 'session-manager',
    probe: 'readiness',
    healthy: false,
    statusCode: 503,
    latencyMs: 3,
    checks: null,
    error: 'HTTP 503',
    consecutiveFailures: 3,
    lastCheckedMs: NOW,
    ...overrides,
  };
}

/** The `{service, providerKey}` label set the transcription poller writes. */
function providerLabels(providerKey = 'whisper') {
  return { service: 'transcription-service', providerKey };
}

/**
 * Folds RTF observations into the duty-ratio counters the way the poller does:
 * one increment per poll carrying that poll's summed ratios and job count.
 *
 * Split across polls rather than added as a single lump because that is the
 * shape the rolling window actually sees, and because the spike test depends on
 * one poll differing from its neighbours.
 */
function observeDutyRatio(
  metrics: MetricsRegistry,
  options: {
    meanRtf: number;
    jobs?: number;
    polls?: number;
    atMs?: number;
    providerKey?: string;
  },
): void {
  const { meanRtf, jobs = 40, polls = 3, atMs = NOW, providerKey } = options;
  const labels = providerLabels(providerKey);
  for (let poll = 0; poll < polls; poll++) {
    metrics.asrDutyRatioSumTotal.inc(labels, meanRtf * jobs, atMs);
    metrics.asrDutyRatioJobsTotal.inc(labels, jobs, atMs);
  }
}

/**
 * The measured shape the tail rule exists for: a comfortable median with a wide
 * spread. 0.24 is the p50 of a real single-session capture (p95 0.653, max
 * 0.840), so it is below `asrDutyRatio` and below `rtfP95` — neither sibling rule
 * fires on it, which is what makes the tail rule's band non-empty.
 *
 * 120 passes (40 x 3 polls) clears `asrTailMinJobs`, so a test that wants to
 * exercise the floor must override `jobs`/`polls` itself.
 */
const HEALTHY_MEAN_RTF = 0.24;
const TAIL_PASSES = 120;

/** Declares that the polled service reports the dropped-period counter. */
function reportsDroppedPeriods(metrics: MetricsRegistry, reports = true): void {
  metrics.asrDroppedPeriodsSupported.set(
    { service: 'transcription-service' },
    reports ? 1 : 0,
  );
}

/** Sets one reported RTF quantile gauge, as the poller does. */
function setRtfQuantile(
  metrics: MetricsRegistry,
  quantile: string,
  value: number,
  providerKey = 'whisper',
): void {
  metrics.asrRtf.set({ ...providerLabels(providerKey), quantile }, value);
}

describe('alert rules', () => {
  describe('upstream churn (N1)', (it) => {
    it('stays silent below the threshold', () => {
      // Arrange
      const metrics = new MetricsRegistry();
      metrics.upstreamChurnTotal.inc({ service: 'node-server' }, 1, NOW);

      // Act
      const alerts = upstreamChurnRule(context(metrics));

      // Assert
      expect(alerts).toHaveLength(0);
    });

    it('fires once churn crosses the threshold, naming the affected session', () => {
      // Arrange - the counter is process-wide since B1.1, so the room is named
      // from the per-session upstream gauge rather than from a counter label.
      const metrics = new MetricsRegistry();
      for (let i = 0; i < 4; i++) {
        metrics.upstreamChurnTotal.inc({ service: 'node-server' }, 1, NOW - i);
      }
      metrics.nodeSessionUpstreamUp.set(
        { service: 'node-server', sessionUid: 'sess-1' },
        0,
      );

      // Act
      const alerts = upstreamChurnRule(context(metrics));

      // Assert
      expect(alerts).toHaveLength(1);
      expect(alerts[0]?.severity).toBe(AlertSeverity.CRITICAL);
      expect(alerts[0]?.failureModes).toContain('N1');
      expect(alerts[0]?.summary).toContain('sess-1');
      // Every red state must name a next action, not just a number.
      expect(alerts[0]?.likelyCause).toContain('session-config-stream');
    });

    it('still fires when no session is currently down', () => {
      // Arrange - a link that flapped and recovered between polls leaves churn
      // in the window but nothing to name. The count is what fires the rule.
      const metrics = new MetricsRegistry();
      for (let i = 0; i < 4; i++) {
        metrics.upstreamChurnTotal.inc({ service: 'node-server' }, 1, NOW - i);
      }

      // Act
      const alerts = upstreamChurnRule(context(metrics));

      // Assert
      expect(alerts).toHaveLength(1);
      expect(alerts[0]?.summary).toContain('across all sessions');
    });

    it('ignores churn that has aged out of the rate window', () => {
      // Arrange — old enough to fall outside the window
      const metrics = new MetricsRegistry();
      for (let i = 0; i < 5; i++) {
        metrics.upstreamChurnTotal.inc(
          { service: 'node-server' },
          1,
          NOW - 10 * 60_000,
        );
      }

      // Act
      const alerts = upstreamChurnRule(context(metrics));

      // Assert
      expect(alerts).toHaveLength(0);
    });
  });

  describe('transcription saturation (T1)', (it) => {
    it('fires when p95 RTF reaches the realtime line', () => {
      // Arrange
      const metrics = new MetricsRegistry();
      metrics.asrRtf.set(
        {
          service: 'transcription-service',
          providerKey: 'whisper',
          quantile: 'p95',
        },
        1.4,
      );

      // Act
      const alerts = transcriptionSaturationRule(context(metrics));

      // Assert
      expect(alerts).toHaveLength(1);
      expect(alerts[0]?.stage).toBe('transcription');
      expect(alerts[0]?.summary).toContain('p95 RTF 1.40');
    });

    it('stays silent for a comfortably-faster-than-realtime workload', () => {
      // Arrange
      const metrics = new MetricsRegistry();
      metrics.asrRtf.set(
        {
          service: 'transcription-service',
          providerKey: 'whisper',
          quantile: 'p95',
        },
        0.4,
      );

      // Act
      const alerts = transcriptionSaturationRule(context(metrics));

      // Assert
      expect(alerts).toHaveLength(0);
    });

    it('ignores quantiles other than p95', () => {
      // Arrange — a saturated max with a healthy p95 is a spike, not saturation.
      const metrics = new MetricsRegistry();
      metrics.asrRtf.set(
        {
          service: 'transcription-service',
          providerKey: 'whisper',
          quantile: 'max',
        },
        4.0,
      );
      metrics.asrRtf.set(
        {
          service: 'transcription-service',
          providerKey: 'whisper',
          quantile: 'p95',
        },
        0.3,
      );

      // Act
      const alerts = transcriptionSaturationRule(context(metrics));

      // Assert
      expect(alerts).toHaveLength(0);
    });

    it('does not fire on the secondary period-utilization series', () => {
      // Arrange — two alerts for one saturation event would be noise, so only
      // RTF is wired to the rule.
      const metrics = new MetricsRegistry();
      metrics.asrPeriodUtilization.set(
        {
          service: 'transcription-service',
          providerKey: 'whisper',
          quantile: 'p95',
        },
        3.0,
      );

      // Act
      const alerts = transcriptionSaturationRule(context(metrics));

      // Assert
      expect(alerts).toHaveLength(0);
    });
  });

  describe('transcription falling behind realtime (T1, early)', (it) => {
    it('fires on a sustained mean duty ratio above the threshold', () => {
      // Arrange — 0.9 of the period budget spent on every pass for the whole
      // window. Nothing errors in this state; the scheduler just drops the
      // periods it overruns.
      const metrics = new MetricsRegistry();
      observeDutyRatio(metrics, { meanRtf: 0.9 });

      // Act
      const alerts = transcriptionFallingBehindRule(context(metrics));

      // Assert
      expect(alerts).toHaveLength(1);
      expect(alerts[0]?.severity).toBe(AlertSeverity.WARNING);
      expect(alerts[0]?.stage).toBe(PipelineStage.TRANSCRIPTION);
      expect(alerts[0]?.failureModes).toContain('T1');
      expect(alerts[0]?.summary).toContain('mean RTF 0.90');
      expect(alerts[0]?.summary).toContain('90% of its realtime budget');
      // The levers are provider config, and the alert has to say which.
      expect(alerts[0]?.likelyCause).toContain('job_period_ms');
      expect(alerts[0]?.likelyCause).toContain('max_buffer_len_sec');
    });

    it('stays silent below the threshold', () => {
      // Arrange - 0.3 is measured healthy operation, not an arbitrary low
      // number: 42 minutes of live load on an RTX 5070 Ti put a single session
      // at 0.28 (speech-sparse fixture) to 0.33 (speech-dense).
      const metrics = new MetricsRegistry();
      observeDutyRatio(metrics, { meanRtf: 0.3 });

      // Act
      const alerts = transcriptionFallingBehindRule(context(metrics));

      // Assert
      expect(alerts).toHaveLength(0);
    });

    it('stays silent at the worst duty ratio ever measured healthy', () => {
      // Arrange - 0.355 was the worst of 388 rolling 120s windows across that
      // whole capture, including session-onset ramps. It is the empirical
      // false-alarm floor, so it pins the headroom the 0.45 default was chosen
      // to leave: tighten the threshold past this and the alert starts firing on
      // a healthy stack.
      const metrics = new MetricsRegistry();
      observeDutyRatio(metrics, { meanRtf: 0.355 });

      // Act
      const alerts = transcriptionFallingBehindRule(context(metrics));

      // Assert
      expect(alerts).toHaveLength(0);
    });

    it('does not fire on a single spiky observation among healthy ones', () => {
      // Arrange — bursty per-pass cost is normal and expected: the buffer grows
      // between finalizations and is re-transcribed in full, so the odd pass
      // costs many times the typical one. 240 passes at 0.3 plus one at 30
      // averages 0.42, which must not alert.
      const metrics = new MetricsRegistry();
      observeDutyRatio(metrics, { meanRtf: 0.3, polls: 6 });
      observeDutyRatio(metrics, { meanRtf: 30, jobs: 1, polls: 1 });

      // Act
      const alerts = transcriptionFallingBehindRule(context(metrics));

      // Assert
      expect(alerts).toHaveLength(0);
    });

    it('names the provider that is behind and leaves the healthy one alone', () => {
      // Arrange — providers do not share a budget; one saturated model must not
      // implicate the other.
      const metrics = new MetricsRegistry();
      observeDutyRatio(metrics, { meanRtf: 1.2, providerKey: 'whisper-turbo' });
      observeDutyRatio(metrics, { meanRtf: 0.2, providerKey: 'whisper-tiny' });

      // Act
      const alerts = transcriptionFallingBehindRule(context(metrics));

      // Assert
      expect(alerts).toHaveLength(1);
      expect(alerts[0]?.id).toBe('asr-falling-behind:whisper-turbo');
      expect(alerts[0]?.summary).toContain('whisper-turbo');
    });

    it('ignores a provider with too few observations to average', () => {
      // Arrange — a provider that has served six jobs has no meaningful mean,
      // the same minimum-samples guard the auth-ratio and skew rules apply.
      const metrics = new MetricsRegistry();
      observeDutyRatio(metrics, { meanRtf: 3.0, jobs: 2, polls: 3 });

      // Act
      const alerts = transcriptionFallingBehindRule(context(metrics));

      // Assert
      expect(alerts).toHaveLength(0);
    });

    it('stops firing once the load that produced it has aged out', () => {
      // Arrange — this is why the rule reads differenced counters rather than
      // the reported p95 gauge: transcription-service's sample ring never
      // expires by time, so its percentiles stay high indefinitely after a
      // heavy session ends.
      const metrics = new MetricsRegistry();
      observeDutyRatio(metrics, { meanRtf: 1.4, atMs: NOW - 240_000 });

      // Act
      const alerts = transcriptionFallingBehindRule(context(metrics));

      // Assert
      expect(alerts).toHaveLength(0);
    });

    it('corroborates with force-finalized audio when the buffer is also overflowing', () => {
      // Arrange — overflow is a consequence, not a condition (T2 owns it), but
      // it tells the operator audio is already being discarded.
      const metrics = new MetricsRegistry();
      observeDutyRatio(metrics, { meanRtf: 0.85 });
      metrics.asrBufferOverflowSecondsTotal.inc(providerLabels(), 12.5, NOW);

      // Act
      const alerts = transcriptionFallingBehindRule(context(metrics));

      // Assert
      expect(alerts).toHaveLength(1);
      expect(alerts[0]?.summary).toContain(
        '12.5s of audio already force-finalized',
      );
    });
  });

  describe('transcription overrunning its period on the tail (T1, tail)', (it) => {
    it('fires on the exact dropped-period counter', () => {
      // Arrange — the median pass is comfortable (0.24, a measured p50) so
      // neither sibling rule fires, but three periods in the window ran no pass
      // at all. Nothing else in the stack records that: the pool advances past a
      // period it overran without erroring or queueing.
      const metrics = new MetricsRegistry();
      observeDutyRatio(metrics, { meanRtf: HEALTHY_MEAN_RTF });
      reportsDroppedPeriods(metrics);
      metrics.asrDroppedPeriodsTotal.inc(providerLabels(), 3, NOW);

      // Act
      const alerts = transcriptionTailOverrunRule(context(metrics));

      // Assert
      expect(alerts).toHaveLength(1);
      expect(alerts[0]?.id).toBe('asr-tail-overrun:whisper');
      expect(alerts[0]?.severity).toBe(AlertSeverity.WARNING);
      expect(alerts[0]?.stage).toBe(PipelineStage.TRANSCRIPTION);
      expect(alerts[0]?.failureModes).toContain('T1');
      expect(alerts[0]?.summary).toContain(
        `3 of ${String(TAIL_PASSES + 3)} job periods ran no pass at all`,
      );
      expect(alerts[0]?.value).toBeCloseTo(3 / (TAIL_PASSES + 3));
      // The levers are the buffer and the period, not capacity: one stream's
      // passes run one at a time, so a second worker shortens nothing.
      expect(alerts[0]?.likelyCause).toContain('max_buffer_len_sec');
      expect(alerts[0]?.likelyCause).toContain('job_period_ms');
      expect(alerts[0]?.likelyCause).toContain('More workers or CPU will not');
    });

    it('trusts a reported zero over a high p99', () => {
      // Arrange — the discriminator that makes the fallback safe. This service
      // reports the counter and reports no drops, so the p99 gauge (which is on
      // a fixed 1% grid over the far end's own ring) must not be consulted: the
      // exact count says no period was lost.
      const metrics = new MetricsRegistry();
      observeDutyRatio(metrics, { meanRtf: HEALTHY_MEAN_RTF });
      reportsDroppedPeriods(metrics);
      setRtfQuantile(metrics, 'p99', 1.4);

      // Act
      const alerts = transcriptionTailOverrunRule(context(metrics));

      // Assert
      expect(alerts).toHaveLength(0);
    });

    it('stays silent on a single dropped period', () => {
      // Arrange — one lost period in 121 is 0.83%, under the 1% threshold. The
      // floor and the threshold are chosen together for exactly this: a rule that
      // pages on one skipped period would fire on a session-onset hiccup.
      const metrics = new MetricsRegistry();
      observeDutyRatio(metrics, { meanRtf: HEALTHY_MEAN_RTF });
      reportsDroppedPeriods(metrics);
      metrics.asrDroppedPeriodsTotal.inc(providerLabels(), 1, NOW);

      // Act
      const alerts = transcriptionTailOverrunRule(context(metrics));

      // Assert
      expect(alerts).toHaveLength(0);
    });

    it('falls back to the reported p99 when the service does not count drops', () => {
      // Arrange — a transcription-service predating the counter, which is what
      // this sidecar polls during a rolling upgrade. p99 >= 1.0 means the worst
      // 1% of passes took longer than the audio they consumed, i.e. longer than
      // the period that scheduled them.
      const metrics = new MetricsRegistry();
      observeDutyRatio(metrics, { meanRtf: HEALTHY_MEAN_RTF });
      reportsDroppedPeriods(metrics, false);
      setRtfQuantile(metrics, 'p99', 1.2);

      // Act
      const alerts = transcriptionTailOverrunRule(context(metrics));

      // Assert
      expect(alerts).toHaveLength(1);
      expect(alerts[0]?.summary).toContain('p99 RTF 1.20');
      // The alert has to admit which signal it fired on: the operator cannot
      // ask how many periods were lost.
      expect(alerts[0]?.summary).toContain('does not report dropped periods');
      expect(alerts[0]?.value).toBeCloseTo(1.2);
      expect(alerts[0]?.threshold).toBe(1.0);
    });

    it('stays silent on a healthy p99 when it has no counter to read', () => {
      // Arrange — the same old service, keeping up. 0.653 is the measured p95 of
      // a healthy single session, well clear of the realtime line.
      const metrics = new MetricsRegistry();
      observeDutyRatio(metrics, { meanRtf: HEALTHY_MEAN_RTF });
      reportsDroppedPeriods(metrics, false);
      setRtfQuantile(metrics, 'p99', 0.653);

      // Act
      const alerts = transcriptionTailOverrunRule(context(metrics));

      // Assert
      expect(alerts).toHaveLength(0);
    });

    it('ignores a provider with too few passes to judge a tail', () => {
      // Arrange — 60 passes dropping 10 periods is a 14% share, but a p99 over 60
      // samples is barely more than the worst one and the exact share rests on
      // too little traffic to call sustained. Both signals share the floor.
      const metrics = new MetricsRegistry();
      observeDutyRatio(metrics, { meanRtf: HEALTHY_MEAN_RTF, jobs: 20 });
      reportsDroppedPeriods(metrics);
      metrics.asrDroppedPeriodsTotal.inc(providerLabels(), 10, NOW);
      setRtfQuantile(metrics, 'p99', 2.0);

      // Act
      const alerts = transcriptionTailOverrunRule(context(metrics));

      // Assert
      expect(alerts).toHaveLength(0);
    });

    it('does not double-report the event the CRITICAL already owns', () => {
      // Arrange — p95 RTF at 1.2 is `transcriptionSaturationRule`'s outage. It
      // implies p99 >= 1.0 and it comes with dropped periods by construction, so
      // without suppression this event would produce two cards.
      const metrics = new MetricsRegistry();
      observeDutyRatio(metrics, { meanRtf: HEALTHY_MEAN_RTF });
      reportsDroppedPeriods(metrics);
      metrics.asrDroppedPeriodsTotal.inc(providerLabels(), 30, NOW);
      setRtfQuantile(metrics, 'p95', 1.2);
      setRtfQuantile(metrics, 'p99', 1.6);

      // Act
      const tail = transcriptionTailOverrunRule(context(metrics));
      const critical = transcriptionSaturationRule(context(metrics));

      // Assert — reported exactly once, by the more urgent rule.
      expect(tail).toHaveLength(0);
      expect(critical).toHaveLength(1);
      expect(critical[0]?.severity).toBe(AlertSeverity.CRITICAL);
    });

    it('does not double-report the mean-based warning either', () => {
      // Arrange — a mean of 0.9 is `transcriptionFallingBehindRule`'s band. Same
      // severity, same provider, same stage and the same three levers, so a
      // second warning would add prose and no decision. This rule owns only the
      // band below it: mean healthy, tail overrunning.
      const metrics = new MetricsRegistry();
      observeDutyRatio(metrics, { meanRtf: 0.9 });
      reportsDroppedPeriods(metrics);
      metrics.asrDroppedPeriodsTotal.inc(providerLabels(), 30, NOW);

      // Act
      const tail = transcriptionTailOverrunRule(context(metrics));
      const mean = transcriptionFallingBehindRule(context(metrics));

      // Assert
      expect(tail).toHaveLength(0);
      expect(mean).toHaveLength(1);
    });

    it('names the provider that is dropping periods and leaves the other alone', () => {
      // Arrange — providers do not share a period budget, and a model that fits
      // its period must not be implicated by one that does not.
      const metrics = new MetricsRegistry();
      observeDutyRatio(metrics, {
        meanRtf: HEALTHY_MEAN_RTF,
        providerKey: 'whisper-turbo',
      });
      observeDutyRatio(metrics, {
        meanRtf: HEALTHY_MEAN_RTF,
        providerKey: 'whisper-tiny',
      });
      reportsDroppedPeriods(metrics);
      metrics.asrDroppedPeriodsTotal.inc(
        providerLabels('whisper-turbo'),
        6,
        NOW,
      );

      // Act
      const alerts = transcriptionTailOverrunRule(context(metrics));

      // Assert
      expect(alerts).toHaveLength(1);
      expect(alerts[0]?.id).toBe('asr-tail-overrun:whisper-turbo');
    });

    it('stops firing once the dropped periods have aged out of the window', () => {
      // Arrange — a share over a rolling window, not a lifetime total: an
      // incident that has passed must clear on its own.
      const metrics = new MetricsRegistry();
      observeDutyRatio(metrics, {
        meanRtf: HEALTHY_MEAN_RTF,
        atMs: NOW - 240_000,
      });
      reportsDroppedPeriods(metrics);
      metrics.asrDroppedPeriodsTotal.inc(providerLabels(), 30, NOW - 240_000);

      // Act
      const alerts = transcriptionTailOverrunRule(context(metrics));

      // Assert
      expect(alerts).toHaveLength(0);
    });
  });

  describe('dead transcription worker (T9)', (it) => {
    it('names the workers that exited', () => {
      // Arrange
      const metrics = new MetricsRegistry();
      metrics.asrWorkerAlive.set(
        { service: 'transcription-service', workerId: '0' },
        1,
      );
      metrics.asrWorkerAlive.set(
        { service: 'transcription-service', workerId: '1' },
        0,
      );

      // Act
      const alerts = workerDeadRule(context(metrics));

      // Assert
      expect(alerts).toHaveLength(1);
      expect(alerts[0]?.severity).toBe(AlertSeverity.CRITICAL);
      expect(alerts[0]?.summary).toContain('worker 1');
    });

    it('stays silent when every worker is alive', () => {
      // Arrange
      const metrics = new MetricsRegistry();
      metrics.asrWorkerAlive.set(
        { service: 'transcription-service', workerId: '0' },
        1,
      );

      // Act
      const alerts = workerDeadRule(context(metrics));

      // Assert
      expect(alerts).toHaveLength(0);
    });
  });

  describe('decode drops (U2/S4)', (it) => {
    it('fires once drops exceed the threshold in the window', () => {
      // Arrange
      const metrics = new MetricsRegistry();
      for (let i = 0; i < 12; i++) {
        metrics.safpDecodeDropsTotal.inc({ side: 'node' }, 1, NOW);
      }

      // Act
      const alerts = decodeDropRule(context(metrics));

      // Assert
      expect(alerts).toHaveLength(1);
      expect(alerts[0]?.likelyCause).toContain('version');
    });
  });

  describe('auth failure ratio (S2)', (it) => {
    it('ignores a few expired tokens amid healthy traffic', () => {
      // Arrange — background noise, not a config failure
      const metrics = new MetricsRegistry();
      metrics.wsCloseTotal.inc({ reason: 'token-expired' }, 1, NOW);
      for (let i = 0; i < 19; i++) {
        metrics.wsCloseTotal.inc({ reason: 'no-more-sources' }, 1, NOW);
      }

      // Act
      const alerts = authFailureRule(context(metrics));

      // Assert
      expect(alerts).toHaveLength(0);
    });

    it('fires when nearly every close is an auth rejection', () => {
      // Arrange — the signing-key mismatch signature
      const metrics = new MetricsRegistry();
      for (let i = 0; i < 20; i++) {
        metrics.wsCloseTotal.inc({ reason: 'invalid-token' }, 1, NOW);
      }

      // Act
      const alerts = authFailureRule(context(metrics));

      // Assert
      expect(alerts).toHaveLength(1);
      expect(alerts[0]?.likelyCause).toContain('SESSION_TOKEN_SIGNING_KEY');
    });

    it('does not fire on a tiny sample', () => {
      // Arrange — one rejection out of one close is 100% but meaningless
      const metrics = new MetricsRegistry();
      metrics.wsCloseTotal.inc({ reason: 'invalid-token' }, 1, NOW);

      // Act
      const alerts = authFailureRule(context(metrics));

      // Assert
      expect(alerts).toHaveLength(0);
    });

    it('prefers auth attempts over closes as the denominator', () => {
      // Arrange - the same 10 rejections against 10 successful logins is
      // healthy-ish traffic, but 30 unrelated end-of-session closes would drag
      // the close-based ratio under the threshold and hide it. Attempts are the
      // denominator the plan specifies, and they are available since B1.1.
      const metrics = new MetricsRegistry();
      for (let i = 0; i < 10; i++) {
        metrics.nodeAuthFailuresTotal.inc({ reason: 'invalid-token' }, 1, NOW);
        metrics.nodeAuthSuccessTotal.inc({}, 1, NOW);
        metrics.wsCloseTotal.inc({ reason: 'invalid-token' }, 1, NOW);
      }
      for (let i = 0; i < 30; i++) {
        metrics.wsCloseTotal.inc({ reason: 'session-ended' }, 1, NOW);
      }

      // Act
      const alerts = authFailureRule(context(metrics));

      // Assert - 10/20 attempts crosses the 0.5 default; 10/40 closes would not
      expect(alerts).toHaveLength(1);
      expect(alerts[0]?.value).toBe(0.5);
      expect(alerts[0]?.summary).toContain('authentication attempts');
    });

    it('falls back to close codes when status polling is disabled', () => {
      // Arrange - no auth-attempt data at all, which is what a deployment
      // without NODE_SERVER_SERVICE_API_KEY looks like.
      const metrics = new MetricsRegistry();
      for (let i = 0; i < 20; i++) {
        metrics.wsCloseTotal.inc({ reason: 'invalid-token' }, 1, NOW);
      }

      // Act
      const alerts = authFailureRule(context(metrics));

      // Assert
      expect(alerts).toHaveLength(1);
    });
  });

  describe('clock skew (S5)', (it) => {
    it('stays silent when a handful of samples are negative', () => {
      // Arrange - a single odd device is noise, not a deployment fault
      const metrics = new MetricsRegistry();
      for (let i = 0; i < 100; i++) {
        metrics.nodeLatencySamplesTotal.inc({}, 1, NOW);
      }
      metrics.nodeLatencyE2eNegativeTotal.inc({}, 1, NOW);

      // Act
      const alerts = clockSkewRule(context(metrics));

      // Assert
      expect(alerts).toHaveLength(0);
    });

    it('fires once a large share of samples arrive before they were sent', () => {
      // Arrange
      const metrics = new MetricsRegistry();
      for (let i = 0; i < 100; i++) {
        metrics.nodeLatencySamplesTotal.inc({}, 1, NOW);
        if (i < 40) metrics.nodeLatencyE2eNegativeTotal.inc({}, 1, NOW);
      }

      // Act
      const alerts = clockSkewRule(context(metrics));

      // Assert
      expect(alerts).toHaveLength(1);
      expect(alerts[0]?.failureModes).toContain('S5');
      expect(alerts[0]?.severity).toBe(AlertSeverity.WARNING);
      // Captions are fine; only the measurement is broken. Say so.
      expect(alerts[0]?.likelyCause).toContain('Captions are unaffected');
    });

    it('ignores a ratio computed from too few samples', () => {
      // Arrange - 2 of 2 is 100% and means nothing
      const metrics = new MetricsRegistry();
      metrics.nodeLatencySamplesTotal.inc({}, 2, NOW);
      metrics.nodeLatencyE2eNegativeTotal.inc({}, 2, NOW);

      // Act
      const alerts = clockSkewRule(context(metrics));

      // Assert
      expect(alerts).toHaveLength(0);
    });
  });

  describe('pending-chunk evictions (N3)', (it) => {
    it('stays silent below the threshold', () => {
      // Arrange
      const metrics = new MetricsRegistry();
      metrics.nodePendingChunkEvictionsTotal.inc({}, 2, NOW);

      // Act
      const alerts = pendingChunkEvictionRule(context(metrics));

      // Assert
      expect(alerts).toHaveLength(0);
    });

    it('warns when frames are being dropped from latency correlation', () => {
      // Arrange
      const metrics = new MetricsRegistry();
      metrics.nodePendingChunkEvictionsTotal.inc({}, 25, NOW);

      // Act
      const alerts = pendingChunkEvictionRule(context(metrics));

      // Assert
      expect(alerts).toHaveLength(1);
      expect(alerts[0]?.failureModes).toContain('N3');
      expect(alerts[0]?.stage).toBe(PipelineStage.NODE);
    });

    it('ignores evictions that have aged out of the window', () => {
      // Arrange
      const metrics = new MetricsRegistry();
      metrics.nodePendingChunkEvictionsTotal.inc({}, 25, NOW - 10 * 60_000);

      // Act
      const alerts = pendingChunkEvictionRule(context(metrics));

      // Assert
      expect(alerts).toHaveLength(0);
    });
  });

  describe('node status unavailable', (it) => {
    it('stays silent while the status poll is succeeding', () => {
      // Arrange
      const metrics = new MetricsRegistry();
      metrics.serviceStatusUp.set({ service: 'node-server' }, 1);

      // Act
      const alerts = statusPollUnavailableRule(context(metrics));

      // Assert
      expect(alerts).toHaveLength(0);
    });

    it('escalates a rejected service key to critical', () => {
      // Arrange - the blind spot the B1.1 cut-over introduced: node-server is
      // healthy, every probe is green, and four metrics silently report zero.
      const metrics = new MetricsRegistry();
      metrics.serviceStatusUp.set({ service: 'node-server' }, 0);
      metrics.serviceStatusPollErrorsTotal.inc(
        { service: 'node-server', reason: 'unauthorized' },
        1,
        NOW,
      );

      // Act
      const alerts = statusPollUnavailableRule(context(metrics));

      // Assert
      expect(alerts).toHaveLength(1);
      expect(alerts[0]?.severity).toBe(AlertSeverity.CRITICAL);
      expect(alerts[0]?.likelyCause).toContain('rejected the sidecar');
    });

    it('pages on a 404, which means the far end never registered the route', () => {
      // Arrange - transcription-service leaves /metrics/status unregistered
      // when its own key is empty, so a key set on the sidecar alone reads as
      // not-found rather than unauthorized. Both are config faults that no
      // amount of waiting fixes, so both page.
      const metrics = new MetricsRegistry();
      metrics.serviceStatusUp.set({ service: 'transcription-service' }, 0);
      metrics.serviceStatusPollErrorsTotal.inc(
        { service: 'transcription-service', reason: 'not-found' },
        1,
        NOW,
      );

      // Act
      const alerts = statusPollUnavailableRule(context(metrics));

      // Assert
      expect(alerts).toHaveLength(1);
      expect(alerts[0]?.severity).toBe(AlertSeverity.CRITICAL);
      expect(alerts[0]?.likelyCause).toContain('metrics key is empty');
    });

    it('warns rather than pages when the endpoint is merely unreachable', () => {
      // Arrange - the probe poller already alerts on an unreachable service, so
      // this would be the second alert for one outage.
      const metrics = new MetricsRegistry();
      metrics.serviceStatusUp.set({ service: 'node-server' }, 0);
      metrics.serviceStatusPollErrorsTotal.inc(
        { service: 'node-server', reason: 'unreachable' },
        1,
        NOW,
      );

      // Act
      const alerts = statusPollUnavailableRule(context(metrics));

      // Assert
      expect(alerts[0]?.severity).toBe(AlertSeverity.WARNING);
      expect(alerts[0]?.stage).toBe(PipelineStage.CONTROL_PLANE);
    });
  });

  describe('probe down (N5/S1/T9)', (it) => {
    it('tolerates a single failed poll', () => {
      // Arrange
      const metrics = new MetricsRegistry();

      // Act
      const alerts = probeDownRule(
        context(metrics, [probe({ consecutiveFailures: 1 })]),
      );

      // Assert
      expect(alerts).toHaveLength(0);
    });

    it('names the failing dependency when readiness reports checks', () => {
      // Arrange
      const metrics = new MetricsRegistry();
      const status = probe({ checks: { database: 'fail' } });

      // Act
      const alerts = probeDownRule(context(metrics, [status]));

      // Assert — "session-manager is down because the database is"
      expect(alerts).toHaveLength(1);
      expect(alerts[0]?.likelyCause).toContain('database');
    });

    it('ignores healthy probes', () => {
      // Arrange
      const metrics = new MetricsRegistry();

      // Act
      const alerts = probeDownRule(
        context(metrics, [probe({ healthy: true, consecutiveFailures: 0 })]),
      );

      // Assert
      expect(alerts).toHaveLength(0);
    });
  });

  describe('canary failure (A2)', (it) => {
    it('stays silent before the canary has ever run', () => {
      // Arrange — a canary that has not reported yet must not read as an
      // outage, or every sidecar restart would page someone.
      const metrics = new MetricsRegistry();

      // Act
      const alerts = canaryFailureRule(context(metrics, [], {}, null));

      // Assert
      expect(alerts).toHaveLength(0);
    });

    it('stays silent when no session was scheduled to probe', () => {
      // Arrange — an idle canary room is not a fault.
      const metrics = new MetricsRegistry();
      const canary = canaryResult({ outcome: CanaryOutcome.NO_SESSION });

      // Act
      const alerts = canaryFailureRule(context(metrics, [], {}, canary));

      // Assert
      expect(alerts).toHaveLength(0);
    });

    it('fires critical when audio streamed but no captions came back', () => {
      // Arrange — the headline A2 failure.
      const metrics = new MetricsRegistry();
      const canary = canaryResult({
        outcome: CanaryOutcome.NO_TRANSCRIPTS,
        chunksSent: 80,
      });

      // Act
      const alerts = canaryFailureRule(context(metrics, [], {}, canary));

      // Assert
      expect(alerts).toHaveLength(1);
      expect(alerts[0]?.severity).toBe(AlertSeverity.CRITICAL);
      expect(alerts[0]?.failureModes).toContain('N1');
      expect(alerts[0]?.likelyCause).toContain('captions just stopped');
    });

    it('blames the control plane, not transcription, on an auth failure', () => {
      // Arrange — the stage drives where the operator looks first, so it must
      // track the actual failure rather than always naming the pipeline.
      const metrics = new MetricsRegistry();
      const canary = canaryResult({ outcome: CanaryOutcome.AUTH_FAILED });

      // Act
      const alerts = canaryFailureRule(context(metrics, [], {}, canary));

      // Assert
      expect(alerts[0]?.stage).toBe(PipelineStage.CONTROL_PLANE);
      expect(alerts[0]?.likelyCause).toContain('session-manager');
    });

    it('stays silent on a healthy run', () => {
      // Arrange
      const metrics = new MetricsRegistry();

      // Act
      const alerts = canaryFailureRule(
        context(metrics, [], {}, canaryResult({})),
      );

      // Assert
      expect(alerts).toHaveLength(0);
    });
  });

  describe('canary quality (A2)', (it) => {
    it('does not double-report a failed run as a quality problem', () => {
      // Arrange — a dead pipeline should raise one outage alert, not also an
      // "inaccurate captions" alert about captions that never existed.
      const metrics = new MetricsRegistry();
      const canary = canaryResult({
        outcome: CanaryOutcome.NO_TRANSCRIPTS,
        accuracy: null,
        clockSyncEstablished: false,
      });

      // Act
      const alerts = canaryQualityRule(context(metrics, [], {}, canary));

      // Assert
      expect(alerts).toHaveLength(0);
    });

    it('warns when the first caption takes too long', () => {
      // Arrange
      const metrics = new MetricsRegistry();
      const canary = canaryResult({ timeToFirstTranscriptMs: 30_000 });

      // Act
      const alerts = canaryQualityRule(context(metrics, [], {}, canary));

      // Assert
      const slow = alerts.find((a) => a.id === 'canary-slow-first-transcript');
      expect(slow?.severity).toBe(AlertSeverity.WARNING);
      expect(slow?.failureModes).toContain('T1');
    });

    it('warns when recall falls below the threshold', () => {
      // Arrange
      const metrics = new MetricsRegistry();
      const canary = canaryResult({
        accuracy: {
          recall: 0.1,
          precision: 0.9,
          f1: 0.18,
          missing: ['birch', 'canoe'],
          expectedWordCount: 5,
          actualWordCount: 2,
        },
      });

      // Act
      const alerts = canaryQualityRule(context(metrics, [], {}, canary));

      // Assert
      expect(alerts.some((a) => a.id === 'canary-low-accuracy')).toBe(true);
    });

    it('warns on a looping transcript even when the words are all correct', () => {
      // Arrange — recall and precision stay perfect while the captions are
      // plainly broken, which is why repetition needs its own rule.
      const metrics = new MetricsRegistry();
      const canary = canaryResult({ repetitionRatio: 0.95 });

      // Act
      const alerts = canaryQualityRule(context(metrics, [], {}, canary));

      // Assert
      const repetition = alerts.find((a) => a.id === 'canary-repetition');
      expect(repetition?.likelyCause).toContain('looping');
    });

    it('flags C6 when clock sync never converged', () => {
      // Arrange — pipeline latency still works; only e2e is unavailable, so
      // this is a warning about a blind spot rather than an outage.
      const metrics = new MetricsRegistry();
      const canary = canaryResult({ clockSyncEstablished: false });

      // Act
      const alerts = canaryQualityRule(context(metrics, [], {}, canary));

      // Assert
      const clock = alerts.find((a) => a.id === 'canary-clock-sync');
      expect(clock?.failureModes).toContain('C6');
      expect(clock?.severity).toBe(AlertSeverity.WARNING);
    });

    it('stays silent on a healthy, accurate, timely run', () => {
      // Arrange
      const metrics = new MetricsRegistry();

      // Act
      const alerts = canaryQualityRule(
        context(metrics, [], {}, canaryResult({})),
      );

      // Assert
      expect(alerts).toHaveLength(0);
    });
  });
});
