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
  type SourceHandle,
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
  state: 'IDLE' | 'CONNECTING' | 'OPEN' | 'WAITING_RETRY' | 'CLOSED' = 'IDLE';
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

  /**
   * Simulate the real `WebSocketClient`'s close sequence: a `stateChange`
   * away from `OPEN`, followed by the `close` event carrying the code and
   * reason. Real `WebSocketClient` emits `close` LAST (see
   * `_handleClose` in `websocket-client.ts`), so the orchestrator's
   * `stateChange` listener fires before its `close` listener sees the new
   * code - matching that order here is what exercises the "publish again
   * once the close code is known" path in `_setStatus`.
   */
  closeWith(code: number, reason: string): void {
    const prev = this.state;
    this.state = 'WAITING_RETRY';
    this.emit('stateChange', 'WAITING_RETRY', prev);
    this.emit('close', code, reason, 1000);
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

  const metrics = new NodeServerMetricsService();
  const orchestrator = new TranscriptionOrchestratorService(
    logger as never,
    bus,
    transcriptionServiceClient,
    poolFactory,
    { baseUrl: 'http://x', apiKey: 'tx-key' },
    metrics,
  );

  return {
    orchestrator,
    bus,
    longPoll,
    upstream,
    poolFactory,
    transcriptionStreamFactory,
    metrics,
  };
}

/**
 * Invoke the `onHandshake` the orchestrator registered on the upstream client,
 * with a fresh sender. Each call stands for one connection: the first one, or
 * any reconnect the client makes on its own after a drop.
 */
async function runUpstreamHandshake(
  h: Harness,
  sender: {
    send: ReturnType<typeof vi.fn>;
    sendBinary: ReturnType<typeof vi.fn>;
  },
): Promise<void> {
  const overrides = h.transcriptionStreamFactory.mock.calls[0]?.[1] as {
    onHandshake: (
      sender: unknown,
      messages: { on: () => void; off: () => void },
    ) => Promise<void>;
  };
  await overrides.onHandshake(sender, {
    on: () => undefined,
    off: () => undefined,
  });
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
      expect(h.transcriptionStreamFactory).toHaveBeenCalledWith(
        { params: { providerKey: PROVIDER_KEY } },
        expect.objectContaining({ onHandshake: expect.any(Function) }),
      );
      expect(h.upstream.start).toHaveBeenCalledTimes(1);

      // Auth and config are the handshake, not a one-time send after start().
      const sender = { send: vi.fn(), sendBinary: vi.fn() };
      await runUpstreamHandshake(h, sender);

      expect(sender.send).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'auth', api_key: 'tx-key' }),
      );
      expect(sender.send).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'config',
          config: { sample_rate: 48000, num_channels: 1 },
          session_uid: SESSION_UID,
          room_uid: ROOM_UID,
        }),
      );
    });

    it('re-sends auth and config on every reconnect', async () => {
      // A session that survives an upstream blip is the whole point: the
      // transcription service closes 1008 on unauthenticated binary, and this
      // client reconnects on its own. Sending credentials once meant the first
      // blip broke the session permanently while the source kept streaming.
      // Arrange
      const promise = h.orchestrator.registerSource(SESSION_UID);
      h.longPoll.emit('data', fakeSession());
      await promise;

      // Act - three independent connections, as three reconnects would be.
      const senders = [
        { send: vi.fn(), sendBinary: vi.fn() },
        { send: vi.fn(), sendBinary: vi.fn() },
        { send: vi.fn(), sendBinary: vi.fn() },
      ];
      for (const sender of senders) await runUpstreamHandshake(h, sender);

      // Assert
      for (const sender of senders) {
        expect(sender.send).toHaveBeenCalledWith(
          expect.objectContaining({ type: 'auth', api_key: 'tx-key' }),
        );
        expect(sender.send).toHaveBeenCalledWith(
          expect.objectContaining({ type: 'config', session_uid: SESSION_UID }),
        );
      }
    });

    it('replays the current config on reconnect, not the one it opened with', async () => {
      // Arrange
      const promise = h.orchestrator.registerSource(SESSION_UID);
      h.longPoll.emit('data', fakeSession());
      await promise;

      // Act - a config bump arrives, then the upstream reconnects.
      h.longPoll.emit('data', {
        ...fakeSession(),
        transcriptionStreamConfig: { sample_rate: 16000, num_channels: 2 },
        sessionConfigVersion: 2,
      });
      const sender = { send: vi.fn(), sendBinary: vi.fn() };
      await runUpstreamHandshake(h, sender);

      // Assert
      expect(sender.send).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'config',
          config: { sample_rate: 16000, num_channels: 2 },
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
        sourceMicrophoneActive: null,
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
      a.unregister();

      // Assert
      expect(h.upstream.terminate).not.toHaveBeenCalled();
      expect(h.longPoll.close).not.toHaveBeenCalled();
      expect(h.orchestrator.activeSessionCount).toBe(1);
    });

    it('tears down the upstream and publishes a final disconnected status when the last source unregisters', async () => {
      // Arrange
      const handle = await registerAndDrain(h, SESSION_UID);
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
      handle.unregister();

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
        // `null`, not `false`. With the last source gone the mic state is
        // unknown, not known-off; `false` would render "mic off" against a
        // session that has no source at all, and would contradict
        // `getStatus()`, which answers `null` for a session it holds no state
        // for.
        sourceMicrophoneActive: null,
      });
    });

    it('stops forwarding audio after the last source unregisters', async () => {
      // Arrange
      const handle = await registerAndDrain(h, SESSION_UID);

      // Act
      handle.unregister();
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
        sourceMicrophoneActive: null,
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
        sourceMicrophoneActive: null,
      });
    });
  });

  // archived-plans/2026-07-27-02-PLAN-AdmissionControl.md §4: node-server must
  // distinguish "service refused" (capacity) from "service crashed" instead of
  // collapsing both into the same `transcriptionServiceConnected: false`.
  describe('close-code disconnect reason (AdmissionControl §4)', (it) => {
    it('reports "at-capacity" after the upstream closes with 1013', async () => {
      // Arrange
      await registerAndDrain(h, SESSION_UID);
      h.upstream.setOpen();

      const statuses: {
        transcriptionServiceConnected: boolean;
        transcriptionServiceDisconnectReason?: string;
      }[] = [];
      h.bus.subscribe(
        SessionStatusChannel,
        (s) => {
          statuses.push(s);
        },
        SESSION_UID,
      );

      // Act - the transcription service refuses the reconnect for capacity.
      h.upstream.closeWith(1013, 'at-capacity');

      // Assert
      expect(statuses[statuses.length - 1]).toMatchObject({
        transcriptionServiceConnected: false,
        transcriptionServiceDisconnectReason: 'at-capacity',
      });
      expect(h.orchestrator.getStatus(SESSION_UID)).toMatchObject({
        transcriptionServiceDisconnectReason: 'at-capacity',
      });
    });

    it('reports "invalid-request" after the upstream closes with 1007', async () => {
      // Arrange - 1007 is what the transcription service closes with for a
      // TranscriptionClientError, and the one that actually happens is
      // "Invalid Provider Key": a session whose transcriptionProviderId is not
      // in the deployment's provider_config.json. The retry loop re-sends the
      // identical config forever, so collapsing this into the undistinguished
      // "disconnected" leaves every viewer on a reconnecting banner that can
      // never resolve.
      await registerAndDrain(h, SESSION_UID);
      h.upstream.setOpen();

      const statuses: {
        transcriptionServiceConnected: boolean;
        transcriptionServiceDisconnectReason?: string;
      }[] = [];
      h.bus.subscribe(
        SessionStatusChannel,
        (s) => {
          statuses.push(s);
        },
        SESSION_UID,
      );

      // Act
      h.upstream.closeWith(1007, 'Invalid Provider Key');

      // Assert
      expect(statuses[statuses.length - 1]).toMatchObject({
        transcriptionServiceConnected: false,
        transcriptionServiceDisconnectReason: 'invalid-request',
      });
      expect(h.orchestrator.getStatus(SESSION_UID)).toMatchObject({
        transcriptionServiceDisconnectReason: 'invalid-request',
      });
    });

    it('does not confuse a capacity refusal with a rejected request', async () => {
      // Arrange - the two reasons must stay distinguishable in both
      // directions: at-capacity clears when load drops, invalid-request never
      // clears without an operator, and a viewer is told different things.
      await registerAndDrain(h, SESSION_UID);
      h.upstream.setOpen();
      h.upstream.closeWith(1007, 'Invalid Provider Key');
      expect(h.orchestrator.getStatus(SESSION_UID)).toMatchObject({
        transcriptionServiceDisconnectReason: 'invalid-request',
      });

      // Act - a later reconnect is refused for capacity instead.
      h.upstream.setOpen();
      h.upstream.closeWith(1013, 'at-capacity');

      // Assert
      expect(h.orchestrator.getStatus(SESSION_UID)).toMatchObject({
        transcriptionServiceDisconnectReason: 'at-capacity',
      });
    });

    it('leaves the disconnect reason unset for an undistinguished close', async () => {
      // Arrange
      await registerAndDrain(h, SESSION_UID);
      h.upstream.setOpen();

      const statuses: {
        transcriptionServiceConnected: boolean;
        transcriptionServiceDisconnectReason?: string;
      }[] = [];
      h.bus.subscribe(
        SessionStatusChannel,
        (s) => {
          statuses.push(s);
        },
        SESSION_UID,
      );

      // Act - an ordinary abnormal closure, not a capacity refusal.
      h.upstream.closeWith(1006, '');

      // Assert - "not connected", same as before this field existed, with no
      // reason attached because none is known.
      expect(statuses[statuses.length - 1]).toMatchObject({
        transcriptionServiceConnected: false,
      });
      expect(
        statuses[statuses.length - 1]?.transcriptionServiceDisconnectReason,
      ).toBeUndefined();
    });

    it('clears the disconnect reason once the upstream reconnects and reaches OPEN', async () => {
      // Arrange
      await registerAndDrain(h, SESSION_UID);
      h.upstream.setOpen();
      h.upstream.closeWith(1013, 'at-capacity');

      const statuses: {
        transcriptionServiceConnected: boolean;
        transcriptionServiceDisconnectReason?: string;
      }[] = [];
      h.bus.subscribe(
        SessionStatusChannel,
        (s) => {
          statuses.push(s);
        },
        SESSION_UID,
      );

      // Act - capacity freed up; the client's own retry succeeds.
      h.upstream.setOpen();

      // Assert
      expect(statuses[statuses.length - 1]).toMatchObject({
        transcriptionServiceConnected: true,
      });
      expect(
        statuses[statuses.length - 1]?.transcriptionServiceDisconnectReason,
      ).toBeUndefined();
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
 * the registration promise resolves, returning the source handle.
 */
async function registerAndDrain(
  h: Harness,
  sessionUid: string,
): Promise<SourceHandle> {
  const promise = h.orchestrator.registerSource(sessionUid);
  h.longPoll.emit('data', fakeSession({ uid: sessionUid }));
  return await promise;
}
