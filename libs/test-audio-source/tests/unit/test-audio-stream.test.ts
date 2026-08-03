import { afterEach, beforeEach, describe, expect, vi } from 'vitest';

import {
  type DecodedAudioFrame,
  decodeAudioFrame,
} from '@scribear/audio-frame-protocol';
import type { BaseLogger } from '@scribear/base-fastify-server';
import {
  TRANSCRIPTION_STREAM_SOURCE_ROUTE,
  TranscriptionStreamClientMessageType,
  TranscriptionStreamServerMessageType,
} from '@scribear/node-server-schema';

import type { DeviceAuthClient } from '#src/device-auth.js';
import { FaultEngine } from '#src/faults.js';
import { GoodEngine } from '#src/good-engine.js';
import {
  FAULT_PARAM_DEFAULTS,
  type FaultParams,
  GOOD_PARAM_DEFAULTS,
} from '#src/params.js';
import { createSeededRng } from '#src/rng.js';
import type { StreamSocket } from '#src/stream-socket.js';
import { TestAudioStream } from '#src/test-audio-stream.js';
import { decodeWav } from '#src/wav.js';
import { CHUNK_MS, SAMPLE_RATE, chunksOf, sine } from '#tests/utils/signals.js';

/**
 * Offset the fake node server's clock sits at, relative to the device's.
 *
 * Non-zero and large so `sentAt` cannot accidentally equal the local time: a
 * `sentAt` written from the wrong clock domain is exactly the mistake the
 * `clockSkewMs` knob exists to make visible, and it must not be what the test
 * measures instead.
 */
const SERVER_CLOCK_OFFSET_MS = 7_000;
/** Fixed wall clock, so every timestamp assertion below is exact. */
const FIXED_NOW_MS = 1_760_000_000_000;
/** How long each simulated run streams for. */
const RUN_MS = 1_000;
/** Chunks a realtime run of `RUN_MS` puts on the wire. */
const REALTIME_FRAMES = RUN_MS / CHUNK_MS;

/** Sockets the streamer opened during the run under test, in order. */
const opened: FakeSocket[] = [];

vi.mock('#src/stream-socket.js', () => ({
  connectStreamSocket: (
    _baseUrl: string,
    route: { url: string },
    sessionUid: string,
  ) => {
    const socket = new FakeSocket(route.url, sessionUid);
    opened.push(socket);
    return socket as unknown as StreamSocket;
  },
  waitForSocketOpen: () => Promise.resolve(),
}));

/**
 * A transcription-stream socket that records what was sent.
 *
 * Answers a `timeSyncPing` synchronously with a pong offset by
 * {@link SERVER_CLOCK_OFFSET_MS}, which under fake timers makes the round trip
 * take zero milliseconds and the estimated offset exact.
 */
class FakeSocket {
  readonly url: string;
  readonly sessionUid: string;
  readonly binary: Uint8Array[] = [];
  private _listeners = new Map<string, ((...args: never[]) => void)[]>();

  constructor(url: string, sessionUid: string) {
    this.url = url;
    this.sessionUid = sessionUid;
  }

  on(event: string, callback: (...args: never[]) => void): void {
    const existing = this._listeners.get(event) ?? [];
    existing.push(callback);
    this._listeners.set(event, existing);
  }

  off(): void {
    // The streamer only detaches on teardown, which this fake does not model.
  }

  send(message: {
    type: TranscriptionStreamClientMessageType;
    t0?: number;
  }): void {
    if (message.type !== TranscriptionStreamClientMessageType.TIME_SYNC_PING)
      return;
    const pong = {
      type: TranscriptionStreamServerMessageType.TIME_SYNC_PONG,
      t0: message.t0 ?? 0,
      t1: (message.t0 ?? 0) + SERVER_CLOCK_OFFSET_MS,
    };
    for (const callback of this._listeners.get('message') ?? []) {
      (callback as (msg: typeof pong) => void)(pong);
    }
  }

  sendBinary(data: ArrayBuffer): void {
    this.binary.push(new Uint8Array(data));
  }

  terminate(): void {
    // Nothing to tear down.
  }
}

const logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
} as unknown as BaseLogger;

const auth = {
  findActiveSession: () => Promise.resolve('session-under-test'),
  mintSessionToken: () =>
    Promise.resolve({
      sessionToken: 'session-token',
      scopes: [],
      expiresAtMs: 0,
    }),
} as unknown as DeviceAuthClient;

interface RunOutcome {
  frames: DecodedAudioFrame[];
  raw: Uint8Array[];
  framesSent: number;
  framesFaulted: number;
  error: string | null;
}

/**
 * Streams a second of tone through `planner` and reports what reached the wire.
 *
 * Rewinds the fake clock first so two runs compared against each other are
 * timestamped from the same instant; without that, the second run's `sentAt`
 * would differ from the first's by however long the first one took, and a
 * skew assertion would be measuring the test harness.
 */
async function streamFor(
  planner: FaultEngine | GoodEngine,
  runMs = RUN_MS,
): Promise<RunOutcome> {
  vi.setSystemTime(FIXED_NOW_MS);
  opened.length = 0;
  const stream = new TestAudioStream(
    { nodeServerBaseUrl: 'http://node-server.test', upstreamWaitMs: 1_000 },
    auth,
    planner,
    logger,
  );

  const running = stream.run(
    chunksOf(sine(SAMPLE_RATE, 440, 0.5)),
    Date.now() + runMs,
  );
  await vi.advanceTimersByTimeAsync(runMs + CHUNK_MS);
  const result = await running;

  const source = opened.find(
    (socket) => socket.url === TRANSCRIPTION_STREAM_SOURCE_ROUTE.url,
  );
  const raw = source?.binary ?? [];
  return {
    raw,
    frames: raw.flatMap((bytes) => {
      try {
        return [decodeAudioFrame(bytes)];
      } catch {
        return [];
      }
    }),
    framesSent: stream.counters.framesSent,
    framesFaulted: stream.counters.framesFaulted,
    error: result.error,
  };
}

function faultEngine(params: Partial<FaultParams>): FaultEngine {
  return new FaultEngine(
    { ...FAULT_PARAM_DEFAULTS, ...params },
    createSeededRng(31_337),
  );
}

describe('test-audio-stream', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW_MS);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('a clean run', (it) => {
    it('puts one realtime-paced frame per chunk on the source socket', async () => {
      // Arrange — the baseline every fault below is measured against. Two
      // sockets are opened, and only the source one carries audio: reading
      // captions back on the source socket would skip the fan-out path a real
      // viewer takes.

      // Act
      const run = await streamFor(
        new GoodEngine({ ...GOOD_PARAM_DEFAULTS }, createSeededRng(1)),
      );

      // Assert
      expect(run.error).toBeNull();
      expect(run.framesSent).toBe(REALTIME_FRAMES);
      expect(run.frames).toHaveLength(REALTIME_FRAMES);
      expect(run.framesFaulted).toBe(0);
      expect(opened).toHaveLength(2);
      expect(new Set(run.frames.map((frame) => frame.chunkId)).size).toBe(
        REALTIME_FRAMES,
      );
    });

    it('stamps sentAt in the server clock domain', async () => {
      // Arrange — `sentAt` is what the end-to-end latency measurement is taken
      // against, so it is sent already corrected into the node's clock. With a
      // zero round trip the correction is exactly the server's offset, and the
      // first frame goes out at the run's start.

      // Act
      const run = await streamFor(faultEngine({}));

      // Assert
      expect(run.frames[0]?.sentAt).toBe(FIXED_NOW_MS + SERVER_CLOCK_OFFSET_MS);
    });
  });

  describe('clockSkewMs', (it) => {
    it('lands in the frame sentAt, decoded back out', async () => {
      // Arrange — a `sentAt` in the future makes the node compute a negative
      // end-to-end latency, which is what the S5 clock-skew warning fires on.
      // Nothing else about the frame may move.
      const SKEW_MS = -3_000;

      // Act
      const skewed = await streamFor(faultEngine({ clockSkewMs: SKEW_MS }));
      const clean = await streamFor(faultEngine({}));

      // Assert
      for (const [index, frame] of skewed.frames.entries()) {
        expect(frame.sentAt).toBe((clean.frames[index]?.sentAt ?? 0) + SKEW_MS);
        expect(
          Buffer.from(frame.audio).equals(
            Buffer.from(clean.frames[index]?.audio ?? new Uint8Array()),
          ),
        ).toBe(true);
      }
      expect(skewed.framesFaulted).toBe(REALTIME_FRAMES);
    });

    it('accepts a positive skew as well', async () => {
      // Act
      const run = await streamFor(faultEngine({ clockSkewMs: 5_000 }));

      // Assert
      expect(run.frames[0]?.sentAt).toBe(
        FIXED_NOW_MS + SERVER_CLOCK_OFFSET_MS + 5_000,
      );
    });
  });

  describe('speedup', (it) => {
    it('sends twice the frames in the same window, byte for byte the same audio', async () => {
      // Arrange — the knob exists to trip the transcription service's
      // faster-than-realtime rejection. If it also changed the audio, an
      // operator could not tell which fault they were seeing, so the payloads
      // must match a realtime run frame for frame. Run one at a time: the two
      // runs share the fake clock.

      // Act
      const realtime = await streamFor(faultEngine({}));
      const fast = await streamFor(faultEngine({ speedup: 2 }));

      // Assert
      expect(realtime.framesSent).toBe(REALTIME_FRAMES);
      expect(fast.framesSent).toBe(REALTIME_FRAMES * 2);
      for (const [index, frame] of realtime.frames.entries()) {
        expect(
          Buffer.from(fast.frames[index]?.audio ?? new Uint8Array()).equals(
            Buffer.from(frame.audio),
          ),
        ).toBe(true);
      }
      // Not a fault on any frame: it changes when frames are sent, not what
      // they contain.
      expect(fast.framesFaulted).toBe(0);
    });
  });

  describe('stutterPct', (it) => {
    it('puts the repeated chunk on the wire under the same chunkId', async () => {
      // Arrange — the duplicate id is the observable the knob is named for. A
      // fresh id on the copy would make the repeat indistinguishable from
      // ordinary audio, and the caption repetition would have no cause an
      // operator could point at.

      // Act
      const run = await streamFor(faultEngine({ stutterPct: 100 }));

      // Assert
      expect(run.frames.length % 2).toBe(0);
      expect(run.frames.length).toBeGreaterThan(0);
      for (let i = 0; i < run.frames.length; i += 2) {
        const first = run.frames[i];
        const repeat = run.frames[i + 1];
        expect(repeat?.chunkId).toBe(first?.chunkId);
        expect(
          Buffer.from(repeat?.audio ?? new Uint8Array()).equals(
            Buffer.from(first?.audio ?? new Uint8Array()),
          ),
        ).toBe(true);
      }
      // Every id is used exactly twice, so no chunk leaked an extra one.
      expect(new Set(run.frames.map((frame) => frame.chunkId)).size).toBe(
        run.frames.length / 2,
      );
    });
  });

  describe('dropPct', (it) => {
    it('leaves a gap rather than closing up the schedule', async () => {
      // Arrange — at 100 nothing reaches the wire at all, but the loop must
      // still advance through the same number of chunks; a run that instead
      // spun through the fixture would burn the deadline in microseconds.

      // Act
      const run = await streamFor(faultEngine({ dropPct: 100 }));

      // Assert
      expect(run.framesSent).toBe(0);
      expect(run.raw).toHaveLength(0);
      expect(run.framesFaulted).toBe(REALTIME_FRAMES);
      expect(run.error).toBeNull();
    });
  });

  describe('corruptPct', (it) => {
    it('puts frames on the wire that the real decoder rejects', async () => {
      // Arrange — asserted against `decodeAudioFrame` from the protocol library
      // rather than against an idea of what corruption looks like: what matters
      // is that the receiver's decoder is the thing that refuses it, because
      // that refusal is what increments `safp_decode_drops_total`.

      // Act
      const run = await streamFor(faultEngine({ corruptPct: 100 }));

      // Assert
      expect(run.framesSent).toBe(REALTIME_FRAMES);
      expect(run.raw).toHaveLength(REALTIME_FRAMES);
      // `run.frames` only holds what decoded; all of them must have failed.
      expect(run.frames).toHaveLength(0);
      for (const bytes of run.raw) {
        expect(() => decodeAudioFrame(bytes)).toThrow(/CRC/);
      }
    });
  });

  describe('waveform knobs on the wire', (it) => {
    it('carries a silenced chunk as a well-formed WAV of zeros', async () => {
      // Arrange — silence has to stay a *valid* frame, or the fault would show
      // up as a decode drop instead of as the silence telemetry it is meant to
      // move.

      // Act
      const run = await streamFor(faultEngine({ silencePct: 100 }));

      // Assert
      expect(run.frames).toHaveLength(REALTIME_FRAMES);
      for (const frame of run.frames) {
        const wav = decodeWav(Buffer.from(frame.audio));
        expect(wav.sampleRate).toBe(SAMPLE_RATE);
        expect(wav.pcm.length).toBeGreaterThan(0);
        expect(wav.pcm.every((byte) => byte === 0)).toBe(true);
      }
    });

    it('carries a bad-header chunk as a WAV that opens at the wrong rate', async () => {
      // Act
      const run = await streamFor(faultEngine({ badHeaderPct: 100 }));

      // Assert
      expect(run.frames).toHaveLength(REALTIME_FRAMES);
      for (const frame of run.frames) {
        expect(decodeWav(Buffer.from(frame.audio)).sampleRate).not.toBe(
          SAMPLE_RATE,
        );
      }
    });
  });

  describe('run', (it) => {
    it('reports an auth failure instead of throwing it', async () => {
      // Arrange — the caller is a run manager that has to record why a device
      // stopped and go back to idle either way. An exception escaping here
      // would leave it stuck in `streaming` with no session behind it.
      const failing = {
        findActiveSession: () =>
          Promise.reject(new Error('No active session.')),
        mintSessionToken: () => Promise.reject(new Error('unreachable')),
      } as unknown as DeviceAuthClient;
      const stream = new TestAudioStream(
        { nodeServerBaseUrl: 'http://node-server.test', upstreamWaitMs: 1_000 },
        failing,
        faultEngine({}),
        logger,
      );

      // Act
      const result = await stream.run(
        chunksOf(sine(SAMPLE_RATE, 440, 0.5)),
        Date.now() + 10,
      );

      // Assert
      expect(result.error).toBe('No active session.');
      expect(stream.counters.framesSent).toBe(0);
    });

    it('records the session it attached to', async () => {
      // Arrange — the room the session belongs to is the whole safety boundary
      // for these devices, so a caller has to be able to read back which one
      // was streamed into.
      const stream = new TestAudioStream(
        { nodeServerBaseUrl: 'http://node-server.test', upstreamWaitMs: 1_000 },
        auth,
        faultEngine({}),
        logger,
      );

      // Act
      const running = stream.run(
        chunksOf(sine(SAMPLE_RATE, 440, 0.5)),
        Date.now() + 200,
      );
      await vi.advanceTimersByTimeAsync(300);
      await running;

      // Assert
      expect(stream.sessionUid).toBe('session-under-test');
      expect(
        opened.every((socket) => socket.sessionUid === 'session-under-test'),
      ).toBe(true);
    });

    it('stops between frames when asked, leaving no torn frame behind', async () => {
      // Arrange — `stop` is checked between chunks rather than interrupting a
      // send, so a stop always leaves a whole frame on the wire.
      const stream = new TestAudioStream(
        { nodeServerBaseUrl: 'http://node-server.test', upstreamWaitMs: 1_000 },
        auth,
        faultEngine({}),
        logger,
      );
      opened.length = 0;

      // Act
      const running = stream.run(
        chunksOf(sine(SAMPLE_RATE, 440, 0.5)),
        Date.now() + RUN_MS,
      );
      await vi.advanceTimersByTimeAsync(CHUNK_MS * 3);
      stream.stop();
      await vi.advanceTimersByTimeAsync(RUN_MS);
      const result = await running;

      // Assert
      expect(result.error).toBeNull();
      expect(stream.counters.framesSent).toBeLessThan(REALTIME_FRAMES);
      const source = opened.find(
        (socket) => socket.url === TRANSCRIPTION_STREAM_SOURCE_ROUTE.url,
      );
      for (const bytes of source?.binary ?? []) {
        expect(() => decodeAudioFrame(bytes)).not.toThrow();
      }
    });
  });
});
