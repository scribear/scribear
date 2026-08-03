import { describe, expect } from 'vitest';

import {
  type AlertContext,
  AlertSeverity,
  type AlertThresholds,
  DEFAULT_THRESHOLDS,
  PipelineStage,
  authFailureRule,
  bufferOverflowRule,
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
  providerDevices: ReadonlyMap<string, string> = new Map(),
): AlertContext {
  return {
    metrics,
    probes,
    canary,
    nowMs: NOW,
    thresholds: { ...DEFAULT_THRESHOLDS, ...overrides },
    providerDevices,
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
/**
 * Dropped periods that put `TAIL_PASSES` past the threshold: 43/163 = 26.4%, the
 * share measured live at 3 concurrent sessions. Healthy single-session operation
 * measured 11.3%, which is why the threshold is 25% and not the 1% it shipped as
 * before anyone looked.
 */
const DEGRADED_DROPS = 43;
/**
 * The share a *healthy* single session drops: 15/135 = 11.1%, against the 11.3%
 * measured live while captions were arriving perfectly. Below both thresholds,
 * and the reason neither is anywhere near zero.
 */
const HEALTHY_DROPS = 15;
/**
 * 236/356 = 66.3%, the share measured at 6 concurrent sessions on one worker,
 * where transcripts per 1000 chunks had collapsed 190 -> 48. Past the 50%
 * CRITICAL bar; the T1 outage this rule set was re-keyed to catch.
 */
const COLLAPSE_DROPS = 236;

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
    it('fires when the dropped-period share reaches the collapse point', () => {
      // Arrange — 66.3% is the share measured live at 6 concurrent sessions,
      // where transcripts per 1000 chunks had collapsed 190 -> 48. The rule is
      // keyed here rather than on RTF because mean RTF at that same point had
      // *fallen* to 0.139 from a healthy 0.277.
      const metrics = new MetricsRegistry();
      reportsDroppedPeriods(metrics);
      observeDutyRatio(metrics, { meanRtf: HEALTHY_MEAN_RTF });
      metrics.asrDroppedPeriodsTotal.inc(providerLabels(), COLLAPSE_DROPS, NOW);

      // Act
      const alerts = transcriptionSaturationRule(context(metrics));

      // Assert
      expect(alerts).toHaveLength(1);
      expect(alerts[0]?.id).toBe('asr-saturation:whisper');
      expect(alerts[0]?.severity).toBe(AlertSeverity.CRITICAL);
      expect(alerts[0]?.stage).toBe('transcription');
      expect(alerts[0]?.summary).toContain('ran no pass at all');
      expect(alerts[0]?.value).toBeCloseTo(
        COLLAPSE_DROPS / (COLLAPSE_DROPS + TAIL_PASSES),
        3,
      );
    });

    it('stays silent at the share a healthy session drops', () => {
      // Arrange — 11.3% of periods, measured on a GPU stack captioning
      // perfectly. Dropping periods is how the provider absorbs a long buffer,
      // so a healthy deployment is not at zero and must not be alerted on.
      const metrics = new MetricsRegistry();
      reportsDroppedPeriods(metrics);
      observeDutyRatio(metrics, { meanRtf: HEALTHY_MEAN_RTF });
      metrics.asrDroppedPeriodsTotal.inc(providerLabels(), HEALTHY_DROPS, NOW);

      // Act
      const alerts = transcriptionSaturationRule(context(metrics));

      // Assert
      expect(alerts).toHaveLength(0);
    });

    it('leaves the strained-but-working share to the tail warning', () => {
      // Arrange — 26.4%, measured at 3 sessions: past the 25% WARNING and
      // below the 50% CRITICAL, which is the band the two thresholds exist to
      // separate.
      const metrics = new MetricsRegistry();
      reportsDroppedPeriods(metrics);
      observeDutyRatio(metrics, { meanRtf: HEALTHY_MEAN_RTF });
      metrics.asrDroppedPeriodsTotal.inc(providerLabels(), DEGRADED_DROPS, NOW);

      // Act
      const critical = transcriptionSaturationRule(context(metrics));
      const warning = transcriptionTailOverrunRule(context(metrics));

      // Assert
      expect(critical).toHaveLength(0);
      expect(warning).toHaveLength(1);
      expect(warning[0]?.severity).toBe(AlertSeverity.WARNING);
    });

    it('is not silenced by the falling RTF that accompanies the dropping', () => {
      // Arrange — the defect the re-key removes. At 8 concurrent sessions the
      // service was badly behind and its p95 RTF read *below* the old 2.0 bar,
      // because a dropped period leaves its audio for the next pass and per-pass
      // cost amortises. The old rule was moving further from firing.
      const metrics = new MetricsRegistry();
      reportsDroppedPeriods(metrics);
      observeDutyRatio(metrics, { meanRtf: 0.139 });
      setRtfQuantile(metrics, 'p95', 0.4);
      metrics.asrDroppedPeriodsTotal.inc(providerLabels(), COLLAPSE_DROPS, NOW);

      // Act
      const alerts = transcriptionSaturationRule(context(metrics));

      // Assert
      expect(alerts).toHaveLength(1);
      expect(alerts[0]?.severity).toBe(AlertSeverity.CRITICAL);
    });

    it('needs enough scheduled periods before it believes the share', () => {
      // Arrange — 8 scheduled periods, all but two dropped. A 100% share over a
      // handful of periods is one slow pass, not an outage.
      const metrics = new MetricsRegistry();
      reportsDroppedPeriods(metrics);
      observeDutyRatio(metrics, {
        meanRtf: HEALTHY_MEAN_RTF,
        jobs: 2,
        polls: 1,
      });
      metrics.asrDroppedPeriodsTotal.inc(providerLabels(), 6, NOW);

      // Act
      const alerts = transcriptionSaturationRule(context(metrics));

      // Assert
      expect(alerts).toHaveLength(0);
    });

    it('floors on scheduled periods, which dropping does not erode', () => {
      // Arrange — the reason the floor is not on passes. A CPU template at a
      // 5000ms period gets ~24 scheduled periods in the 120s window; at a 75%
      // drop share only 6 of them run a pass. A pass floor would go quiet
      // exactly as the fault got severe, which is the wrong-slope defect this
      // re-key exists to remove — reintroduced in the guard.
      const metrics = new MetricsRegistry();
      reportsDroppedPeriods(metrics);
      observeDutyRatio(metrics, {
        meanRtf: HEALTHY_MEAN_RTF,
        jobs: 6,
        polls: 1,
      });
      metrics.asrDroppedPeriodsTotal.inc(providerLabels(), 18, NOW);

      // Act
      const alerts = transcriptionSaturationRule(context(metrics));

      // Assert
      expect(alerts).toHaveLength(1);
      expect(alerts[0]?.value).toBeCloseTo(0.75, 3);
    });

    it('falls back to p95 RTF for a service that cannot count drops', () => {
      // Arrange — a rolling upgrade: this sidecar polls a transcription-service
      // predating the counter. 2.4 is past the 2.0 bar. Losing the T1 CRITICAL
      // entirely for such a service would be a worse trade than keeping the
      // weaker signal.
      const metrics = new MetricsRegistry();
      reportsDroppedPeriods(metrics, false);
      observeDutyRatio(metrics, { meanRtf: HEALTHY_MEAN_RTF });
      setRtfQuantile(metrics, 'p95', 2.4);

      // Act
      const alerts = transcriptionSaturationRule(context(metrics));

      // Assert
      expect(alerts).toHaveLength(1);
      expect(alerts[0]?.severity).toBe(AlertSeverity.CRITICAL);
      expect(alerts[0]?.summary).toContain('p95 RTF 2.40');
      expect(alerts[0]?.summary).toContain('does not report dropped periods');
    });

    it('prefers a reported zero to the p95 fallback', () => {
      // Arrange — a service that reports the counter and is dropping nothing is
      // healthy, whatever its p95 says. Without `asrDroppedPeriodsSupported` an
      // empty counter would be indistinguishable from an old service and this
      // would fall back and fire.
      const metrics = new MetricsRegistry();
      reportsDroppedPeriods(metrics);
      observeDutyRatio(metrics, { meanRtf: HEALTHY_MEAN_RTF });
      setRtfQuantile(metrics, 'p95', 2.4);

      // Act
      const alerts = transcriptionSaturationRule(context(metrics));

      // Assert
      expect(alerts).toHaveLength(0);
    });

    it('does not fire on the secondary period-utilization series', () => {
      // Arrange — two alerts for one saturation event would be noise, so the
      // derived series is deliberately unwired.
      const metrics = new MetricsRegistry();
      reportsDroppedPeriods(metrics, false);
      observeDutyRatio(metrics, { meanRtf: HEALTHY_MEAN_RTF });
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

    it('ages out once the dropping stops', () => {
      // Arrange — drops recorded a full window ago, nothing since. A CRITICAL
      // that could not clear was a real bug in this subsystem once: the source
      // histogram expired by depth and never by age, so one heavy session left
      // a p95-derived CRITICAL firing at zero load until the process restarted.
      const metrics = new MetricsRegistry();
      reportsDroppedPeriods(metrics);
      const stale = NOW - DEFAULT_THRESHOLDS.rateWindowMs - 1;
      observeDutyRatio(metrics, { meanRtf: HEALTHY_MEAN_RTF, atMs: stale });
      metrics.asrDroppedPeriodsTotal.inc(
        providerLabels(),
        COLLAPSE_DROPS,
        stale,
      );

      // Act
      const alerts = transcriptionSaturationRule(context(metrics));

      // Assert
      expect(alerts).toHaveLength(0);
    });

    it('reports each provider separately', () => {
      // Arrange
      const metrics = new MetricsRegistry();
      reportsDroppedPeriods(metrics);
      observeDutyRatio(metrics, { meanRtf: HEALTHY_MEAN_RTF });
      observeDutyRatio(metrics, {
        meanRtf: HEALTHY_MEAN_RTF,
        providerKey: 'crisper_whisper',
      });
      metrics.asrDroppedPeriodsTotal.inc(providerLabels(), COLLAPSE_DROPS, NOW);
      metrics.asrDroppedPeriodsTotal.inc(
        providerLabels('crisper_whisper'),
        HEALTHY_DROPS,
        NOW,
      );

      // Act
      const alerts = transcriptionSaturationRule(context(metrics));

      // Assert
      expect(alerts).toHaveLength(1);
      expect(alerts[0]?.id).toBe('asr-saturation:whisper');
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

    it('uses the CPU threshold (0.7) for a CPU provider, staying silent at 0.5', () => {
      // Arrange — 0.5 is past the GPU default (0.45) but under the CPU default
      // (0.7). A CPU provider running `small`/4 measured 0.471 healthy, so
      // without per-device thresholds this would fire on a healthy stack.
      const metrics = new MetricsRegistry();
      observeDutyRatio(metrics, { meanRtf: 0.5 });
      const devices = new Map([['whisper', 'cpu']]);

      // Act
      const alerts = transcriptionFallingBehindRule(
        context(metrics, [], {}, null, devices),
      );

      // Assert
      expect(alerts).toHaveLength(0);
    });

    it('fires for a CPU provider at 0.75 (past the CPU threshold)', () => {
      const metrics = new MetricsRegistry();
      observeDutyRatio(metrics, { meanRtf: 0.75 });
      const devices = new Map([['whisper', 'cpu']]);

      // Act
      const alerts = transcriptionFallingBehindRule(
        context(metrics, [], {}, null, devices),
      );

      // Assert
      expect(alerts).toHaveLength(1);
      expect(alerts[0]?.threshold).toBe(0.7);
      expect(alerts[0]?.summary).toContain('threshold 0.70');
    });

    it('uses the GPU threshold (0.45) when no device is reported', () => {
      // Arrange — rolling-upgrade case: the service does not yet send
      // providerDevice, so the map is empty. The GPU default must apply, which
      // is the existing behaviour.
      const metrics = new MetricsRegistry();
      observeDutyRatio(metrics, { meanRtf: 0.5 });

      // Act
      const alerts = transcriptionFallingBehindRule(
        context(metrics, [], {}, null, new Map()),
      );

      // Assert
      expect(alerts).toHaveLength(1);
      expect(alerts[0]?.threshold).toBe(0.45);
    });

    it('a flat override wins over both per-device defaults', () => {
      // Arrange — the operator set ALERT_ASR_DUTY_RATIO=0.9, which app-config
      // applies to both asrDutyRatio and asrDutyRatioCpu. A CPU provider at
      // 0.75 should stay silent, because 0.75 < 0.9.
      const metrics = new MetricsRegistry();
      observeDutyRatio(metrics, { meanRtf: 0.75 });
      const devices = new Map([['whisper', 'cpu']]);

      // Act
      const alerts = transcriptionFallingBehindRule(
        context(
          metrics,
          [],
          { asrDutyRatio: 0.9, asrDutyRatioCpu: 0.9 },
          null,
          devices,
        ),
      );

      // Assert
      expect(alerts).toHaveLength(0);
    });
  });

  describe('transcription overrunning its period on the tail (T1, tail)', (it) => {
    it('fires on the exact dropped-period counter', () => {
      // Arrange — the median pass is comfortable (0.24, a measured p50) so
      // neither sibling rule fires, yet a quarter of the window's periods ran no
      // pass at all. Nothing else in the stack records that: the pool advances
      // past a period it overran without erroring or queueing.
      //
      // 43 of 163 is 26.4%, the share measured live at 3 concurrent sessions,
      // where transcripts per 1000 chunks had already fallen ~19%. A healthy
      // single session measured 11.3% and must stay silent - see the test below.
      const metrics = new MetricsRegistry();
      observeDutyRatio(metrics, { meanRtf: HEALTHY_MEAN_RTF });
      reportsDroppedPeriods(metrics);
      metrics.asrDroppedPeriodsTotal.inc(providerLabels(), DEGRADED_DROPS, NOW);

      // Act
      const alerts = transcriptionTailOverrunRule(context(metrics));

      // Assert
      expect(alerts).toHaveLength(1);
      expect(alerts[0]?.id).toBe('asr-tail-overrun:whisper');
      expect(alerts[0]?.severity).toBe(AlertSeverity.WARNING);
      expect(alerts[0]?.stage).toBe(PipelineStage.TRANSCRIPTION);
      expect(alerts[0]?.failureModes).toContain('T1');
      expect(alerts[0]?.summary).toContain(
        `${String(DEGRADED_DROPS)} of ${String(TAIL_PASSES + DEGRADED_DROPS)} job periods ran no pass at all`,
      );
      expect(alerts[0]?.value).toBeCloseTo(
        DEGRADED_DROPS / (TAIL_PASSES + DEGRADED_DROPS),
      );
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
      // Arrange — one lost period in 121 is 0.83%, two orders of magnitude under
      // the 25% threshold. A rule that fired on one skipped period would fire on
      // every session-onset hiccup.
      const metrics = new MetricsRegistry();
      observeDutyRatio(metrics, { meanRtf: HEALTHY_MEAN_RTF });
      reportsDroppedPeriods(metrics);
      metrics.asrDroppedPeriodsTotal.inc(providerLabels(), 1, NOW);

      // Act
      const alerts = transcriptionTailOverrunRule(context(metrics));

      // Assert
      expect(alerts).toHaveLength(0);
    });

    it('stays silent at the drop share a healthy stack measured', () => {
      // Arrange - 15 of 135 is 11.1%, just under the 11.3% measured live on a
      // healthy single session that was captioning perfectly well. Dropping
      // periods is how this provider self-throttles when its buffer grows, not a
      // fault, and the threshold shipped at 1% before anyone measured that.
      // This is the regression guard on that mistake.
      const metrics = new MetricsRegistry();
      observeDutyRatio(metrics, { meanRtf: HEALTHY_MEAN_RTF });
      reportsDroppedPeriods(metrics);
      metrics.asrDroppedPeriodsTotal.inc(providerLabels(), 15, NOW);

      // Act
      const alerts = transcriptionTailOverrunRule(context(metrics));

      // Assert
      expect(alerts).toHaveLength(0);
    });

    it('stays silent at the p99 a healthy stack measured', () => {
      // Arrange - 2.17 is the measured healthy single-session p99. A fallback at
      // the 1.0 realtime line fired here, which is why it is 3.0.
      const metrics = new MetricsRegistry();
      observeDutyRatio(metrics, { meanRtf: HEALTHY_MEAN_RTF });
      reportsDroppedPeriods(metrics, false);
      setRtfQuantile(metrics, 'p99', 2.17);

      // Act
      const alerts = transcriptionTailOverrunRule(context(metrics));

      // Assert
      expect(alerts).toHaveLength(0);
    });

    it('falls back to the reported p99 when the service does not count drops', () => {
      // Arrange — a transcription-service predating the counter, which is what
      // this sidecar polls during a rolling upgrade.
      //
      // 3.5, not 1.2. The bar is NOT the 1.0 realtime line: a healthy single
      // session measured p99 RTF 2.17 while dropping 11% of its periods and
      // captioning correctly, so "the worst 1% of passes exceeded realtime" is
      // routine here rather than a fault.
      const metrics = new MetricsRegistry();
      observeDutyRatio(metrics, { meanRtf: HEALTHY_MEAN_RTF });
      reportsDroppedPeriods(metrics, false);
      setRtfQuantile(metrics, 'p99', 3.5);

      // Act
      const alerts = transcriptionTailOverrunRule(context(metrics));

      // Assert
      expect(alerts).toHaveLength(1);
      expect(alerts[0]?.summary).toContain('p99 RTF 3.50');
      // The alert has to admit which signal it fired on: the operator cannot
      // ask how many periods were lost.
      expect(alerts[0]?.summary).toContain('does not report dropped periods');
      expect(alerts[0]?.value).toBeCloseTo(3.5);
      expect(alerts[0]?.threshold).toBe(DEFAULT_THRESHOLDS.asrTailP99Rtf);
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

    it('ignores too few passes to read a p99 from', () => {
      // Arrange — the fallback path's floor, which is about percentile
      // resolution and applies to nothing else: a p99 over 60 samples is barely
      // more than the single worst pass, and a rule on that flaps on one slow
      // inference.
      const metrics = new MetricsRegistry();
      observeDutyRatio(metrics, { meanRtf: HEALTHY_MEAN_RTF, jobs: 20 });
      reportsDroppedPeriods(metrics, false);
      setRtfQuantile(metrics, 'p99', 4.0);

      // Act
      const alerts = transcriptionTailOverrunRule(context(metrics));

      // Assert
      expect(alerts).toHaveLength(0);
    });

    it('ignores too few scheduled periods to read a share from', () => {
      // Arrange — the counter path's floor, and a different quantity: 12
      // scheduled periods, half of them dropped. A share that high over a dozen
      // periods is one slow stretch.
      const metrics = new MetricsRegistry();
      observeDutyRatio(metrics, {
        meanRtf: HEALTHY_MEAN_RTF,
        jobs: 2,
        polls: 3,
      });
      reportsDroppedPeriods(metrics);
      metrics.asrDroppedPeriodsTotal.inc(providerLabels(), 6, NOW);

      // Act
      const alerts = transcriptionTailOverrunRule(context(metrics));

      // Assert
      expect(alerts).toHaveLength(0);
    });

    it('reaches a long-period provider the old pass floor locked out', () => {
      // Arrange — 24 scheduled periods is what a 120s window holds at the CPU
      // template's 5000ms `job_period_ms`, a third of them dropped. Under the
      // single 100-pass floor this rule shipped with, no CPU deployment could
      // ever produce this alert, and the shortfall got worse the more periods
      // were dropped — because dropping is what removes the passes.
      const metrics = new MetricsRegistry();
      observeDutyRatio(metrics, {
        meanRtf: HEALTHY_MEAN_RTF,
        jobs: 16,
        polls: 1,
      });
      reportsDroppedPeriods(metrics);
      metrics.asrDroppedPeriodsTotal.inc(providerLabels(), 8, NOW);

      // Act
      const alerts = transcriptionTailOverrunRule(context(metrics));

      // Assert
      expect(alerts).toHaveLength(1);
      expect(alerts[0]?.value).toBeCloseTo(1 / 3, 3);
    });

    it('does not double-report the event the CRITICAL already owns', () => {
      // Arrange — both rules now read the same share, so suppression is a plain
      // ordering: 66.3% is past the 50% CRITICAL bar and therefore past the 25%
      // warning bar too. Without it, one outage would produce two cards.
      const metrics = new MetricsRegistry();
      observeDutyRatio(metrics, { meanRtf: HEALTHY_MEAN_RTF });
      reportsDroppedPeriods(metrics);
      metrics.asrDroppedPeriodsTotal.inc(providerLabels(), COLLAPSE_DROPS, NOW);

      // Act
      const tail = transcriptionTailOverrunRule(context(metrics));
      const critical = transcriptionSaturationRule(context(metrics));

      // Assert — reported exactly once, by the more urgent rule.
      expect(tail).toHaveLength(0);
      expect(critical).toHaveLength(1);
      expect(critical[0]?.severity).toBe(AlertSeverity.CRITICAL);
    });

    it('defers to the legacy p95 CRITICAL on the fallback path', () => {
      // Arrange — an old service, where the CRITICAL still reads p95 RTF.
      // Percentiles are monotone, so a p95 past the bar implies a p99 past it
      // and the two would always co-fire.
      const metrics = new MetricsRegistry();
      observeDutyRatio(metrics, { meanRtf: HEALTHY_MEAN_RTF });
      reportsDroppedPeriods(metrics, false);
      setRtfQuantile(metrics, 'p95', 2.4);
      setRtfQuantile(metrics, 'p99', 4.0);

      // Act
      const tail = transcriptionTailOverrunRule(context(metrics));
      const critical = transcriptionSaturationRule(context(metrics));

      // Assert
      expect(tail).toHaveLength(0);
      expect(critical).toHaveLength(1);
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
        DEGRADED_DROPS,
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

    it('uses the CPU threshold for mean-based suppression, not the GPU one', () => {
      // Arrange — a CPU provider with a mean of 0.5 and enough dropped
      // periods to fire the tail rule. The mean is past the GPU threshold
      // (0.45) but under the CPU threshold (0.7), so
      // suppressedByColderRule must NOT suppress the tail alert — if it
      // used the GPU threshold, it would suppress (0.5 >= 0.45) and the
      // operator would never see the tail warning.
      const metrics = new MetricsRegistry();
      observeDutyRatio(metrics, { meanRtf: 0.5 });
      reportsDroppedPeriods(metrics);
      metrics.asrDroppedPeriodsTotal.inc(providerLabels(), DEGRADED_DROPS, NOW);
      const devices = new Map([['whisper', 'cpu']]);

      // Act
      const tail = transcriptionTailOverrunRule(
        context(metrics, [], {}, null, devices),
      );

      // Assert — the tail alert fires because the mean (0.5) is under the
      // CPU threshold (0.7), so suppression does not kick in.
      expect(tail).toHaveLength(1);
      expect(tail[0]?.id).toBe('asr-tail-overrun:whisper');
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

  describe('buffer overflow and dropped audio (T2)', (it) => {
    it('reports dropped audio as service-side degradation, not client abuse', () => {
      // Arrange — one decode batch the ASR buffer had no room for. This used
      // to be a CRITICAL on UPLINK telling the operator to go looking for a
      // misbehaving client, when the batch is only ever that large because the
      // service itself did not get back to the job in time.
      const metrics = new MetricsRegistry();
      metrics.asrAudioDroppedBufferFullTotal.inc(
        { service: 'transcription-service', providerKey: 'whisper' },
        1,
        NOW,
      );
      metrics.asrAudioDroppedBufferFullSecondsTotal.inc(
        { service: 'transcription-service', providerKey: 'whisper' },
        30.5,
        NOW,
      );

      // Act
      const alerts = bufferOverflowRule(context(metrics));

      // Assert
      expect(alerts).toHaveLength(1);
      const alert = alerts[0];
      expect(alert?.id).toBe('asr-audio-dropped-buffer-full');
      expect(alert?.severity).toBe(AlertSeverity.WARNING);
      expect(alert?.stage).toBe(PipelineStage.TRANSCRIPTION);
      // The seconds are what the operator needs: the count says a batch
      // overran, not how much audio produced no captions.
      expect(alert?.summary).toContain('30.5s');
      // The old text blamed the client. Nothing may put that back.
      expect(alert?.likelyCause).not.toContain('misbehaving');
      expect(alert?.likelyCause).not.toContain('replaying');
    });

    it('stays silent when no audio was dropped', () => {
      // Arrange — force-finalization alone is a different, milder failure: that
      // audio is still transcribed, just cut early.
      const metrics = new MetricsRegistry();

      // Act
      const alerts = bufferOverflowRule(context(metrics));

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
