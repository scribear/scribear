import { EventEmitter } from 'eventemitter3';
import { afterEach, beforeEach, describe, expect, vi } from 'vitest';

import type { Session } from '@scribear/session-manager-schema';

import { AudioFrameChannel } from '#src/server/features/transcription-stream/events/audio-frame.events.js';
import { SessionStatusChannel } from '#src/server/features/transcription-stream/events/session-status.events.js';
import { TranscriptChannel } from '#src/server/features/transcription-stream/events/transcript.events.js';
import {
  type SessionConfigPollFactory,
  TranscriptionOrchestratorService,
} from '#src/server/features/transcription-stream/transcription-orchestrator.service.js';
import { EventBusService } from '#src/server/shared/services/event-bus.service.js';
import { createMockLogger } from '#tests/utils/mock-logger.js';

const SESSION_UID = '00000000-0000-0000-0000-000000000abc';
const PROVIDER_KEY = 'debug';

function fakeSession(overrides: Partial<Session> = {}): Session {
  return {
    uid: SESSION_UID,
    transcriptionProviderId: PROVIDER_KEY,
    transcriptionStreamConfig: { sample_rate: 48000, num_channels: 1 },
    sessionConfigVersion: 1,
    ...overrides,
  } as Session;
}

/**
 * Minimal stand-in for `LongPollClient<typeof SESSION_CONFIG_STREAM_SCHEMA>`.
 * Tests drive `data` / `error` events to control how the orchestrator's
 * config wait resolves.
 */
class FakeLongPoll extends EventEmitter {
  start = vi.fn();
  close = vi.fn();
}

/**
 * Minimal stand-in for the upstream `WebSocketClient` returned by the
 * transcription-service client factory. Tracks state transitions and
 * exposes hooks for tests to push messages or simulate the connection
 * reaching `OPEN`.
 */
class FakeUpstream extends EventEmitter {
  state: 'IDLE' | 'CONNECTING' | 'OPEN' | 'CLOSED' = 'IDLE';
  start = vi.fn(() => {
    this.state = 'CONNECTING';
  });
  send = vi.fn();
  sendBinary = vi.fn();
  terminate = vi.fn((_code: number, _reason: string) => {
    const prev = this.state;
    this.state = 'CLOSED';
    this.emit('stateChange', 'CLOSED', prev);
  });

  setOpen(): void {
    const prev = this.state;
    this.state = 'OPEN';
    this.emit('stateChange', 'OPEN', prev);
  }
}

interface Harness {
  orchestrator: TranscriptionOrchestratorService;
  bus: EventBusService;
  longPoll: FakeLongPoll;
  upstream: FakeUpstream;
  poolFactory: ReturnType<typeof vi.fn>;
  transcriptionStreamFactory: ReturnType<typeof vi.fn>;
}

function makeHarness(
  options: {
    upstream?: FakeUpstream;
    longPoll?: FakeLongPoll;
  } = {},
): Harness {
  const logger = createMockLogger();
  const bus = new EventBusService(logger as never);
  const longPoll = options.longPoll ?? new FakeLongPoll();
  const upstream = options.upstream ?? new FakeUpstream();
  const poolFactory = vi.fn(
    () => longPoll,
  ) as unknown as SessionConfigPollFactory & ReturnType<typeof vi.fn>;
  const transcriptionStreamFactory = vi.fn(() => upstream);
  const transcriptionServiceClient = {
    transcriptionStream: transcriptionStreamFactory,
  } as unknown as ConstructorParameters<
    typeof TranscriptionOrchestratorService
  >[2];

  const orchestrator = new TranscriptionOrchestratorService(
    logger as never,
    bus,
    transcriptionServiceClient,
    poolFactory,
    { baseUrl: 'http://x', apiKey: 'tx-key' },
  );

  return {
    orchestrator,
    bus,
    longPoll,
    upstream,
    poolFactory,
    transcriptionStreamFactory,
  };
}

describe('TranscriptionOrchestratorService', () => {
  let h: Harness;

  beforeEach(() => {
    h = makeHarness();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('registerSource', (it) => {
    it('opens the upstream once the long-poll resolves the first config', async () => {
      // Arrange
      const promise = h.orchestrator.registerSource(SESSION_UID);
      // Drive the long-poll resolution after the orchestrator has subscribed
      // to its events.
      h.longPoll.emit('data', fakeSession());
      await promise;

      // Assert
      expect(h.poolFactory).toHaveBeenCalledWith(SESSION_UID);
      expect(h.longPoll.start).toHaveBeenCalledTimes(1);
      expect(h.transcriptionStreamFactory).toHaveBeenCalledWith({
        params: { providerKey: PROVIDER_KEY },
      });
      expect(h.upstream.start).toHaveBeenCalledTimes(1);
      expect(h.upstream.send).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'auth', api_key: 'tx-key' }),
      );
      expect(h.upstream.send).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'config',
          config: { sample_rate: 48000, num_channels: 1 },
        }),
      );
    });

    it('rejects when the long-poll errors before resolving', async () => {
      // Arrange
      const promise = h.orchestrator.registerSource(SESSION_UID);
      const err = new Error('long-poll-broken');
      h.longPoll.emit('error', err);

      // Act / Assert
      await expect(promise).rejects.toThrow('long-poll-broken');
      expect(h.longPoll.close).toHaveBeenCalled();
      expect(h.transcriptionStreamFactory).not.toHaveBeenCalled();
    });

    it('does not reopen the upstream on a second registration for the same session', async () => {
      // Arrange
      const first = h.orchestrator.registerSource(SESSION_UID);
      h.longPoll.emit('data', fakeSession());
      await first;
      const second = h.orchestrator.registerSource(SESSION_UID);

      // Act
      await second;

      // Assert - only one upstream / long-poll constructed across both calls.
      expect(h.poolFactory).toHaveBeenCalledTimes(1);
      expect(h.transcriptionStreamFactory).toHaveBeenCalledTimes(1);
      expect(h.orchestrator.activeSessionCount).toBe(1);
    });

    it('publishes sessionDeviceConnected: true on first registration', async () => {
      // Arrange
      const statuses: { sourceDeviceConnected: boolean }[] = [];
      h.bus.subscribe(
        SessionStatusChannel,
        (s) => {
          statuses.push(s);
        },
        SESSION_UID,
      );

      // Act
      const promise = h.orchestrator.registerSource(SESSION_UID);
      h.longPoll.emit('data', fakeSession());
      await promise;

      // Assert
      expect(statuses[0]).toMatchObject({ sourceDeviceConnected: true });
    });
  });

  describe('upstream message routing', (it) => {
    it('publishes upstream transcripts to the TranscriptChannel keyed by sessionUid', async () => {
      // Arrange
      const promise = h.orchestrator.registerSource(SESSION_UID);
      h.longPoll.emit('data', fakeSession());
      await promise;

      const received: { final: unknown; inProgress: unknown }[] = [];
      h.bus.subscribe(
        TranscriptChannel,
        (m) => {
          received.push(m);
        },
        SESSION_UID,
      );

      // Act
      h.upstream.emit('message', {
        type: 'transcript',
        final: { text: ['hi'], starts: null, ends: null },
        in_progress: null,
      });

      // Assert - snake_case `in_progress` is translated to camelCase `inProgress`.
      expect(received).toHaveLength(1);
      expect(received[0]).toEqual({
        final: { text: ['hi'], starts: null, ends: null },
        inProgress: null,
      });
    });

    it('publishes a sessionStatus update when the upstream reaches OPEN', async () => {
      // Arrange
      const promise = h.orchestrator.registerSource(SESSION_UID);
      h.longPoll.emit('data', fakeSession());
      await promise;

      const statuses: {
        transcriptionServiceConnected: boolean;
        sourceDeviceConnected: boolean;
      }[] = [];
      h.bus.subscribe(
        SessionStatusChannel,
        (s) => {
          statuses.push(s);
        },
        SESSION_UID,
      );

      // Act
      h.upstream.setOpen();

      // Assert
      expect(statuses).toContainEqual({
        transcriptionServiceConnected: true,
        sourceDeviceConnected: true,
      });
    });
  });

  describe('audio bus → upstream', (it) => {
    it('forwards binary frames published to AudioFrameChannel into the upstream', async () => {
      // Arrange
      const promise = h.orchestrator.registerSource(SESSION_UID);
      h.longPoll.emit('data', fakeSession());
      await promise;

      const frame = Buffer.from([1, 2, 3]);

      // Act
      h.bus.publish(AudioFrameChannel, frame, SESSION_UID);

      // Assert
      expect(h.upstream.sendBinary).toHaveBeenCalledTimes(1);
      expect(h.upstream.sendBinary).toHaveBeenCalledWith(frame);
    });

    it('does not forward audio frames published for a different session', async () => {
      // Arrange
      const promise = h.orchestrator.registerSource(SESSION_UID);
      h.longPoll.emit('data', fakeSession());
      await promise;

      // Act
      h.bus.publish(
        AudioFrameChannel,
        Buffer.from([1]),
        '00000000-0000-0000-0000-000000000999',
      );

      // Assert
      expect(h.upstream.sendBinary).not.toHaveBeenCalled();
    });
  });

  describe('unregister lifecycle', (it) => {
    it('does not tear down the upstream while sources remain', async () => {
      // Arrange
      const a = await registerAndDrain(h, SESSION_UID);
      await registerAndDrain(h, SESSION_UID);

      // Act - drop one of two registrations.
      a();

      // Assert
      expect(h.upstream.terminate).not.toHaveBeenCalled();
      expect(h.longPoll.close).not.toHaveBeenCalled();
      expect(h.orchestrator.activeSessionCount).toBe(1);
    });

    it('tears down the upstream and publishes a final disconnected status when the last source unregisters', async () => {
      // Arrange
      const unregister = await registerAndDrain(h, SESSION_UID);
      h.upstream.setOpen();

      const statuses: {
        transcriptionServiceConnected: boolean;
        sourceDeviceConnected: boolean;
      }[] = [];
      h.bus.subscribe(
        SessionStatusChannel,
        (s) => {
          statuses.push(s);
        },
        SESSION_UID,
      );

      // Act
      unregister();

      // Assert
      expect(h.upstream.terminate).toHaveBeenCalledWith(
        1000,
        'no-more-sources',
      );
      expect(h.longPoll.close).toHaveBeenCalled();
      expect(h.orchestrator.activeSessionCount).toBe(0);
      expect(statuses[statuses.length - 1]).toEqual({
        transcriptionServiceConnected: false,
        sourceDeviceConnected: false,
      });
    });

    it('stops forwarding audio after the last source unregisters', async () => {
      // Arrange
      const unregister = await registerAndDrain(h, SESSION_UID);

      // Act
      unregister();
      h.upstream.sendBinary.mockClear();
      h.bus.publish(AudioFrameChannel, Buffer.from([1]), SESSION_UID);

      // Assert
      expect(h.upstream.sendBinary).not.toHaveBeenCalled();
    });
  });

  describe('getStatus', (it) => {
    it('returns the disconnected snapshot for an unknown sessionUid', () => {
      // Arrange / Act
      const status = h.orchestrator.getStatus(SESSION_UID);

      // Assert
      expect(status).toEqual({
        transcriptionServiceConnected: false,
        sourceDeviceConnected: false,
      });
    });

    it('returns the most-recent published status for an active session', async () => {
      // Arrange
      await registerAndDrain(h, SESSION_UID);
      h.upstream.setOpen();

      // Act
      const status = h.orchestrator.getStatus(SESSION_UID);

      // Assert
      expect(status).toEqual({
        transcriptionServiceConnected: true,
        sourceDeviceConnected: true,
      });
    });
  });
});

/**
 * Helper: register a source and drain the long-poll's first data event so
 * the registration promise resolves, returning the unregister function.
 */
async function registerAndDrain(
  h: Harness,
  sessionUid: string,
): Promise<() => void> {
  const promise = h.orchestrator.registerSource(sessionUid);
  h.longPoll.emit('data', fakeSession({ uid: sessionUid }));
  return await promise;
}
