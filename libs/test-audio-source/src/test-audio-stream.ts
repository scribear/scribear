import { ClockSync, encodeAudioFrame } from '@scribear/audio-frame-protocol';
import type { BaseLogger } from '@scribear/base-fastify-server';
import {
  TRANSCRIPTION_STREAM_CLIENT_ROUTE,
  TRANSCRIPTION_STREAM_SOURCE_ROUTE,
  TranscriptionStreamClientMessageType,
  TranscriptionStreamServerMessageType,
} from '@scribear/node-server-schema';

import type { DeviceAuthClient } from './device-auth.js';
import type { ChunkPlanner } from './faults.js';
import {
  type StreamSocket,
  connectStreamSocket,
  waitForSocketOpen,
} from './stream-socket.js';
import type { AudioChunk } from './wav.js';

/**
 * The streaming engine both synthetic devices run on.
 *
 * Finds the session active in its own device's room, opens a source socket and
 * a viewer socket, and puts frames on the wire on the schedule its
 * {@link ChunkPlanner} dictates. It contains no policy about *what* to send:
 * gain, noise and every fault knob live in the planner, and everything here is
 * the same for both devices.
 *
 * Two sockets rather than one, for the same reason the canary uses two: a
 * source token also carries `RECEIVE_TRANSCRIPTIONS`, but reading captions back
 * on the source socket would skip the `/client` route and the fan-out path, so
 * "the operator can see captions coming back" would be a claim about a code
 * path no real viewer takes.
 */

/** How often the source probes the server clock, matching the kiosk. */
const TIME_SYNC_INTERVAL_MS = 15_000;

export interface TestAudioStreamConfig {
  nodeServerBaseUrl: string;
  /** How long to wait for sockets to open and the upstream to report ready. */
  upstreamWaitMs: number;
}

/** Live counters a caller can read while a run is in flight. */
export interface StreamCounters {
  framesSent: number;
  framesFaulted: number;
  transcriptCount: number;
  lastTranscript: string | null;
}

/** How a run ended. */
export interface StreamResult {
  /** Null on a clean stop or a run that reached its deadline. */
  error: string | null;
}

export class TestAudioStream {
  private _config: TestAudioStreamConfig;
  private _auth: DeviceAuthClient;
  private _planner: ChunkPlanner;
  private _logger: BaseLogger;

  private _framesSent = 0;
  private _framesFaulted = 0;
  private _transcriptCount = 0;
  private _lastTranscript: string | null = null;
  private _sessionUid: string | null = null;
  private _stopped = false;

  constructor(
    config: TestAudioStreamConfig,
    auth: DeviceAuthClient,
    planner: ChunkPlanner,
    logger: BaseLogger,
  ) {
    this._config = config;
    this._auth = auth;
    this._planner = planner;
    this._logger = logger;
  }

  get counters(): StreamCounters {
    return {
      framesSent: this._framesSent,
      framesFaulted: this._framesFaulted,
      transcriptCount: this._transcriptCount,
      lastTranscript: this._lastTranscript,
    };
  }

  /** The session being streamed into, once one has been found. */
  get sessionUid(): string | null {
    return this._sessionUid;
  }

  /**
   * Asks the run to wind up.
   *
   * Checked between frames rather than interrupting a send, so a stop always
   * leaves a whole frame on the wire and never a torn one.
   */
  stop(): void {
    this._stopped = true;
  }

  /**
   * Streams `chunks` on a loop until {@link stop} is called or `deadlineMs`
   * passes.
   *
   * Never throws: a caller is a run manager that must record *why* a device
   * stopped and go back to idle either way, and an exception escaping here
   * would leave it stuck in `streaming` with no session behind it.
   */
  async run(
    chunks: readonly AudioChunk[],
    deadlineMs: number,
  ): Promise<StreamResult> {
    this._stopped = false;
    try {
      this._sessionUid = await this._auth.findActiveSession();
      const credentials = await this._auth.mintSessionToken(this._sessionUid);
      await this._stream(this._sessionUid, credentials.sessionToken, chunks, deadlineMs);
      return { error: null };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }

  private async _stream(
    sessionUid: string,
    sessionToken: string,
    chunks: readonly AudioChunk[],
    deadlineMs: number,
  ): Promise<void> {
    const clockSync = new ClockSync();
    const viewer = connectStreamSocket(
      this._config.nodeServerBaseUrl,
      TRANSCRIPTION_STREAM_CLIENT_ROUTE,
      sessionUid,
      sessionToken,
    );
    const source = connectStreamSocket(
      this._config.nodeServerBaseUrl,
      TRANSCRIPTION_STREAM_SOURCE_ROUTE,
      sessionUid,
      sessionToken,
    );

    this._observeViewer(viewer);
    source.on('message', (msg) => {
      if (msg.type === TranscriptionStreamServerMessageType.TIME_SYNC_PONG) {
        clockSync.record(msg.t0, msg.t1, Date.now());
      }
    });

    let timeSyncTimer: ReturnType<typeof setInterval> | null = null;
    try {
      await Promise.all([
        waitForSocketOpen(viewer, this._config.upstreamWaitMs),
        waitForSocketOpen(source, this._config.upstreamWaitMs),
      ]);

      const ping = () => {
        source.send({
          type: TranscriptionStreamClientMessageType.TIME_SYNC_PING,
          t0: Date.now(),
        });
      };
      // Probed once immediately as well as on the interval, so `sentAt` is
      // populated for most of the run rather than only after 15 s. Without it
      // the `clockSkewMs` knob would have nothing to skew for its first
      // hundred-odd frames.
      ping();
      timeSyncTimer = setInterval(ping, TIME_SYNC_INTERVAL_MS);

      await this._sendLoop(source, chunks, clockSync, deadlineMs);
    } finally {
      if (timeSyncTimer !== null) clearInterval(timeSyncTimer);
      source.terminate(1000, 'test-audio-complete');
      viewer.terminate(1000, 'test-audio-complete');
    }
  }

  private _observeViewer(viewer: StreamSocket): void {
    viewer.on('message', (msg) => {
      if (msg.type !== TranscriptionStreamServerMessageType.TRANSCRIPT) return;
      this._transcriptCount++;
      // `inProgress` drafts are counted but not kept: the operator wants the
      // last *settled* caption as evidence the pipeline produced words, and a
      // draft would flicker between reads three seconds apart.
      if (msg.final !== null) {
        this._lastTranscript = msg.final.text.join(' ');
      }
    });
  }

  /**
   * The send loop, paced against an absolute schedule.
   *
   * Accumulating `waitMs` into `nextSendAt` rather than sleeping a fixed amount
   * each iteration keeps encoding time out of the pacing: sleeping
   * `waitMs` after the work would make the stream drift slower than realtime by
   * however long the DSP took, and a `good` device would then never quite be
   * the realtime reference it exists to be.
   */
  private async _sendLoop(
    source: StreamSocket,
    chunks: readonly AudioChunk[],
    clockSync: ClockSync,
    deadlineMs: number,
  ): Promise<void> {
    if (chunks.length === 0) return;

    let nextSendAt = Date.now();
    for (let i = 0; Date.now() < deadlineMs && !this._stopped; i++) {
      const chunk = chunks[i % chunks.length];
      if (chunk === undefined) break;

      const plan = this._planner.plan(chunk);
      let chunkId: string | null = null;

      for (const frame of plan.frames) {
        // A stuttered copy reuses the id rather than minting one — the
        // duplicate `chunkId` is the observable the knob is named for, and a
        // fresh id would make the repeat indistinguishable from ordinary audio.
        if (chunkId === null || !frame.reuseChunkId) {
          chunkId = crypto.randomUUID();
        }

        // `sentAt` is omitted entirely until the clock is synced, exactly as a
        // real source does; skewing a timestamp that is not being sent would be
        // a fault nobody could observe.
        const base = clockSync.toRemote(Date.now());
        const fields =
          base !== null
            ? { chunkId, sentAt: base + frame.sentAtSkewMs }
            : { chunkId };
        let encoded = encodeAudioFrame(fields, new Uint8Array(frame.wav));
        if (frame.corrupt) encoded = this._planner.corruptFrame(encoded);

        source.sendBinary(encoded.buffer as ArrayBuffer);
        this._framesSent++;
      }
      if (plan.faulted) this._framesFaulted++;

      nextSendAt += plan.waitMs;
      const delay = nextSendAt - Date.now();
      if (delay > 0) await sleep(delay);
    }

    this._logger.debug(
      { framesSent: this._framesSent, framesFaulted: this._framesFaulted },
      'test-audio send loop finished',
    );
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
