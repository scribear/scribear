import { EventEmitter } from 'eventemitter3';
import { afterEach, beforeEach, describe, expect, vi } from 'vitest';

import { encodeAudioFrame } from '@scribear/audio-frame-protocol';
import { LatencyKind } from '@scribear/node-server-schema';
import type { Session } from '@scribear/session-manager-schema';

import { AudioFrameChannel } from '#src/server/features/transcription-stream/events/audio-frame.events.js';
import {
  LatencyChannel,
  type LatencyMessage,
} from '#src/server/features/transcription-stream/events/latency.events.js';
import { SessionStatusChannel } from '#src/server/features/transcription-stream/events/session-status.events.js';
import { TranscriptChannel } from '#src/server/features/transcription-stream/events/transcript.events.js';
import {
  type SessionConfigPollFactory,
  TranscriptionOrchestratorService,
} from '#src/server/features/transcription-stream/transcription-orchestrator.service.js';
import { EventBusService } from '#src/server/shared/services/event-bus.service.js';
import { NodeServerMetricsService } from '#src/server/shared/services/node-server-metrics.service.js';
import { createMockLogger } from '#tests/utils/mock-logger.js';

const SESSION_UID = '00000000-0000-0000-0000-000000000abc';
const ROOM_UID = '00000000-0000-0000-0000-000000000def';
const PROVIDER_KEY = 'debug';

function fakeSession(overrides: Partial<Session> = {}): Session {
  return {
    uid: SESSION_UID,
    roomUid: ROOM_UID,
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
  terminate = vi.fn(() => {
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
  metrics: NodeServerMetricsService;
  /** Sender passed to the upstream's onHandshake; records AUTH/CONFIG sends. */
  handshakeSender: {
    send: ReturnType<typeof vi.fn>;
    sendBinary: ReturnType<typeof vi.fn>;
  };
  /** Invokes the captured onHandshake, simulating one upstream (re)connection. */
  invokeHandshake: () => Promise<void>;
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
  const handshakeSender = { send: vi.fn(), sendBinary: vi.fn() };
  let capturedOnHandshake:
    | ((sender: typeof handshakeSender) => Promise<void> | void)
    | undefined;
  const transcriptionStreamFactory = vi.fn(
    (
      _params: unknown,
      opts?: {
        onHandshake?: (sender: typeof handshakeSender) => Promise<void> | void;
      },
    ) => {
      capturedOnHandshake = opts?.onHandshake;
      return upstream;
    },
  );
  const transcriptionServiceClient = {
    transcriptionStream: transcriptionStreamFactory,
  } as unknown as ConstructorParameters<
    typeof TranscriptionOrchestratorService
  >[2];

  const metrics = new NodeServerMetricsService();
  const orchestrator = new TranscriptionOrchestratorService(
    logger as never,
    bus,
    transcriptionServiceClient,
    poolFactory,
    { baseUrl: 'http://x', apiKey: 'tx-key' },
    metrics,
  );

  const invokeHandshake = async (): Promise<void> => {
    if (capturedOnHandshake !== undefined) {
      await capturedOnHandshake(handshakeSender);
    }
  };

  return {
    orchestrator,
    bus,
    longPoll,
    upstream,
    poolFactory,
    transcriptionStreamFactory,
    metrics,
    handshakeSender,
    invokeHandshake,
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
      // The factory is now called with a per-call onHandshake that re-sends
      // AUTH+CONFIG on every (re)connection (H2).
      expect(h.transcriptionStreamFactory).toHaveBeenCalledWith(
        { params: { providerKey: PROVIDER_KEY } },
        expect.objectContaining({ onHandshake: expect.any(Function) }),
      );
      expect(h.upstream.start).toHaveBeenCalledTimes(1);

      // AUTH + CONFIG are sent via the upstream's onHandshake, not via
      // upstream.send after start().
      await h.invokeHandshake();
      expect(h.handshakeSender.send).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'auth', api_key: 'tx-key' }),
      );
      expect(h.handshakeSender.send).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'config',
          config: { sample_rate: 48000, num_channels: 1 },
          session_uid: SESSION_UID,
          room_uid: ROOM_UID,
        }),
      );
    });

    it('re-sends AUTH+CONFIG on every (re)connection, using the latest config (H2)', async () => {
      // Arrange - open the session; the initial config is the fakeSession
      // default (48000 Hz).
      await registerAndDrain(h, SESSION_UID);

      // Act 1 - first connection: AUTH + initial CONFIG.
      await h.invokeHandshake();
      expect(h.handshakeSender.send).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'config',
          config: { sample_rate: 48000, num_channels: 1 },
        }),
      );

      // Bump the config via the long-poll. The orchestrator keeps state.config
      // current so the next handshake re-sends the updated value.
      h.handshakeSender.send.mockClear();
      h.longPoll.emit(
        'data',
        fakeSession({
          transcriptionStreamConfig: { sample_rate: 16000, num_channels: 1 },
        }),
      );

      // Act 2 - a reconnect is a second onHandshake invocation. Old behaviour
      // sent AUTH+CONFIG exactly once at session open, so a reconnect sent only
      // audio and was closed 1008 ("Audio chunk before authentication") by the
      // transcription service — forever, because the client reconnects and
      // repeats the mistake. The handshake must re-send both, with the new config.
      await h.invokeHandshake();
      expect(h.handshakeSender.send).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'auth', api_key: 'tx-key' }),
      );
      expect(h.handshakeSender.send).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'config',
          config: { sample_rate: 16000, num_channels: 1 },
          session_uid: SESSION_UID,
          room_uid: ROOM_UID,
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
    it('forwards SAFP frames published to AudioFrameChannel into the upstream', async () => {
      // Arrange
      const promise = h.orchestrator.registerSource(SESSION_UID);
      h.longPoll.emit('data', fakeSession());
      await promise;

      const frame = Buffer.from(
        encodeAudioFrame({ chunkId: 'c1' }, new Uint8Array([1, 2, 3])),
      );

      // Act
      h.bus.publish(AudioFrameChannel, frame, SESSION_UID);

      // Assert
      expect(h.upstream.sendBinary).toHaveBeenCalledTimes(1);
      expect(h.upstream.sendBinary).toHaveBeenCalledWith(frame);
    });

    it('counts every received frame in audioFramesReceived and exposes it in sessionSnapshots', async () => {
      // Arrange
      await registerAndDrain(h, SESSION_UID);

      const frame = Buffer.from(
        encodeAudioFrame({ chunkId: 'c1' }, new Uint8Array([1, 2, 3])),
      );

      // Act — send three well-formed frames.
      h.bus.publish(AudioFrameChannel, frame, SESSION_UID);
      h.bus.publish(AudioFrameChannel, frame, SESSION_UID);
      h.bus.publish(AudioFrameChannel, frame, SESSION_UID);

      // Assert — the counter is per-session, monotonic, and visible in the
      // snapshot the fleet dashboard reads.
      const { sessions } = h.orchestrator.sessionSnapshots(10);
      expect(sessions).toHaveLength(1);
      expect(sessions[0]?.audioFramesReceived).toBe(3);
    });

    it('drops a malformed (non-SAFP) frame instead of forwarding it', async () => {
      // Arrange
      const promise = h.orchestrator.registerSource(SESSION_UID);
      h.longPoll.emit('data', fakeSession());
      await promise;

      // Act - raw bytes with no SAFP envelope
      h.bus.publish(AudioFrameChannel, Buffer.from([1, 2, 3]), SESSION_UID);

      // Assert
      expect(h.upstream.sendBinary).not.toHaveBeenCalled();
      // U2: the drop is what the monitoring sidecar alerts on, so a frame
      // that forwarded nothing and counted nothing would be invisible.
      expect(h.metrics.snapshot().decodeDropsTotal).toBe(1);
    });

    it('correlates an echoed chunk id into a latency sample', async () => {
      // Arrange
      const promise = h.orchestrator.registerSource(SESSION_UID);
      h.longPoll.emit('data', fakeSession());
      await promise;

      const samples: LatencyMessage[] = [];
      h.bus.subscribe(LatencyChannel, (m) => samples.push(m), SESSION_UID);

      const chunkId = 'chunk-xyz';
      const sentAt = Date.now() - 5;
      const frame = Buffer.from(
        encodeAudioFrame({ chunkId, sentAt }, new Uint8Array([1, 2, 3])),
      );

      // Act - audio in, then a transcript that references the same chunk
      h.bus.publish(AudioFrameChannel, frame, SESSION_UID);
      h.upstream.emit('message', {
        final: { text: ['hi'], starts: null, ends: null },
        in_progress: null,
        final_chunk_ids: [chunkId],
      });

      // Assert
      expect(samples).toHaveLength(1);
      expect(samples[0]?.kind).toBe(LatencyKind.FINAL);
      expect(typeof samples[0]?.pipelineMs).toBe('number');
      expect(samples[0]?.e2eMs).toBeGreaterThanOrEqual(0);

      // B1.4: the same sample is aggregated server-side, so a room's latency
      // is visible without a client watching it. Aggregated here rather than in
      // the per-connection stream service, which would count it once per
      // subscriber.
      const series = h.metrics
        .snapshot()
        .latency.find((s) => s.measure === 'pipeline' && s.kind === 'final');
      expect(series?.sampleCount).toBe(1);
      expect(series?.p95).toBeCloseTo(samples[0]?.pipelineMs ?? -1, 6);
    });

    it('emits no latency sample for a transcript with no matching chunk id', async () => {
      // Arrange
      const promise = h.orchestrator.registerSource(SESSION_UID);
      h.longPoll.emit('data', fakeSession());
      await promise;

      const samples: LatencyMessage[] = [];
      h.bus.subscribe(LatencyChannel, (m) => samples.push(m), SESSION_UID);

      // Act - a transcript referencing a chunk the orchestrator never saw
      h.upstream.emit('message', {
        final: { text: ['hi'], starts: null, ends: null },
        in_progress: null,
        final_chunk_ids: ['never-seen'],
      });

      // Assert
      expect(samples).toHaveLength(0);
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

describe('TranscriptionOrchestratorService telemetry (B1.1)', () => {
  let h: Harness;

  beforeEach(() => {
    h = makeHarness();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('upstream churn', (it) => {
    it('counts a retry cycle as churn but a clean connect as none', async () => {
      // Arrange
      await registerAndDrain(h, SESSION_UID);

      // Act - a clean connect, then the BUG.txt signature: a flap.
      h.upstream.setOpen();
      h.upstream.emit('stateChange', 'WAITING_RETRY', 'OPEN');
      h.upstream.emit('stateChange', 'CONNECTING', 'WAITING_RETRY');

      // Assert - N1 must not fire on the healthy sequence alone.
      const snapshot = h.metrics.snapshot();
      expect(snapshot.upstreamChurnTotal).toBe(1);
      expect(snapshot.upstreamStateTransitions).toContainEqual({
        from: 'CONNECTING',
        to: 'OPEN',
        count: 1,
      });
      expect(snapshot.upstreamStateTransitions).toContainEqual({
        from: 'OPEN',
        to: 'WAITING_RETRY',
        count: 1,
      });
    });
  });

  describe('latency correlation', (it) => {
    it('records a negative end-to-end time as skew rather than a sample', async () => {
      // Arrange - a source whose clock is 10s ahead of ours (S5).
      await registerAndDrain(h, SESSION_UID);
      const chunkId = 'chunk-skewed';
      const frame = Buffer.from(
        encodeAudioFrame(
          { chunkId, sentAt: Date.now() + 10_000 },
          new Uint8Array([1, 2, 3]),
        ),
      );

      // Act
      h.bus.publish(AudioFrameChannel, frame, SESSION_UID);
      h.upstream.emit('message', {
        final: { text: ['hi'], starts: null, ends: null },
        in_progress: null,
        final_chunk_ids: [chunkId],
      });

      // Assert - the sample still counts (it has a valid pipelineMs); only
      // the e2e figure is classed as skew. S5 is the ratio of the two.
      const snapshot = h.metrics.snapshot();
      expect(snapshot.latencyE2eNegativeTotal).toBe(1);
      expect(snapshot.latencySamplesTotal).toBe(1);
    });

    it('counts a transcript for an unknown chunk as unmatched', async () => {
      // Arrange
      await registerAndDrain(h, SESSION_UID);

      // Act - a transcript referencing a chunk that was never recorded.
      h.upstream.emit('message', {
        final: { text: ['hi'], starts: null, ends: null },
        in_progress: null,
        final_chunk_ids: ['never-seen'],
      });

      // Assert - N3's downstream symptom: correlation silently stops.
      const snapshot = h.metrics.snapshot();
      expect(snapshot.latencyUnmatchedChunkTotal).toBe(1);
      expect(snapshot.latencySamplesTotal).toBe(0);
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
