import { describe, expect } from 'vitest';

import { LogIngestService } from '#src/server/shared/log-ingest/log-ingest.service.js';
import { LogDialect } from '#src/server/shared/log-ingest/log-line.js';
import { MetricsRegistry } from '#src/server/shared/metrics/metrics-registry.service.js';
import {
  CONFIG_STREAM_URL,
  audioTooFast,
  bufferOverflow,
  incomingRequest,
  jobCompletion,
  noWords,
  nodeDecodeDrop,
  pythonDecodeDrop,
  requestCompleted,
  upstreamState,
  vadNoSpeech,
  wsClose,
  wsClosePeer,
} from '#tests/fixtures/log-lines.js';

const JOB_PERIOD_MS = 1_000;

function createIngest() {
  const metrics = new MetricsRegistry();
  const logger = {
    warn: () => undefined,
    info: () => undefined,
    error: () => undefined,
  } as never;
  const ingest = new LogIngestService(metrics, logger, {
    jobPeriodMs: JOB_PERIOD_MS,
    configStreamUrlFragment: '/session-config-stream/',
  });
  return { metrics, ingest };
}

describe('log parsers', () => {
  describe('decode drops', (it) => {
    it('counts node-side malformed frames with the node label', () => {
      // Arrange
      const { metrics, ingest } = createIngest();

      // Act
      ingest.ingest(nodeDecodeDrop());

      // Assert
      expect(
        metrics.safpDecodeDropsTotal.get({
          service: 'node-server',
          side: 'node',
        }),
      ).toBe(1);
    });

    it('counts the capitalized Python variant separately by side', () => {
      // Arrange
      const { metrics, ingest } = createIngest();

      // Act
      ingest.ingest(pythonDecodeDrop());

      // Assert
      expect(
        metrics.safpDecodeDropsTotal.get({
          service: 'transcription-service',
          side: 'transcription',
        }),
      ).toBe(1);
    });
  });

  describe('websocket closes', (it) => {
    it('records code, reason, role and a server initiator', () => {
      // Arrange
      const { metrics, ingest } = createIngest();

      // Act
      ingest.ingest(wsClose(1008, 'invalid-token'));

      // Assert
      expect(
        metrics.wsCloseTotal.get({
          service: 'node-server',
          code: '1008',
          reason: 'invalid-token',
          role: 'source',
          initiator: 'server',
        }),
      ).toBe(1);
    });

    it('distinguishes a peer-initiated close from a server-initiated one', () => {
      // Arrange
      const { metrics, ingest } = createIngest();

      // Act
      ingest.ingest(wsClosePeer(1006, 'abnormal'));

      // Assert
      expect(
        metrics.wsCloseTotal.get({
          service: 'node-server',
          code: '1006',
          reason: 'abnormal',
          role: 'source',
          initiator: 'peer',
        }),
      ).toBe(1);
    });
  });

  describe('upstream state transitions', (it) => {
    it('counts every transition', () => {
      // Arrange
      const { metrics, ingest } = createIngest();

      // Act
      ingest.ingest(upstreamState('IDLE', 'CONNECTING'));

      // Assert
      expect(
        metrics.upstreamStateTotal.get({
          service: 'node-server',
          from: 'IDLE',
          to: 'CONNECTING',
        }),
      ).toBe(1);
    });

    it('does not count a healthy session start as churn', () => {
      // Arrange
      const { metrics, ingest } = createIngest();

      // Act — the normal startup path
      ingest.ingest(upstreamState('IDLE', 'CONNECTING'));
      ingest.ingest(upstreamState('CONNECTING', 'HANDSHAKING'));
      ingest.ingest(upstreamState('HANDSHAKING', 'OPEN'));

      // Assert — churn must stay at zero, or every session start would alert
      expect(metrics.upstreamChurnTotal.total()).toBe(0);
    });

    it('counts a drop from OPEN back into retry as churn', () => {
      // Arrange
      const { metrics, ingest } = createIngest();

      // Act
      ingest.ingest(upstreamState('OPEN', 'WAITING_RETRY'));

      // Assert
      expect(
        metrics.upstreamChurnTotal.get({
          service: 'node-server',
          sessionUid: 'sess-1',
        }),
      ).toBe(1);
    });

    it('does not count a deliberate teardown as churn', () => {
      // Arrange
      const { metrics, ingest } = createIngest();

      // Act — terminate() drives OPEN -> CLOSED, which is a normal end of session
      ingest.ingest(upstreamState('OPEN', 'CLOSED'));

      // Assert
      expect(metrics.upstreamChurnTotal.total()).toBe(0);
    });
  });

  describe('job completion', (it) => {
    it('derives scheduling delay and execution time from the raw timestamps', () => {
      // Arrange — the derived @property fields are absent from the JSON, so the
      // parser must compute them from period_start/scheduled/start/complete.
      const { metrics, ingest } = createIngest();

      // Act
      ingest.ingest(jobCompletion({ schedulingDelayMs: 12, executionMs: 350 }));

      // Assert
      const labels = {
        service: 'transcription-service',
        providerKey: 'whisper',
      };
      expect(metrics.asrSchedulingDelayMs.summary(labels)?.p50).toBe(12);
      expect(metrics.asrProcessingMs.summary(labels)?.p50).toBe(350);
    });

    it('reports period utilization as execution time over the job period', () => {
      // Arrange
      const { metrics, ingest } = createIngest();

      // Act — a job taking 1.5x its period is over the saturation line
      ingest.ingest(jobCompletion({ executionMs: 1_500 }));

      // Assert
      const labels = {
        service: 'transcription-service',
        providerKey: 'whisper',
      };
      expect(metrics.asrPeriodUtilization.summary(labels)?.p50).toBeCloseTo(
        1.5,
      );
    });

    it('ignores a job completion whose stats block is malformed', () => {
      // Arrange
      const { metrics, ingest } = createIngest();

      // Act
      ingest.ingest({
        service: 'transcription-service',
        dialect: LogDialect.PYTHON,
        text: JSON.stringify({
          level: 20,
          time: 1,
          msg: 'Completed transcription job',
          stats: { period_start_ns: 'not-a-number' },
        }),
      });

      // Assert — counted as parsed, but contributes no observation
      expect(metrics.asrProcessingMs.count()).toBe(0);
    });
  });

  describe('overload signals', (it) => {
    it('counts a force-finalized buffer despite the float suffix', () => {
      // Arrange
      const { metrics, ingest } = createIngest();

      // Act
      ingest.ingest(bufferOverflow());

      // Assert
      expect(metrics.asrBufferOverflowTotal.total()).toBe(1);
    });

    it('counts audio-too-fast through the error-hook wrapper text', () => {
      // Arrange — the raised message is embedded in "Websocket encountered
      // error: ...", so an equality match would miss it entirely.
      const { metrics, ingest } = createIngest();

      // Act
      ingest.ingest(audioTooFast());

      // Assert
      expect(metrics.asrAudioTooFastTotal.total()).toBe(1);
    });
  });

  describe('no-speech signals', (it) => {
    it('labels the INFO and DEBUG variants distinctly', () => {
      // Arrange
      const { metrics, ingest } = createIngest();

      // Act
      ingest.ingest(noWords());
      ingest.ingest(vadNoSpeech());

      // Assert — conflating these would hide the T5-vs-T8 distinction
      expect(
        metrics.asrNoSpeechTotal.get({
          service: 'transcription-service',
          kind: 'no_words',
        }),
      ).toBe(1);
      expect(
        metrics.asrNoSpeechTotal.get({
          service: 'transcription-service',
          kind: 'vad_no_speech',
        }),
      ).toBe(1);
    });
  });

  describe('session-config poll correlation', (it) => {
    it('attributes a 401 to the config-stream route via reqId', () => {
      // Arrange — the status code and the URL arrive on two different lines
      const { metrics, ingest } = createIngest();

      // Act
      ingest.ingest(incomingRequest('req-1', CONFIG_STREAM_URL));
      ingest.ingest(requestCompleted('req-1', 401));

      // Assert
      expect(
        metrics.smConfigPollErrorsTotal.get({
          service: 'session-manager',
          status: '401',
        }),
      ).toBe(1);
    });

    it('counts a successful poll as the rate denominator', () => {
      // Arrange
      const { metrics, ingest } = createIngest();

      // Act
      ingest.ingest(incomingRequest('req-2', CONFIG_STREAM_URL));
      ingest.ingest(requestCompleted('req-2', 200));

      // Assert
      expect(metrics.smConfigPollOkTotal.total()).toBe(1);
      expect(metrics.smConfigPollErrorsTotal.total()).toBe(0);
    });

    it('ignores a 401 on an unrelated route', () => {
      // Arrange
      const { metrics, ingest } = createIngest();

      // Act
      ingest.ingest(
        incomingRequest('req-3', '/api/session-manager/v1/rooms/abc'),
      );
      ingest.ingest(requestCompleted('req-3', 401));

      // Assert
      expect(metrics.smConfigPollErrorsTotal.total()).toBe(0);
    });

    it('releases correlation state once a request completes', () => {
      // Arrange
      const { ingest } = createIngest();

      // Act
      ingest.ingest(incomingRequest('req-4', CONFIG_STREAM_URL));
      ingest.ingest(requestCompleted('req-4', 200));

      // Assert — long polls are the common case here, so a leak would be steady
      expect(ingest.pendingCorrelations).toBe(0);
    });
  });

  describe('dialect handling', (it) => {
    it('normalizes Python epoch-seconds timestamps to milliseconds', () => {
      // Arrange — pino writes ms and Python writes seconds; a 1000x error here
      // would silently break every rolling-window rate.
      const { metrics, ingest } = createIngest();
      const timeSec = 1_755_624_000;

      // Act
      ingest.ingest(bufferOverflow(timeSec));

      // Assert — the sample must land inside a window anchored at the ms value
      expect(
        metrics.asrBufferOverflowTotal.windowCount(
          {},
          1_000,
          timeSec * 1_000 + 500,
        ),
      ).toBe(1);
    });

    it('counts unrecognized lines rather than discarding them silently', () => {
      // Arrange
      const { metrics, ingest } = createIngest();

      // Act
      ingest.ingest({
        service: 'node-server',
        dialect: LogDialect.PINO,
        text: JSON.stringify({ level: 30, time: 1, msg: 'something new' }),
      });

      // Assert — this counter is the drift alarm for reworded log messages
      expect(
        metrics.logLinesUnparsedTotal.get({ service: 'node-server' }),
      ).toBe(1);
    });

    it('counts non-JSON input as malformed without throwing', () => {
      // Arrange
      const { metrics, ingest } = createIngest();

      // Act — PrettyPrintFormatter output, as seen in development mode
      ingest.ingest({
        service: 'transcription-service',
        dialect: LogDialect.PYTHON,
        text: '2026-07-19 10:00:00 INFO  Completed transcription job',
      });

      // Assert
      expect(
        metrics.logLinesMalformedTotal.get({
          service: 'transcription-service',
        }),
      ).toBe(1);
    });
  });
});
