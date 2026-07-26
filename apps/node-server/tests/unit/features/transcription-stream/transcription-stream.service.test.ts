import { afterEach, beforeEach, describe, expect, vi } from 'vitest';

import { LatencyKind } from '@scribear/node-server-schema';

import { AudioFrameChannel } from '#src/server/features/transcription-stream/events/audio-frame.events.js';
import { LatencyChannel } from '#src/server/features/transcription-stream/events/latency.events.js';
import { SessionEndedChannel } from '#src/server/features/transcription-stream/events/session-ended.events.js';
import { SessionStatusChannel } from '#src/server/features/transcription-stream/events/session-status.events.js';
import { TranscriptChannel } from '#src/server/features/transcription-stream/events/transcript.events.js';
import { TranscriptionStreamService } from '#src/server/features/transcription-stream/transcription-stream.service.js';
import { EventBusService } from '#src/server/shared/services/event-bus.service.js';
import { NodeServerMetricsService } from '#src/server/shared/services/node-server-metrics.service.js';
import { createMockLogger } from '#tests/utils/mock-logger.js';

const SESSION_UID = '00000000-0000-0000-0000-000000000abc';

interface Harness {
  service: TranscriptionStreamService;
  bus: EventBusService;
  registerSource: ReturnType<typeof vi.fn>;
  unregisterSource: ReturnType<typeof vi.fn>;
  getStatus: ReturnType<typeof vi.fn>;
  sent: unknown[];
  closes: { code: number; reason: string }[];
  metrics: NodeServerMetricsService;
}

function makeHarness(
  role: 'source' | 'client',
  options: {
    registerThrows?: boolean;
    initialStatus?: {
      transcriptionServiceConnected: boolean;
      sourceDeviceConnected: boolean;
    };
  } = {},
): Harness {
  const logger = createMockLogger();
  const bus = new EventBusService(logger as never);
  const unregisterSource = vi.fn();
  const setMicrophoneActive = vi.fn();
  const registerSource = vi.fn(() => {
    if (options.registerThrows) {
      return Promise.reject(new Error('orchestrator-down'));
    }
    return Promise.resolve({
      unregister: unregisterSource,
      setMicrophoneActive,
    });
  });
  const getStatus = vi.fn(
    () =>
      options.initialStatus ?? {
        transcriptionServiceConnected: false,
        sourceDeviceConnected: false,
        sourceMicrophoneActive: null,
      },
  );
  const orchestrator = {
    registerSource,
    getStatus,
    activeSessionCount: 0,
  } as unknown as ConstructorParameters<
    typeof TranscriptionStreamService
  >[0]['transcriptionOrchestratorService'];

  const metrics = new NodeServerMetricsService();
  const service = new TranscriptionStreamService({
    role,
    sessionUid: SESSION_UID,
    eventBusService: bus,
    transcriptionOrchestratorService: orchestrator,
    nodeServerMetricsService: metrics,
  });

  const sent: unknown[] = [];
  const closes: { code: number; reason: string }[] = [];
  service.on('send', (msg) => {
    sent.push(msg);
  });
  service.on('close', (code, reason) => {
    closes.push({ code, reason });
  });

  return {
    service,
    bus,
    registerSource,
    unregisterSource,
    getStatus,
    sent,
    closes,
    metrics,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('TranscriptionStreamService', () => {
  describe('start', (it) => {
    it('registers the source with the orchestrator on source-role start', async () => {
      // Arrange
      const h = makeHarness('source');

      // Act
      await h.service.start();

      // Assert
      expect(h.registerSource).toHaveBeenCalledWith(SESSION_UID);
    });

    it('counts a client-role connection as a subscriber and releases it on close', async () => {
      // Arrange - N4 (fan-out cost) is dominated by receive-only clients,
      // which never reach the orchestrator, so this is the only place they
      // are counted at all.
      const h = makeHarness('client');

      // Act
      await h.service.start();

      // Assert
      expect(h.metrics.subscriberCount(SESSION_UID)).toBe(1);

      // Act
      h.service.close();

      // Assert
      expect(h.metrics.subscriberCount(SESSION_UID)).toBe(0);
    });

    it('does not count a connection that closed before it subscribed', async () => {
      // Arrange - the close-during-registration race: start() bails early,
      // so a naive increment in the constructor would leak a subscriber for
      // the life of the process.
      const h = makeHarness('source');
      h.service.close();

      // Act
      await h.service.start();

      // Assert
      expect(h.metrics.subscriberCount(SESSION_UID)).toBe(0);
    });

    it('does not double-count when close runs more than once', async () => {
      // Arrange
      const h = makeHarness('client');
      await h.service.start();

      // Act - cleanup is idempotent and does run twice in the wild: the
      // controller calls close() on both its own path and the socket's.
      h.service.close();
      h.service.close();

      // Assert - a second decrement would drive the count negative and make
      // a busy room under-report.
      expect(h.metrics.subscriberCount(SESSION_UID)).toBe(0);
    });

    it('does not register with the orchestrator on client-role start', async () => {
      // Arrange
      const h = makeHarness('client');

      // Act
      await h.service.start();

      // Assert
      expect(h.registerSource).not.toHaveBeenCalled();
    });

    it('propagates orchestrator errors so the controller can map them to 1011', async () => {
      // Arrange
      const h = makeHarness('source', { registerThrows: true });

      // Act / Assert
      await expect(h.service.start()).rejects.toThrow('orchestrator-down');
    });

    it('does not emit any messages from start - the controller drives auth-success ordering', async () => {
      // Arrange
      const h = makeHarness('client');

      // Act
      await h.service.start();

      // Assert
      expect(h.sent).toHaveLength(0);
    });

    it('releases the orchestrator registration when the connection closed mid-start', async () => {
      // Arrange - delay the registerSource resolution so we can close before it returns.
      let resolveRegister: (handle: {
        unregister: () => void;
        setMicrophoneActive: () => void;
      }) => void = () => undefined;
      const unregister = vi.fn();
      const registerSource = vi.fn(
        () =>
          new Promise<{
            unregister: () => void;
            setMicrophoneActive: () => void;
          }>((resolve) => {
            resolveRegister = resolve;
          }),
      );
      const logger = createMockLogger();
      const bus = new EventBusService(logger as never);
      const orchestrator = {
        registerSource,
        getStatus: () => ({
          transcriptionServiceConnected: false,
          sourceDeviceConnected: false,
        }),
        activeSessionCount: 0,
      } as unknown as ConstructorParameters<
        typeof TranscriptionStreamService
      >[0]['transcriptionOrchestratorService'];
      const service = new TranscriptionStreamService({
        role: 'source',
        sessionUid: SESSION_UID,
        eventBusService: bus,
        transcriptionOrchestratorService: orchestrator,
        nodeServerMetricsService: new NodeServerMetricsService(),
      });

      // Act - close before resolving the registration.
      const pending = service.start();
      service.close();
      resolveRegister({
        unregister,
        setMicrophoneActive: vi.fn(),
      });
      await pending;

      // Assert
      expect(unregister).toHaveBeenCalledTimes(1);
    });
  });

  describe('publishCurrentStatus', (it) => {
    it('emits the orchestrator snapshot on demand', async () => {
      // Arrange
      const h = makeHarness('client', {
        initialStatus: {
          transcriptionServiceConnected: true,
          sourceDeviceConnected: false,
        },
      });
      await h.service.start();

      // Act
      h.service.publishCurrentStatus();

      // Assert
      expect(h.sent).toEqual([
        {
          type: 'sessionStatus',
          transcriptionServiceConnected: true,
          sourceDeviceConnected: false,
        },
      ]);
    });

    it('is a no-op after the service is closed', async () => {
      // Arrange
      const h = makeHarness('client');
      await h.service.start();
      h.service.close();

      // Act
      h.service.publishCurrentStatus();

      // Assert
      expect(h.sent).toHaveLength(0);
    });
  });

  describe('handleBinary', (it) => {
    it('publishes binary audio to the bus', async () => {
      // Arrange
      const h = makeHarness('source');
      await h.service.start();
      const received: Buffer[] = [];
      h.bus.subscribe(
        AudioFrameChannel,
        (frame) => {
          received.push(frame);
        },
        SESSION_UID,
      );
      const frame = Buffer.from([1, 2, 3]);

      // Act
      h.service.handleBinary(frame);

      // Assert
      expect(received).toEqual([frame]);
    });

    it('ignores binary frames received after close', async () => {
      // Arrange
      const h = makeHarness('source');
      await h.service.start();
      const received: Buffer[] = [];
      h.bus.subscribe(
        AudioFrameChannel,
        (frame) => {
          received.push(frame);
        },
        SESSION_UID,
      );

      // Act
      h.service.close();
      h.service.handleBinary(Buffer.from([1, 2, 3]));

      // Assert
      expect(received).toHaveLength(0);
    });
  });

  describe('bus subscriptions', (it) => {
    it('emits transcript send messages when the bus publishes a transcript', async () => {
      // Arrange
      const h = makeHarness('client');
      await h.service.start();

      // Act
      h.bus.publish(
        TranscriptChannel,
        {
          final: { text: ['hello'], starts: null, ends: null },
          inProgress: null,
        },
        SESSION_UID,
      );

      // Assert
      expect(h.sent).toContainEqual({
        type: 'transcript',
        final: { text: ['hello'], starts: null, ends: null },
        inProgress: null,
      });
    });

    it('emits a latencyUpdate send message when the bus publishes latency', async () => {
      // Arrange
      const h = makeHarness('client');
      await h.service.start();

      // Act
      h.bus.publish(
        LatencyChannel,
        { kind: LatencyKind.FINAL, pipelineMs: 42, e2eMs: 100 },
        SESSION_UID,
      );

      // Assert
      expect(h.sent).toContainEqual({
        type: 'latencyUpdate',
        kind: LatencyKind.FINAL,
        pipelineMs: 42,
        e2eMs: 100,
      });
    });

    it('does not emit transcripts from other sessions', async () => {
      // Arrange
      const h = makeHarness('client');
      await h.service.start();

      // Act
      h.bus.publish(
        TranscriptChannel,
        {
          final: { text: ['other'], starts: null, ends: null },
          inProgress: null,
        },
        '00000000-0000-0000-0000-000000000999',
      );

      // Assert
      expect(
        h.sent.find((m) => (m as { type: string }).type === 'transcript'),
      ).toBeUndefined();
    });

    it('forwards SessionStatusChannel publishes as sessionStatus messages', async () => {
      // Arrange
      const h = makeHarness('client');
      await h.service.start();

      // Act
      h.bus.publish(
        SessionStatusChannel,
        {
          transcriptionServiceConnected: true,
          sourceDeviceConnected: true,
        },
        SESSION_UID,
      );

      // Assert
      expect(h.sent).toContainEqual({
        type: 'sessionStatus',
        transcriptionServiceConnected: true,
        sourceDeviceConnected: true,
      });
    });

    it('emits sessionEnded and self-closes 1000 when SessionEndedChannel fires', async () => {
      // Arrange
      const h = makeHarness('client');
      await h.service.start();

      // Act
      h.bus.publish(SessionEndedChannel, {}, SESSION_UID);

      // Assert
      expect(h.sent).toContainEqual({ type: 'sessionEnded' });
      expect(h.closes).toEqual([{ code: 1000, reason: 'session-ended' }]);
    });
  });

  describe('close', (it) => {
    it('unregisters from the orchestrator', async () => {
      // Arrange
      const h = makeHarness('source');
      await h.service.start();

      // Act
      h.service.close();

      // Assert
      expect(h.unregisterSource).toHaveBeenCalledTimes(1);
    });

    it('unsubscribes from the transcript bus', async () => {
      // Arrange
      const h = makeHarness('client');
      await h.service.start();

      // Act
      h.service.close();
      h.bus.publish(
        TranscriptChannel,
        {
          final: { text: ['after-close'], starts: null, ends: null },
          inProgress: null,
        },
        SESSION_UID,
      );

      // Assert
      expect(
        h.sent.find((m) => (m as { type: string }).type === 'transcript'),
      ).toBeUndefined();
    });
  });
});
