import { afterEach, beforeEach, describe, expect, vi } from 'vitest';

import { LatencyKind } from '@scribear/node-server-schema';

import { AudioFrameChannel } from '#src/server/features/transcription-stream/events/audio-frame.events.js';
import { LatencyChannel } from '#src/server/features/transcription-stream/events/latency.events.js';
import { SessionEndedChannel } from '#src/server/features/transcription-stream/events/session-ended.events.js';
import { SessionStatusChannel } from '#src/server/features/transcription-stream/events/session-status.events.js';
import { TranscriptChannel } from '#src/server/features/transcription-stream/events/transcript.events.js';
import { SessionAlreadyEndedError } from '#src/server/features/transcription-stream/transcription-orchestrator.service.js';
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
  registerClient: ReturnType<typeof vi.fn>;
  unregisterClient: ReturnType<typeof vi.fn>;
  getStatus: ReturnType<typeof vi.fn>;
  sent: unknown[];
  closes: { code: number; reason: string }[];
  metrics: NodeServerMetricsService;
}

/**
 * How many listeners the bus currently holds for a channel keyed by
 * `SESSION_UID`. Reaches into the bus's private map on purpose: the leak this
 * guards - a connection that subscribes and then bails out of `start()`
 * without unsubscribing - is invisible from the outside, because a leaked
 * listener on a dead connection emits nothing.
 */
function busListenerCount(bus: EventBusService, key: string): number {
  const channels = Reflect.get(bus, '_channels') as
    | Map<string, Set<unknown>>
    | undefined;
  return channels?.get(key)?.size ?? 0;
}

/** Total listeners this service could have taken out, across all four buses. */
function allBusListenerCounts(bus: EventBusService): number {
  return (
    busListenerCount(bus, TranscriptChannel.key(SESSION_UID)) +
    busListenerCount(bus, LatencyChannel.key(SESSION_UID)) +
    busListenerCount(bus, SessionStatusChannel.key(SESSION_UID)) +
    busListenerCount(bus, SessionEndedChannel.key(SESSION_UID))
  );
}

function makeHarness(
  role: 'source' | 'client',
  options: {
    registerThrows?: boolean;
    registerSessionEnded?: boolean;
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
    if (options.registerSessionEnded) {
      return Promise.reject(new SessionAlreadyEndedError(SESSION_UID));
    }
    return Promise.resolve({
      unregister: unregisterSource,
      setMicrophoneActive,
    });
  });
  const unregisterClient = vi.fn();
  const registerClient = vi.fn(() => ({ unregister: unregisterClient }));
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
    registerClient,
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
    registerClient,
    unregisterClient,
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

    it('does not register a source on client-role start', async () => {
      // Arrange
      const h = makeHarness('client');

      // Act
      await h.service.start();

      // Assert - a viewer must never open an upstream transcription
      // connection; audio-less connections registering a job is what tripped
      // admission control in e80eea2.
      expect(h.registerSource).not.toHaveBeenCalled();
    });

    it('takes out the session end-watch on client-role start and releases it on close', async () => {
      // Arrange - without this a viewer on a source-free session is never
      // told the session ended: nothing else in node-server fetches that
      // session's config, so `sessionEnded` is never published and the viewer
      // sits on stale captions until a token refresh happens to be rejected.
      const h = makeHarness('client');

      // Act
      await h.service.start();

      // Assert
      expect(h.registerClient).toHaveBeenCalledWith(SESSION_UID);
      expect(h.unregisterClient).not.toHaveBeenCalled();

      // Act
      h.service.close();

      // Assert - the watch is ref-counted, so a viewer that leaves must
      // release its share or the watch outlives the room.
      expect(h.unregisterClient).toHaveBeenCalledTimes(1);
    });

    it('does not take out an end-watch on source-role start', async () => {
      // Arrange - the source's own `SessionState` already owns the end timer.
      const h = makeHarness('source');

      // Act
      await h.service.start();

      // Assert
      expect(h.registerClient).not.toHaveBeenCalled();
    });

    it('releases the end-watch exactly once when close runs more than once', async () => {
      // Arrange - the controller calls close() on both its own path and the
      // socket's, and a second decrement would drop the watch out from under
      // the viewers still on it.
      const h = makeHarness('client');
      await h.service.start();

      // Act
      h.service.close();
      h.service.close();

      // Assert
      expect(h.unregisterClient).toHaveBeenCalledTimes(1);
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
      const whileRegistering = allBusListenerCounts(bus);
      service.close();
      resolveRegister({
        unregister,
        setMicrophoneActive: vi.fn(),
      });
      await pending;

      // Assert
      expect(unregister).toHaveBeenCalledTimes(1);
      // Subscriptions are now taken out before the await, so this path has
      // four of them to hand back. Leaving them attached would keep a dead
      // connection on every one of the session's buses for the life of the
      // process.
      expect(whileRegistering).toBe(4);
      expect(allBusListenerCounts(bus)).toBe(0);
    });

    it('leaves no subscriptions behind when the orchestrator throws', async () => {
      // The 1011 path. `start()` rethrows for the controller to map, and must
      // not have left this connection on the buses on its way out.
      // Arrange
      const h = makeHarness('source', { registerThrows: true });

      // Act
      await expect(h.service.start()).rejects.toThrow('orchestrator-down');

      // Assert
      expect(allBusListenerCounts(h.bus)).toBe(0);
      expect(h.metrics.subscriberCount(SESSION_UID)).toBe(0);
    });

    it('subscribes to nothing when the connection closed before start ran', async () => {
      // Arrange
      const h = makeHarness('source');
      h.service.close();

      // Act
      await h.service.start();

      // Assert
      expect(allBusListenerCounts(h.bus)).toBe(0);
      expect(h.registerSource).not.toHaveBeenCalled();
    });

    it('drops live-stream messages that arrive before authOk', async () => {
      // Subscribing before registration means these buses can now fire while
      // the socket has not been told its auth succeeded. Writing to it then is
      // a protocol violation, and nothing is lost by dropping: the status
      // snapshot `onAuthAcknowledged` sends supersedes any status published
      // here, and transcripts have no replay semantics for a connection that
      // has not finished authenticating.
      // Arrange
      const h = makeHarness('client');
      await h.service.start();

      // Act
      h.bus.publish(
        SessionStatusChannel,
        { transcriptionServiceConnected: true, sourceDeviceConnected: true },
        SESSION_UID,
      );
      h.bus.publish(
        TranscriptChannel,
        {
          final: { text: ['too early'], starts: null, ends: null },
          inProgress: null,
        },
        SESSION_UID,
      );

      // Assert
      expect(h.sent).toHaveLength(0);
    });
  });

  describe('onAuthAcknowledged', (it) => {
    it('emits the orchestrator snapshot once the controller has sent authOk', async () => {
      // Arrange
      const h = makeHarness('client', {
        initialStatus: {
          transcriptionServiceConnected: true,
          sourceDeviceConnected: false,
        },
      });
      await h.service.start();

      // Act
      h.service.onAuthAcknowledged();

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
      h.service.onAuthAcknowledged();

      // Assert
      expect(h.sent).toHaveLength(0);
    });
  });

  // The bug: a source connecting to a session whose `effectiveEnd` had already
  // passed was never told. `registerSource` published `sessionEnded` from
  // inside its own await, before this connection had subscribed, so the
  // publish landed on an empty channel - and the source went on streaming
  // audio into a session the server considered over, holding an upstream
  // transcription connection for as long as the kiosk kept the socket up.
  describe('registering onto an already-ended session', (it) => {
    it('sends sessionEnded and closes 1000, after authOk rather than before it', async () => {
      // Arrange
      const h = makeHarness('source', { registerSessionEnded: true });

      // Act - `start()` must not throw: the session is over, not broken, and a
      // 1011 here would put the kiosk into a reconnect loop against a session
      // that is never coming back.
      await h.service.start();

      // Assert - nothing yet. The controller has not written authOk, and both
      // webapp clients hold their handshake open until it arrives.
      expect(h.sent).toHaveLength(0);
      expect(h.closes).toHaveLength(0);

      // Act - the controller sends authOk and reports it.
      h.service.onAuthAcknowledged();

      // Assert
      expect(h.sent).toEqual([{ type: 'sessionEnded' }]);
      expect(h.closes).toEqual([{ code: 1000, reason: 'session-ended' }]);
    });

    it('sends no status snapshot for a session that is over', async () => {
      // A `sessionStatus` here reads as "still waiting for a source", which
      // would tell the client to keep waiting for one that is never coming.
      // Arrange
      const h = makeHarness('source', { registerSessionEnded: true });
      await h.service.start();

      // Act
      h.service.onAuthAcknowledged();

      // Assert
      expect(
        h.sent.find((m) => (m as { type: string }).type === 'sessionStatus'),
      ).toBeUndefined();
      expect(h.getStatus).not.toHaveBeenCalled();
    });

    it('holds no orchestrator registration and no bus subscriptions afterwards', async () => {
      // Nothing was registered and no upstream was dialed, so there is nothing
      // to release - but the subscriptions taken out before registering must
      // still come back off the bus when the connection closes.
      // Arrange
      const h = makeHarness('source', { registerSessionEnded: true });
      await h.service.start();

      // Act
      h.service.onAuthAcknowledged();

      // Assert
      expect(h.unregisterSource).not.toHaveBeenCalled();
      expect(allBusListenerCounts(h.bus)).toBe(0);
      expect(h.metrics.subscriberCount(SESSION_UID)).toBe(0);
    });

    it('still delivers an end that lands while the source is registering', async () => {
      // The §4.1 race rather than the stale-schedule case: registration is
      // admitted, and the end is published on the bus while the await is still
      // outstanding. The subscription now exists to hear it; before it moved,
      // this publish went nowhere.
      // Arrange
      let resolveRegister: (handle: {
        unregister: () => void;
        setMicrophoneActive: () => void;
      }) => void = () => undefined;
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
      const sent: unknown[] = [];
      const closes: { code: number; reason: string }[] = [];
      service.on('send', (msg) => {
        sent.push(msg);
      });
      service.on('close', (code, reason) => {
        closes.push({ code, reason });
      });

      // Act - the end is published mid-registration, then registration
      // completes normally.
      const pending = service.start();
      bus.publish(SessionEndedChannel, {}, SESSION_UID);
      resolveRegister({ unregister: vi.fn(), setMicrophoneActive: vi.fn() });
      await pending;
      service.onAuthAcknowledged();

      // Assert
      expect(sent).toEqual([{ type: 'sessionEnded' }]);
      expect(closes).toEqual([{ code: 1000, reason: 'session-ended' }]);
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
      // The controller has sent authOk; the outbound gate is open.
      h.service.onAuthAcknowledged();

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
      // The controller has sent authOk; the outbound gate is open.
      h.service.onAuthAcknowledged();

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
      // The controller has sent authOk; the outbound gate is open.
      h.service.onAuthAcknowledged();

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
      // The controller has sent authOk; the outbound gate is open.
      h.service.onAuthAcknowledged();

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
      // The controller has sent authOk; the outbound gate is open.
      h.service.onAuthAcknowledged();

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
