import { vi } from 'vitest';

import type {
  AudioChunk,
  StreamCounters,
  StreamResult,
} from '@scribear/test-audio-source';
import { DeviceAuthClient, encodeWav } from '@scribear/test-audio-source';

import type { ClipSource } from '#src/server/shared/devices/device-runner.js';

/**
 * Stand-ins for everything the run manager talks to that is not itself.
 *
 * The streaming engine is faked rather than its sockets: what these tests are
 * about is who may start a device, when a run ends and what is reported — none
 * of which involves a wire, and all of which would be obscured by one.
 */

/** Every fake stream constructed since the last {@link takeStreams}. */
const streams: FakeStream[] = [];

/**
 * A drop-in for `TestAudioStream` whose run ends when a test says so.
 *
 * Install it with, at the top of a test file:
 *
 * ```ts
 * vi.mock('@scribear/test-audio-source', async (importOriginal) => ({
 *   ...(await importOriginal<typeof import('@scribear/test-audio-source')>()),
 *   TestAudioStream: (await import('#tests/utils/fakes.js')).FakeStream,
 * }));
 * ```
 */
export class FakeStream {
  /** True once `run` was called — false if a stop beat the clip load. */
  ran = false;
  /** True once `stop` was called. */
  stopped = false;
  /** The deadline the runner passed, so the auto-stop can be asserted on. */
  deadlineMs: number | null = null;
  chunks: readonly AudioChunk[] = [];

  private _framesSent = 0;
  private _framesFaulted = 0;
  private _transcriptCount = 0;
  private _lastTranscript: string | null = null;
  private _sessionUid: string | null = null;
  private _resolve: ((result: StreamResult) => void) | null = null;

  constructor() {
    streams.push(this);
  }

  get counters(): StreamCounters {
    return {
      framesSent: this._framesSent,
      framesFaulted: this._framesFaulted,
      transcriptCount: this._transcriptCount,
      lastTranscript: this._lastTranscript,
    };
  }

  get sessionUid(): string | null {
    return this._sessionUid;
  }

  stop(): void {
    this.stopped = true;
  }

  run(
    chunks: readonly AudioChunk[],
    deadlineMs: number,
  ): Promise<StreamResult> {
    this.ran = true;
    this.chunks = chunks;
    this.deadlineMs = deadlineMs;
    this._sessionUid = 'session-uid';
    return new Promise<StreamResult>((resolve) => {
      this._resolve = resolve;
    });
  }

  /** Pretends `n` more frames reached the wire. */
  emitFrames(n: number): void {
    this._framesSent += n;
  }

  /** Pretends a transcript came back on the viewer socket. */
  emitTranscript(text: string): void {
    this._transcriptCount++;
    this._lastTranscript = text;
  }

  /** Ends the run, cleanly or with the reason it failed. */
  finish(error: string | null): void {
    this._resolve?.({ error });
    this._resolve = null;
  }
}

/** Returns the streams constructed since the last call, and clears the list. */
export function takeStreams(): FakeStream[] {
  return streams.splice(0, streams.length);
}

/** One second of 16 kHz mono silence, sliced the way the catalog would. */
function oneChunk(): AudioChunk {
  const pcm = Buffer.alloc(16_000 * 2);
  return { wav: encodeWav(pcm, 16_000, 1), durationMs: 1000, index: 0 };
}

export interface FakeClips extends ClipSource {
  /** Lets a load that was told to block finish. */
  release: () => void;
}

/**
 * A clip source that answers instantly, or on demand when `block` is set.
 *
 * Blocking is what makes the "stop arrived while the clip was still loading"
 * case testable at all: in production that window is a file read, which is far
 * too short to hit deliberately.
 */
export function fakeClips(options: { block?: boolean } = {}): FakeClips {
  let release = () => {
    // Replaced below when blocking.
  };
  const gate = options.block
    ? new Promise<void>((resolve) => {
        release = resolve;
      })
    : Promise.resolve();

  return {
    load: async () => {
      await gate;
      return [oneChunk()];
    },
    release: () => {
      release();
    },
  };
}

export interface FakeAuth extends DeviceAuthClient {
  /** Set to make the next room read fail, as an unreachable upstream would. */
  failRoom: boolean;
}

/**
 * A real {@link DeviceAuthClient} with its room lookup stubbed.
 *
 * Real rather than a plain object because the class carries a private field, so
 * nothing structural is assignable to it — and because the runner hands it
 * straight to the stream, where the type has to hold.
 */
export function fakeDeviceAuth(roomName = 'TEST-AUDIO-GOOD'): FakeAuth {
  const auth = new DeviceAuthClient({
    sessionManagerBaseUrl: 'http://session-manager',
    deviceToken: 'device-uid:secret',
    timeoutMs: 100,
  }) as FakeAuth;
  auth.failRoom = false;

  vi.spyOn(auth, 'findMyRoom').mockImplementation(async () => {
    if (auth.failRoom) {
      throw new Error('Could not reach session-manager.');
    }
    return Promise.resolve({ uid: 'room-uid', name: roomName });
  });

  return auth;
}
