import { afterEach, beforeEach, describe, expect } from 'vitest';

import { MetricsRegistry } from '#src/server/shared/metrics/metrics-registry.service.js';
import { TranscriptionMetricsPollerService } from '#src/server/shared/transcription-metrics/transcription-metrics-poller.service.js';
import {
  FAKE_PROCESS_UID,
  type FakeTranscriptionMetrics,
  LUMEN_GRANITE,
  WHISPER,
  histogramSeries,
  metricsBody,
  startFakeTranscriptionMetrics,
} from '#tests/fixtures/fake-transcription-metrics.js';

const API_KEY = 'test-metrics-key';
const SERVICE = 'transcription-service';

/**
 * The CUDA template's real periods, per provider. Two providers at different
 * cadences in one deployment is the normal case, not an edge case, which is why
 * the default fixture carries both.
 */
const JOB_PERIODS: ReadonlyMap<string, number> = new Map([
  ['whisper', 500],
  ['lumen_granite', 3_000],
]);

/** Captures log lines, so "said so out loud" can be asserted rather than assumed. */
function createLogger() {
  const warnings: string[] = [];
  const errors: string[] = [];
  const record = (sink: string[]) => {
    return (...args: unknown[]) => {
      sink.push(args.map((arg) => String(arg)).join(' '));
    };
  };
  return {
    warnings,
    errors,
    logger: {
      warn: record(warnings),
      info: () => undefined,
      error: record(errors),
    } as never,
  };
}

describe('transcription-service metrics poller (B1.2 PR 5)', () => {
  let service: FakeTranscriptionMetrics;

  beforeEach(async () => {
    service = await startFakeTranscriptionMetrics(API_KEY);
  });

  afterEach(async () => {
    await service.close();
  });

  /**
   * Builds a poller and takes it past its priming poll.
   *
   * The first successful poll of a poller's life only records baselines — the
   * endpoint reports totals since the service booted, and a sidecar started
   * beside a long-running one would otherwise fold that whole history into a
   * single increment stamped `now`, firing every windowed rule on events that
   * predate it. Priming against an all-zero body seeds those baselines at zero,
   * so each test's own first poll differences from zero exactly as it reads.
   */
  async function createPoller(
    apiKey = API_KEY,
    jobPeriodMsByProvider: ReadonlyMap<string, number> = JOB_PERIODS,
    jobPeriodSpecErrors: readonly string[] = [],
  ) {
    const metrics = new MetricsRegistry();
    const { logger, warnings, errors } = createLogger();
    const poller = new TranscriptionMetricsPollerService(
      {
        enabled: apiKey.length > 0,
        intervalMs: 60_000,
        timeoutMs: 2_000,
        service: SERVICE,
        statusUrl: service.statusUrl,
        apiKey,
        jobPeriodMsByProvider,
        jobPeriodSpecErrors,
      },
      metrics,
      logger,
    );
    // Only a poll that can succeed primes anything: a wrong key produces a
    // failed poll, and priming with one would leave an error already counted
    // before the test acts.
    if (apiKey === API_KEY) {
      service.setBody(metricsBody());
      await poller.pollOnce();
    }
    return { metrics, poller, warnings, errors };
  }

  const providerLabels = { service: SERVICE, providerKey: 'whisper' };

  describe('counters', (it) => {
    it('adds only the difference between successive polls', async () => {
      // Arrange — the endpoint reports totals since its process booted, so
      // inc()-ing what is read would count every prior event again each poll.
      const { metrics, poller } = await createPoller();
      service.setBody(
        metricsBody({
          counters: { bufferOverflowTotal: [{ labels: WHISPER, value: 4 }] },
        }),
      );
      await poller.pollOnce();

      // Act
      service.setBody(
        metricsBody({
          counters: { bufferOverflowTotal: [{ labels: WHISPER, value: 7 }] },
        }),
      );
      await poller.pollOnce();

      // Assert
      expect(metrics.asrBufferOverflowTotal.get(providerLabels)).toBe(7);
    });

    it('records baselines on its first poll rather than folding a lifetime', async () => {
      // Arrange — a sidecar restarted beside a transcription-service that has
      // been up for days. Without priming, `previous` defaults to 0 and that
      // service's whole history lands as one increment stamped `now`: every raw
      // windowed rule fires immediately (`decodeDropRule` at 10,
      // `bufferOverflowRule` at 5) on events that predate the sidecar, then
      // clears itself one window later. This is the poller constructed directly
      // rather than through the helper, because the helper's whole job is to
      // hide the poll under test.
      const metrics = new MetricsRegistry();
      const { logger } = createLogger();
      const poller = new TranscriptionMetricsPollerService(
        {
          enabled: true,
          intervalMs: 60_000,
          timeoutMs: 2_000,
          service: SERVICE,
          statusUrl: service.statusUrl,
          apiKey: API_KEY,
          jobPeriodMsByProvider: JOB_PERIODS,
          jobPeriodSpecErrors: [],
        },
        metrics,
        logger,
      );
      service.setBody(
        metricsBody({
          counters: {
            bufferOverflowTotal: [{ labels: WHISPER, value: 9_000 }],
          },
        }),
      );

      // Act
      await poller.pollOnce();

      // Assert — nothing counted, but the baseline is set, so the next real
      // event is measured against 9000 rather than against zero.
      expect(metrics.asrBufferOverflowTotal.get(providerLabels)).toBe(0);
      service.setBody(
        metricsBody({
          counters: {
            bufferOverflowTotal: [{ labels: WHISPER, value: 9_003 }],
          },
        }),
      );
      await poller.pollOnce();
      expect(metrics.asrBufferOverflowTotal.get(providerLabels)).toBe(3);
    });

    it('differences the RTF histogram’s lifetime sum and count', async () => {
      // Arrange — the two fields the T1 early-warning rule averages. They are
      // lifetime totals like any counter, so only the delta may be folded;
      // taking them absolutely would recount every job on every poll and pin the
      // windowed mean to the process’s whole history.
      const { metrics, poller } = await createPoller();
      service.setBody(
        metricsBody({
          histograms: {
            asrRtf: [histogramSeries(0.5, { count: 100, sum: 50 })],
          },
        }),
      );
      await poller.pollOnce();

      // Act — 20 further jobs averaging 0.9.
      service.setBody(
        metricsBody({
          histograms: {
            asrRtf: [histogramSeries(0.9, { count: 120, sum: 68 })],
          },
        }),
      );
      await poller.pollOnce();

      // Assert
      expect(metrics.asrDutyRatioJobsTotal.get(providerLabels)).toBe(120);
      expect(metrics.asrDutyRatioSumTotal.get(providerLabels)).toBe(68);
    });

    it('folds dropped periods and records that they are being reported', async () => {
      // Arrange — the exact count of periods in which no pass ran. It is the one
      // counter here that describes the scheduler rather than the work, and the
      // support gauge is what lets the tail alert tell a reported zero from a
      // service too old to count at all.
      const { metrics, poller } = await createPoller();
      service.setBody(
        metricsBody({
          counters: {
            asrDroppedPeriodsTotal: [{ labels: WHISPER, value: 12 }],
          },
        }),
      );
      await poller.pollOnce();

      // Act
      service.setBody(
        metricsBody({
          counters: {
            asrDroppedPeriodsTotal: [{ labels: WHISPER, value: 19 }],
          },
        }),
      );
      await poller.pollOnce();

      // Assert
      expect(metrics.asrDroppedPeriodsTotal.get(providerLabels)).toBe(19);
      expect(metrics.asrDroppedPeriodsSupported.get({ service: SERVICE })).toBe(
        1,
      );
    });

    it('reports no dropped-period support for a service too old to send it', async () => {
      // Arrange — the rolling-upgrade case, and the reason the field is optional:
      // an older transcription-service must still produce a healthy poll. A
      // healthy *new* service sends an empty array, which creates no series here
      // either, so the gauge is the only thing that separates the two.
      const { metrics, poller } = await createPoller();
      service.setBody(metricsBody());

      // Act
      const result = await poller.pollOnce();

      // Assert
      expect(result.ok).toBe(true);
      expect(metrics.asrDroppedPeriodsSupported.get({ service: SERVICE })).toBe(
        0,
      );
      expect(metrics.asrDroppedPeriodsTotal.entries()).toHaveLength(0);
    });

    it('maps the two no-speech counters onto one kind-labelled series', async () => {
      // Arrange — the retired log parser produced this exact shape, so no
      // downstream rule had to change when the source did.
      const { metrics, poller } = await createPoller();
      service.setBody(
        metricsBody({
          counters: {
            vadNoSpeechTotal: [{ labels: WHISPER, value: 3 }],
            noWordsTotal: [{ labels: WHISPER, value: 5 }],
          },
        }),
      );

      // Act
      await poller.pollOnce();

      // Assert
      expect(
        metrics.asrNoSpeechTotal.get({
          ...providerLabels,
          kind: 'vad_no_speech',
        }),
      ).toBe(3);
      expect(
        metrics.asrNoSpeechTotal.get({ ...providerLabels, kind: 'no_words' }),
      ).toBe(5);
    });

    it('folds decode drops onto the transcription side of the shared series', async () => {
      // Arrange — same metric as node-server's, separated only by `side`. This
      // is the series the retired Python parser used to write.
      const { metrics, poller } = await createPoller();
      service.setBody(
        metricsBody({
          counters: { decodeDropsTotal: [{ labels: WHISPER, value: 2 }] },
        }),
      );

      // Act
      await poller.pollOnce();

      // Assert
      expect(
        metrics.safpDecodeDropsTotal.get({
          service: SERVICE,
          side: 'transcription',
        }),
      ).toBe(2);
      expect(
        metrics.safpDecodeDropsTotal.get({ service: SERVICE, side: 'node' }),
      ).toBe(0);
    });

    it('keeps the failure reason label, which is an exception class', async () => {
      // Arrange
      const { metrics, poller } = await createPoller();
      service.setBody(
        metricsBody({
          counters: {
            jobsFailedTotal: [
              {
                labels: { ...WHISPER, reason: 'TranscriptionClientError' },
                value: 6,
              },
            ],
          },
        }),
      );

      // Act
      await poller.pollOnce();

      // Assert
      expect(
        metrics.asrJobsFailedTotal.get({
          ...providerLabels,
          reason: 'TranscriptionClientError',
        }),
      ).toBe(6);
    });

    it('labels a series carrying no provider as unknown rather than dropping it', async () => {
      // Arrange — the Python side substitutes "unknown" itself, but an absent
      // label must not silently discard the count either.
      const { metrics, poller } = await createPoller();
      service.setBody(
        metricsBody({
          counters: {
            audioDroppedBufferFullTotal: [{ labels: {}, value: 1 }],
          },
        }),
      );

      // Act
      await poller.pollOnce();

      // Assert
      expect(
        metrics.asrAudioDroppedBufferFullTotal.get({
          service: SERVICE,
          providerKey: 'unknown',
        }),
      ).toBe(1);
    });

    it('folds dropped audio and the seconds it cost as separate series', async () => {
      // Arrange — the count says a batch overran, the seconds say how much
      // audio never reached the ASR. Only the second one describes the damage.
      const { metrics, poller } = await createPoller();
      service.setBody(
        metricsBody({
          counters: {
            audioDroppedBufferFullTotal: [{ labels: WHISPER, value: 2 }],
            audioDroppedBufferFullSecondsTotal: [
              { labels: WHISPER, value: 31.5 },
            ],
          },
        }),
      );

      // Act
      await poller.pollOnce();

      // Assert
      expect(metrics.asrAudioDroppedBufferFullTotal.get(providerLabels)).toBe(
        2,
      );
      expect(
        metrics.asrAudioDroppedBufferFullSecondsTotal.get(providerLabels),
      ).toBe(31.5);
    });

    it('polls a service too old to report dropped audio without failing', async () => {
      // Arrange — the counter was renamed from `audioTooFastTotal`, so during a
      // rolling upgrade the sidecar polls a service that sends neither new
      // field. Both are optional precisely so that stays a poll with no drops
      // rather than a `malformed` response taking every transcription metric
      // down with it.
      const { metrics, poller, errors } = await createPoller();
      const body = metricsBody({
        counters: { bufferOverflowTotal: [{ labels: WHISPER, value: 4 }] },
      });
      const counters = body.counters as Record<string, unknown>;
      delete counters['audioDroppedBufferFullTotal'];
      delete counters['audioDroppedBufferFullSecondsTotal'];
      counters['audioTooFastTotal'] = [{ labels: WHISPER, value: 9 }];
      service.setBody(body);

      // Act
      await poller.pollOnce();

      // Assert — the poll succeeded and its other counters landed, and the
      // retired name was ignored rather than folded into the new metric.
      expect(errors).toEqual([]);
      expect(metrics.asrBufferOverflowTotal.get(providerLabels)).toBe(4);
      expect(metrics.asrAudioDroppedBufferFullTotal.get(providerLabels)).toBe(
        0,
      );
    });

    it('folds binary-before-auth and binary-before-config drops per provider', async () => {
      // Arrange — the reconnect-loop fix's counters. Two providers, since a
      // multi-provider deployment must not conflate one's drops with another's.
      const { metrics, poller } = await createPoller();
      service.setBody(
        metricsBody({
          counters: {
            binaryDroppedBeforeAuthTotal: [
              { labels: WHISPER, value: 2 },
              { labels: LUMEN_GRANITE, value: 5 },
            ],
            binaryDroppedBeforeConfigTotal: [{ labels: WHISPER, value: 3 }],
          },
        }),
      );

      // Act
      await poller.pollOnce();

      // Assert
      expect(metrics.asrBinaryDroppedBeforeAuthTotal.get(providerLabels)).toBe(
        2,
      );
      expect(
        metrics.asrBinaryDroppedBeforeAuthTotal.get({
          service: SERVICE,
          providerKey: 'lumen_granite',
        }),
      ).toBe(5);
      expect(
        metrics.asrBinaryDroppedBeforeConfigTotal.get(providerLabels),
      ).toBe(3);
    });

    it('differences binary-before-auth and binary-before-config across polls', async () => {
      // Arrange — these are lifetime totals like every other counter here, so
      // only the delta between polls may land, not the reported figure itself.
      const { metrics, poller } = await createPoller();
      service.setBody(
        metricsBody({
          counters: {
            binaryDroppedBeforeAuthTotal: [{ labels: WHISPER, value: 4 }],
            binaryDroppedBeforeConfigTotal: [{ labels: WHISPER, value: 6 }],
          },
        }),
      );
      await poller.pollOnce();

      // Act
      service.setBody(
        metricsBody({
          counters: {
            binaryDroppedBeforeAuthTotal: [{ labels: WHISPER, value: 9 }],
            binaryDroppedBeforeConfigTotal: [{ labels: WHISPER, value: 8 }],
          },
        }),
      );
      await poller.pollOnce();

      // Assert — the running total tracks the endpoint's own lifetime figure,
      // which is only true if each poll folded a delta rather than re-adding
      // the reported total (that bug would have left auth at 13, not 9).
      expect(metrics.asrBinaryDroppedBeforeAuthTotal.get(providerLabels)).toBe(
        9,
      );
      expect(
        metrics.asrBinaryDroppedBeforeConfigTotal.get(providerLabels),
      ).toBe(8);
    });

    it('polls a service too old to report binary-before-auth/config drops without failing', async () => {
      // Arrange — both fields are optional precisely so that a
      // transcription-service predating the reconnect-loop fix still produces
      // a healthy poll instead of a `malformed` one that takes every
      // transcription metric down with it. The default fixture body already
      // omits both fields; this test asserts that omission is handled, not
      // just unexercised.
      const { metrics, poller, errors } = await createPoller();
      service.setBody(
        metricsBody({
          counters: { bufferOverflowTotal: [{ labels: WHISPER, value: 1 }] },
        }),
      );

      // Act
      await poller.pollOnce();

      // Assert — the poll succeeded, its other counters landed, and absence
      // recorded no increment rather than a reported zero.
      expect(errors).toEqual([]);
      expect(metrics.asrBufferOverflowTotal.get(providerLabels)).toBe(1);
      expect(metrics.asrBinaryDroppedBeforeAuthTotal.entries()).toHaveLength(0);
      expect(metrics.asrBinaryDroppedBeforeConfigTotal.entries()).toHaveLength(
        0,
      );
    });
  });

  describe('quantile gauges', (it) => {
    it('republishes reported percentiles as a quantile-labelled gauge', async () => {
      // Arrange — the endpoint sends pre-computed percentiles, not samples, so
      // there is nothing to rebuild a histogram from.
      const { metrics, poller } = await createPoller();
      service.setBody(
        metricsBody({
          histograms: {
            asrRtf: [histogramSeries(0.5, { p95: 1.3, max: 2.0 })],
          },
        }),
      );

      // Act
      await poller.pollOnce();

      // Assert
      expect(metrics.asrRtf.get({ ...providerLabels, quantile: 'p95' })).toBe(
        1.3,
      );
      expect(metrics.asrRtf.get({ ...providerLabels, quantile: 'p50' })).toBe(
        0.5,
      );
      expect(metrics.asrRtf.get({ ...providerLabels, quantile: 'max' })).toBe(
        2.0,
      );
    });

    it('derives period utilization from execution time and the job period', async () => {
      // Arrange — a job taking 1.5x its 500 ms period is over the saturation line.
      const { metrics, poller } = await createPoller();
      service.setBody(
        metricsBody({
          histograms: { asrExecutionMs: [histogramSeries(750)] },
        }),
      );

      // Act
      await poller.pollOnce();

      // Assert
      expect(
        metrics.asrPeriodUtilization.get({
          ...providerLabels,
          quantile: 'p95',
        }),
      ).toBeCloseTo(1.5);
    });

    it('scales each provider by its own period, not by one global number', async () => {
      // Arrange — the bug this test exists for. A deployment serves whisper at
      // 500 ms and lumen_granite at 3000 ms simultaneously (both are in the
      // shipped CUDA template), and both providers here spend exactly 1500 ms per
      // pass: whisper is 3x over its budget, lumen_granite is at half of its. A
      // single denominator has to be wrong for one of them, silently.
      const { metrics, poller } = await createPoller();
      service.setBody(
        metricsBody({
          providerKeys: ['whisper', 'lumen_granite'],
          histograms: {
            asrExecutionMs: [
              histogramSeries(1_500),
              histogramSeries(1_500, { labels: LUMEN_GRANITE }),
            ],
          },
        }),
      );

      // Act
      await poller.pollOnce();

      // Assert
      expect(
        metrics.asrPeriodUtilization.get({
          ...providerLabels,
          quantile: 'p95',
        }),
      ).toBeCloseTo(3.0);
      expect(
        metrics.asrPeriodUtilization.get({
          service: SERVICE,
          providerKey: 'lumen_granite',
          quantile: 'p95',
        }),
      ).toBeCloseTo(0.5);
    });

    it('publishes the denominator it used, and where the number came from', async () => {
      // Arrange — the period is the one input the sidecar cannot verify, so it is
      // exported beside the ratio: an operator comparing it against
      // provider_config.json can see a mismatch that would otherwise be invisible.
      const { metrics, poller } = await createPoller();
      service.setBody(
        metricsBody({
          histograms: { asrExecutionMs: [histogramSeries(750)] },
        }),
      );

      // Act
      await poller.pollOnce();

      // Assert
      expect(
        metrics.asrJobPeriodMs.get({
          ...providerLabels,
          source: 'configured',
        }),
      ).toBe(500);
    });

    it('publishes no utilization for a provider whose period is unknown', async () => {
      // Arrange — a provider the operator never listed. A missing series is the
      // honest answer; a ratio scaled by a default would look like a measurement
      // and read as healthy or saturated purely by luck. `debug` is the real
      // case: it has no job_period_ms in provider_config.json at all.
      const { metrics, poller, warnings } = await createPoller();
      service.setBody(
        metricsBody({
          providerKeys: ['debug'],
          histograms: {
            asrExecutionMs: [
              histogramSeries(750, { labels: { provider_key: 'debug' } }),
            ],
            asrRtf: [
              histogramSeries(0.4, { labels: { provider_key: 'debug' } }),
            ],
          },
        }),
      );

      // Act
      await poller.pollOnce();

      // Assert — no ratio, no denominator, but everything the service measured
      // itself is still published, and the omission is stated once.
      const debug = { service: SERVICE, providerKey: 'debug' };
      expect(
        metrics.asrPeriodUtilization.get({ ...debug, quantile: 'p95' }),
      ).toBeUndefined();
      expect(
        metrics.asrJobPeriodMs.get({ ...debug, source: 'configured' }),
      ).toBeUndefined();
      expect(metrics.asrRtf.get({ ...debug, quantile: 'p95' })).toBe(0.4);
      expect(metrics.asrExecutionMs.get({ ...debug, quantile: 'p95' })).toBe(
        750,
      );
      expect(warnings.filter((line) => line.includes('debug'))).toHaveLength(1);
    });

    it('says a missing period once rather than on every poll', async () => {
      // Arrange — a 10 s cadence would otherwise write thousands of identical
      // lines, the same reason the base class logs poll failures on transition.
      const { poller, warnings } = await createPoller(API_KEY, new Map());
      service.setBody(
        metricsBody({ histograms: { asrExecutionMs: [histogramSeries(750)] } }),
      );

      // Act
      await poller.pollOnce();
      await poller.pollOnce();
      await poller.pollOnce();

      // Assert
      expect(warnings.filter((line) => line.includes('whisper'))).toHaveLength(
        1,
      );
    });

    it('prefers a period transcription-service reports over the configured one', async () => {
      // Arrange — the fix for the duplication itself. `providerJobPeriodMs` is not
      // on the wire yet; when it arrives, the reported value wins because it is
      // what the service is actually scheduling with, while the configured one is
      // a number hand-copied out of a file that may since have changed.
      const { metrics, poller } = await createPoller();
      service.setBody(
        metricsBody({
          providerJobPeriodMs: { whisper: 1_500 },
          histograms: { asrExecutionMs: [histogramSeries(750)] },
        }),
      );

      // Act
      await poller.pollOnce();

      // Assert
      expect(
        metrics.asrPeriodUtilization.get({
          ...providerLabels,
          quantile: 'p95',
        }),
      ).toBeCloseTo(0.5);
      expect(
        metrics.asrJobPeriodMs.get({ ...providerLabels, source: 'reported' }),
      ).toBe(1_500);
      // Not two series for one provider: the stale provenance is removed.
      expect(
        metrics.asrJobPeriodMs.get({ ...providerLabels, source: 'configured' }),
      ).toBeUndefined();
    });

    it('drops a utilization series whose period stopped being known', async () => {
      // Arrange — a reported period that goes away must not leave the last ratio
      // frozen in place, which would keep asserting a utilization the sidecar can
      // no longer compute.
      const { metrics, poller } = await createPoller(API_KEY, new Map());
      const executionSeries = { asrExecutionMs: [histogramSeries(750)] };
      service.setBody(
        metricsBody({
          providerJobPeriodMs: { whisper: 500 },
          histograms: executionSeries,
        }),
      );
      await poller.pollOnce();
      expect(
        metrics.asrPeriodUtilization.get({
          ...providerLabels,
          quantile: 'p95',
        }),
      ).toBeCloseTo(1.5);

      // Act — the service stops reporting the period, and nothing is configured.
      service.setBody(metricsBody({ histograms: executionSeries }));
      await poller.pollOnce();

      // Assert
      expect(
        metrics.asrPeriodUtilization.get({
          ...providerLabels,
          quantile: 'p95',
        }),
      ).toBeUndefined();
      expect(
        metrics.asrJobPeriodMs.get({ ...providerLabels, source: 'reported' }),
      ).toBeUndefined();
    });

    it('logs a rejected TRANSCRIPTION_JOB_PERIOD_MS instead of failing quietly', async () => {
      // Arrange — the pre-per-provider format. The series is lost, which is the
      // safe direction, so the log line is the only thing standing between the
      // operator and a silently empty panel.
      const { poller, errors } = await createPoller(API_KEY, new Map(), [
        'TRANSCRIPTION_JOB_PERIOD_MS="1000" is a single global period',
      ]);

      // Act
      await poller.pollOnce();

      // Assert
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain('scribear_asr_period_utilization');
    });

    it('skips a series whose sample ring is empty', async () => {
      // Arrange — a provider with no retained samples reports structural zeroes,
      // and a p95 of 0 would read as a healthy measurement rather than as no
      // measurement at all.
      const { metrics, poller } = await createPoller();
      service.setBody(
        metricsBody({
          histograms: { asrRtf: [histogramSeries(0, { sampleCount: 0 })] },
        }),
      );

      // Act
      await poller.pollOnce();

      // Assert
      expect(
        metrics.asrRtf.get({ ...providerLabels, quantile: 'p95' }),
      ).toBeUndefined();
    });

    it('forgets a provider whose series stopped being reported', async () => {
      // Arrange — a stale p95 left behind would keep the T1 saturation alert
      // firing long after the load stopped.
      const { metrics, poller } = await createPoller();
      service.setBody(
        metricsBody({
          histograms: {
            asrRtf: [histogramSeries(2.0)],
            asrExecutionMs: [histogramSeries(750)],
          },
        }),
      );
      await poller.pollOnce();
      expect(metrics.asrRtf.get({ ...providerLabels, quantile: 'p95' })).toBe(
        2.0,
      );
      expect(
        metrics.asrJobPeriodMs.get({ ...providerLabels, source: 'configured' }),
      ).toBe(500);

      // Act
      service.setBody(metricsBody());
      await poller.pollOnce();

      // Assert — the published denominator goes with it: a period for a provider
      // that no longer exists is as stale as the ratio derived from it.
      expect(
        metrics.asrRtf.get({ ...providerLabels, quantile: 'p95' }),
      ).toBeUndefined();
      expect(
        metrics.asrPeriodUtilization.get({
          ...providerLabels,
          quantile: 'p95',
        }),
      ).toBeUndefined();
      expect(
        metrics.asrJobPeriodMs.get({ ...providerLabels, source: 'configured' }),
      ).toBeUndefined();
    });
  });

  describe('worker gauges', (it) => {
    it('reports the configured worker count and per-worker state', async () => {
      // Arrange — numWorkers answers one of the two inputs the master plan has
      // carried open since the first session.
      const { metrics, poller } = await createPoller();
      service.setBody(
        metricsBody({
          numWorkers: 2,
          workers: [
            {
              workerId: 0,
              utilization: 0.75,
              liveJobCount: 3,
              totalJobsRegistered: 40,
              contextIds: [1, 2],
              alive: true,
            },
          ],
        }),
      );

      // Act
      await poller.pollOnce();

      // Assert
      const worker = { service: SERVICE, workerId: '0' };
      expect(metrics.asrWorkers.get({ service: SERVICE })).toBe(2);
      expect(metrics.asrWorkerUtilization.get(worker)).toBe(0.75);
      expect(metrics.asrWorkerLiveJobs.get(worker)).toBe(3);
      expect(metrics.asrWorkerContexts.get(worker)).toBe(2);
      expect(metrics.asrWorkerJobsRegisteredTotal.get(worker)).toBe(40);
      expect(metrics.asrWorkerAlive.get(worker)).toBe(1);
    });

    it('reports a worker that exited as not alive', async () => {
      // Arrange — the quietest failure in the stack: nothing in the pool
      // notices, so this gauge is the only signal.
      const { metrics, poller } = await createPoller();
      service.setBody(
        metricsBody({
          numWorkers: 1,
          workers: [
            {
              workerId: 0,
              utilization: 1.0,
              liveJobCount: 2,
              totalJobsRegistered: 9,
              contextIds: [1],
              alive: false,
            },
          ],
        }),
      );

      // Act
      await poller.pollOnce();

      // Assert
      expect(
        metrics.asrWorkerAlive.get({ service: SERVICE, workerId: '0' }),
      ).toBe(0);
    });

    it('drops gauges for a worker that disappeared', async () => {
      // Arrange
      const { metrics, poller } = await createPoller();
      const worker = {
        workerId: 0,
        utilization: 0.5,
        liveJobCount: 1,
        totalJobsRegistered: 10,
        contextIds: [1],
        alive: true,
      };
      service.setBody(metricsBody({ workers: [worker] }));
      await poller.pollOnce();

      // Act
      service.setBody(metricsBody({ workers: [] }));
      await poller.pollOnce();

      // Assert
      expect(
        metrics.asrWorkerUtilization.get({ service: SERVICE, workerId: '0' }),
      ).toBeUndefined();
    });
  });

  describe('restart handling', (it) => {
    it('attributes a restarted process totals in full rather than negatively', async () => {
      // Arrange
      const { metrics, poller } = await createPoller();
      service.setBody(
        metricsBody({
          counters: { jobsCompletedTotal: [{ labels: WHISPER, value: 100 }] },
        }),
      );
      await poller.pollOnce();

      // Act — new process, counters back near zero
      service.setBody(
        metricsBody({
          processUid: 'tx-process-2',
          counters: { jobsCompletedTotal: [{ labels: WHISPER, value: 5 }] },
        }),
      );
      const result = await poller.pollOnce();

      // Assert
      expect(result.restarted).toBe(true);
      expect(metrics.asrJobsCompletedTotal.get(providerLabels)).toBe(105);
      expect(
        metrics.serviceProcessRestartsTotal.get({ service: SERVICE }),
      ).toBe(1);
    });

    it('does not call the first poll a restart', async () => {
      // Arrange
      const { metrics, poller } = await createPoller();

      // Act
      const result = await poller.pollOnce();

      // Assert
      expect(result.restarted).toBe(false);
      expect(result.processUid).toBe(FAKE_PROCESS_UID);
      expect(metrics.serviceProcessRestartsTotal.total()).toBe(0);
    });
  });

  describe('failure handling', (it) => {
    it('reports a 404 as not-found, not as a transport error', async () => {
      // Arrange — transcription-service leaves the route unregistered when its
      // own METRICS_API_KEY is empty, which is a configuration answer rather
      // than an outage. Conflating it with http-error would send an operator
      // looking at the network.
      const { metrics, poller } = await createPoller();
      service.setFailure(404);

      // Act
      const result = await poller.pollOnce();

      // Assert
      expect(result.ok).toBe(false);
      expect(result.reason).toBe('not-found');
      expect(
        metrics.serviceStatusPollErrorsTotal.get({
          service: SERVICE,
          reason: 'not-found',
        }),
      ).toBe(1);
      expect(metrics.serviceStatusUp.get({ service: SERVICE })).toBe(0);
    });

    it('distinguishes a rejected key from an unreachable service', async () => {
      // Arrange
      const { metrics, poller } = await createPoller('wrong-key');

      // Act
      const result = await poller.pollOnce();

      // Assert
      expect(result.reason).toBe('unauthorized');
      expect(
        metrics.serviceStatusPollErrorsTotal.get({
          service: SERVICE,
          reason: 'unauthorized',
        }),
      ).toBe(1);
    });

    it('rejects a body that does not match the schema', async () => {
      // Arrange — a service on a different contract must fail loudly rather
      // than half-populate metrics.
      const { metrics, poller } = await createPoller();
      service.setMalformed(true);

      // Act
      const result = await poller.pollOnce();

      // Assert
      expect(result.reason).toBe('malformed');
      expect(metrics.serviceStatusUp.get({ service: SERVICE })).toBe(0);
    });

    it('preserves collected counters across a failed poll', async () => {
      // Arrange
      const { metrics, poller } = await createPoller();
      service.setBody(
        metricsBody({
          counters: { jobsCompletedTotal: [{ labels: WHISPER, value: 9 }] },
        }),
      );
      await poller.pollOnce();

      // Act
      service.setFailure(500);
      await poller.pollOnce();

      // Assert
      expect(metrics.asrJobsCompletedTotal.get(providerLabels)).toBe(9);
    });

    it('recovers once the endpoint answers again', async () => {
      // Arrange
      const { metrics, poller } = await createPoller();
      service.setFailure(500);
      await poller.pollOnce();

      // Act
      service.setFailure(null);
      const result = await poller.pollOnce();

      // Assert
      expect(result.ok).toBe(true);
      expect(metrics.serviceStatusUp.get({ service: SERVICE })).toBe(1);
    });

    it('sends the key as a bearer token', async () => {
      // Arrange
      const { poller } = await createPoller();

      // Act
      await poller.pollOnce();

      // Assert — every request, including the priming poll, carries it.
      expect(service.authHeaders.length).toBeGreaterThan(0);
      expect(
        service.authHeaders.every((header) => header === `Bearer ${API_KEY}`),
      ).toBe(true);
    });
  });

  describe('disabled', (it) => {
    it('does not poll at all without a key', async () => {
      // Arrange — fail closed rather than 401 on every interval forever. A
      // disabled poller is not primed either; there is nothing to prime against.
      const { poller } = await createPoller('');

      // Act
      poller.start();

      // Assert
      expect(service.authHeaders).toEqual([]);
      expect(poller.lastResult).toBeNull();
      poller.stop();
    });
  });
});
