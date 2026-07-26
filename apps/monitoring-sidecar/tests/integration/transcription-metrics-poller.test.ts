import { afterEach, beforeEach, describe, expect } from 'vitest';

import { MetricsRegistry } from '#src/server/shared/metrics/metrics-registry.service.js';
import { TranscriptionMetricsPollerService } from '#src/server/shared/transcription-metrics/transcription-metrics-poller.service.js';
import {
  FAKE_PROCESS_UID,
  type FakeTranscriptionMetrics,
  WHISPER,
  histogramSeries,
  metricsBody,
  startFakeTranscriptionMetrics,
} from '#tests/fixtures/fake-transcription-metrics.js';

const API_KEY = 'test-metrics-key';
const SERVICE = 'transcription-service';
const JOB_PERIOD_MS = 1_000;

const logger = {
  warn: () => undefined,
  info: () => undefined,
  error: () => undefined,
} as never;

describe('transcription-service metrics poller (B1.2 PR 5)', () => {
  let service: FakeTranscriptionMetrics;

  beforeEach(async () => {
    service = await startFakeTranscriptionMetrics(API_KEY);
  });

  afterEach(async () => {
    await service.close();
  });

  function createPoller(apiKey = API_KEY, jobPeriodMs = JOB_PERIOD_MS) {
    const metrics = new MetricsRegistry();
    const poller = new TranscriptionMetricsPollerService(
      {
        enabled: apiKey.length > 0,
        intervalMs: 60_000,
        timeoutMs: 2_000,
        service: SERVICE,
        statusUrl: service.statusUrl,
        apiKey,
        jobPeriodMs,
      },
      metrics,
      logger,
    );
    return { metrics, poller };
  }

  const providerLabels = { service: SERVICE, providerKey: 'whisper' };

  describe('counters', (it) => {
    it('adds only the difference between successive polls', async () => {
      // Arrange — the endpoint reports totals since its process booted, so
      // inc()-ing what is read would count every prior event again each poll.
      const { metrics, poller } = createPoller();
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

    it('differences the RTF histogram’s lifetime sum and count', async () => {
      // Arrange — the two fields the T1 early-warning rule averages. They are
      // lifetime totals like any counter, so only the delta may be folded;
      // taking them absolutely would recount every job on every poll and pin the
      // windowed mean to the process’s whole history.
      const { metrics, poller } = createPoller();
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

    it('maps the two no-speech counters onto one kind-labelled series', async () => {
      // Arrange — the retired log parser produced this exact shape, so no
      // downstream rule had to change when the source did.
      const { metrics, poller } = createPoller();
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
      const { metrics, poller } = createPoller();
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
      const { metrics, poller } = createPoller();
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
      const { metrics, poller } = createPoller();
      service.setBody(
        metricsBody({
          counters: { audioTooFastTotal: [{ labels: {}, value: 1 }] },
        }),
      );

      // Act
      await poller.pollOnce();

      // Assert
      expect(
        metrics.asrAudioTooFastTotal.get({
          service: SERVICE,
          providerKey: 'unknown',
        }),
      ).toBe(1);
    });
  });

  describe('quantile gauges', (it) => {
    it('republishes reported percentiles as a quantile-labelled gauge', async () => {
      // Arrange — the endpoint sends pre-computed percentiles, not samples, so
      // there is nothing to rebuild a histogram from.
      const { metrics, poller } = createPoller();
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
      // Arrange — a job taking 1.5x its period is over the saturation line.
      const { metrics, poller } = createPoller();
      service.setBody(
        metricsBody({
          histograms: { asrExecutionMs: [histogramSeries(1_500)] },
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

    it('skips a series whose sample ring is empty', async () => {
      // Arrange — a provider with no retained samples reports structural zeroes,
      // and a p95 of 0 would read as a healthy measurement rather than as no
      // measurement at all.
      const { metrics, poller } = createPoller();
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
      const { metrics, poller } = createPoller();
      service.setBody(
        metricsBody({ histograms: { asrRtf: [histogramSeries(2.0)] } }),
      );
      await poller.pollOnce();
      expect(metrics.asrRtf.get({ ...providerLabels, quantile: 'p95' })).toBe(
        2.0,
      );

      // Act
      service.setBody(metricsBody());
      await poller.pollOnce();

      // Assert
      expect(
        metrics.asrRtf.get({ ...providerLabels, quantile: 'p95' }),
      ).toBeUndefined();
    });
  });

  describe('worker gauges', (it) => {
    it('reports the configured worker count and per-worker state', async () => {
      // Arrange — numWorkers answers one of the two inputs the master plan has
      // carried open since the first session.
      const { metrics, poller } = createPoller();
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
      const { metrics, poller } = createPoller();
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
      const { metrics, poller } = createPoller();
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
      const { metrics, poller } = createPoller();
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
      const { metrics, poller } = createPoller();

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
      const { metrics, poller } = createPoller();
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
      const { metrics, poller } = createPoller('wrong-key');

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
      const { metrics, poller } = createPoller();
      service.setMalformed(true);

      // Act
      const result = await poller.pollOnce();

      // Assert
      expect(result.reason).toBe('malformed');
      expect(metrics.serviceStatusUp.get({ service: SERVICE })).toBe(0);
    });

    it('preserves collected counters across a failed poll', async () => {
      // Arrange
      const { metrics, poller } = createPoller();
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
      const { metrics, poller } = createPoller();
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
      const { poller } = createPoller();

      // Act
      await poller.pollOnce();

      // Assert
      expect(service.authHeaders).toEqual([`Bearer ${API_KEY}`]);
    });
  });

  describe('disabled', (it) => {
    it('does not poll at all without a key', () => {
      // Arrange — fail closed rather than 401 on every interval forever.
      const { poller } = createPoller('');

      // Act
      poller.start();

      // Assert
      expect(service.authHeaders).toEqual([]);
      expect(poller.lastResult).toBeNull();
      poller.stop();
    });
  });
});
