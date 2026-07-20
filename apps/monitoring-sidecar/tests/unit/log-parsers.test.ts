import { describe, expect } from 'vitest';

import { LogIngestService } from '#src/server/shared/log-ingest/log-ingest.service.js';
import {
  LogDialect,
  normalizeLogLine,
} from '#src/server/shared/log-ingest/log-line.js';
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
  describe('retired parsers', (it) => {
    it('ignores node-server WebSocket close and upstream state lines', () => {
      // Arrange - these three signals moved to GET /status in B1.1. Their log
      // lines remain in node-server as the only per-event forensic record, and
      // must not feed metrics from both sources at once.
      const { metrics, ingest } = createIngest();

      // Act
      ingest.ingest(wsClose(1008, 'invalid-token'));
      ingest.ingest(wsClosePeer(1006, 'abnormal'));
      ingest.ingest(upstreamState('OPEN', 'WAITING_RETRY'));

      // Assert
      expect(metrics.wsCloseTotal.total()).toBe(0);
      expect(metrics.upstreamStateTotal.total()).toBe(0);
      expect(metrics.upstreamChurnTotal.total()).toBe(0);
      expect(metrics.logLinesUnparsedTotal.total()).toBe(3);
    });

    it('ignores every transcription line, which /metrics/status now reports', () => {
      // Arrange - B1.2 PR 5 retired the last five parsers. Double-counting is
      // the failure this pins: the poller adds the endpoint's absolute totals,
      // so a parser still claiming these lines would inflate every counter.
      const { metrics, ingest } = createIngest();

      // Act
      ingest.ingest(pythonDecodeDrop());
      ingest.ingest(nodeDecodeDrop());
      ingest.ingest(jobCompletion({ schedulingDelayMs: 12, executionMs: 350 }));
      ingest.ingest(bufferOverflow());
      ingest.ingest(audioTooFast());
      ingest.ingest(noWords());
      ingest.ingest(vadNoSpeech());

      // Assert
      expect(metrics.safpDecodeDropsTotal.total()).toBe(0);
      expect(metrics.asrBufferOverflowTotal.total()).toBe(0);
      expect(metrics.asrAudioTooFastTotal.total()).toBe(0);
      expect(metrics.asrNoSpeechTotal.total()).toBe(0);
      expect(metrics.logLinesUnparsedTotal.total()).toBe(7);
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
      // would silently break every rolling-window rate. Asserted on the
      // normalized line rather than through a metric, because B1.2 PR 5 retired
      // every parser that consumed a Python line.
      const timeSec = 1_755_624_000;

      // Act
      const raw = bufferOverflow(timeSec);
      const line = normalizeLogLine(raw.text, raw.service, raw.dialect);

      // Assert
      expect(line?.timeMs).toBe(timeSec * 1_000);
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
