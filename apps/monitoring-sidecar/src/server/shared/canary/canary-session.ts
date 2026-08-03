import { ClockSync, encodeAudioFrame } from '@scribear/audio-frame-protocol';
import type { BaseLogger } from '@scribear/base-fastify-server';
import {
  LatencyKind,
  TRANSCRIPTION_STREAM_CLIENT_ROUTE,
  TRANSCRIPTION_STREAM_SOURCE_ROUTE,
  TranscriptionStreamClientMessageType,
  TranscriptionStreamServerMessageType,
} from '@scribear/node-server-schema';
import {
  type AudioChunk,
  DeviceAuthClient,
  DeviceAuthError,
  NoActiveSessionError,
  type StreamSocket,
  connectStreamSocket,
  waitForSocketOpen,
} from '@scribear/test-audio-source';

import {
  CanaryOutcome,
  type CanaryRunResult,
} from '#src/server/shared/canary/canary-types.js';
import {
  repetitionRatio,
  scoreTranscript,
} from '#src/server/shared/canary/transcript-accuracy.js';

/** How often the source probes the server clock, matching the kiosk. */
const TIME_SYNC_INTERVAL_MS = 15_000;

export interface CanarySessionConfig {
  nodeServerBaseUrl: string;
  /** Ground-truth text of the fixture, for the accuracy proxy. */
  expectedTranscript: string;
  /** How long to keep streaming before scoring and disconnecting. */
  runDurationMs: number;
  /** Grace period after the last chunk for trailing transcripts to arrive. */
  drainMs: number;
  /** How long to wait for `sessionStatus.transcriptionServiceConnected`. */
  upstreamWaitMs: number;
}

/** Mutable state accumulated across one run. */
interface RunState {
  transcriptParts: string[];
  transcriptCount: number;
  firstTranscriptAtMs: number | null;
  firstChunkAtMs: number | null;
  chunksSent: number;
  pipelineMs: number[];
  e2eMs: number[];
  closeCodes: number[];
  transcriptionServiceConnected: boolean;
  sourceDeviceConnected: boolean;
}

/**
 * Runs one end-to-end canary probe: stream known audio in as a source, read
 * captions back out as a viewer, and score what came back.
 *
 * Deliberately uses **two sockets** even though a source token also carries
 * `RECEIVE_TRANSCRIPTIONS`. Reading transcripts on the source socket would skip
 * the `/client` route and the fan-out path entirely — the exact code real
 * viewers depend on. A pipeline can be perfectly healthy up to the node and
 * still deliver nothing to viewers; one socket cannot tell those apart.
 */
export class CanarySession {
  private _config: CanarySessionConfig;
  private _auth: DeviceAuthClient;
  private _logger: BaseLogger;

  constructor(
    config: CanarySessionConfig,
    auth: DeviceAuthClient,
    logger: BaseLogger,
  ) {
    this._config = config;
    this._auth = auth;
    this._logger = logger;
  }

  /**
   * Executes one probe. Never throws; every failure becomes an outcome.
   *
   * @param chunks The audio loop to stream, pre-sliced by the runner so the
   *   fixture is read and decoded once rather than on every probe.
   */
  async run(chunks: readonly AudioChunk[]): Promise<CanaryRunResult> {
    const startedAtMs = Date.now();
    let sessionUid: string | null = null;

    try {
      sessionUid = await this._auth.findActiveSession();
      const credentials = await this._auth.mintSessionToken(sessionUid);
      return await this._stream(
        sessionUid,
        credentials.sessionToken,
        chunks,
        startedAtMs,
      );
    } catch (err) {
      return {
        ...emptyResult(startedAtMs, sessionUid),
        outcome: classifyError(err),
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - startedAtMs,
      };
    }
  }

  private async _stream(
    sessionUid: string,
    sessionToken: string,
    chunks: readonly AudioChunk[],
    startedAtMs: number,
  ): Promise<CanaryRunResult> {
    const state: RunState = {
      transcriptParts: [],
      transcriptCount: 0,
      firstTranscriptAtMs: null,
      firstChunkAtMs: null,
      chunksSent: 0,
      pipelineMs: [],
      e2eMs: [],
      closeCodes: [],
      transcriptionServiceConnected: false,
      sourceDeviceConnected: false,
    };
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

    this._observeViewer(viewer, state);
    this._observeSource(source, state, clockSync);

    let timeSyncTimer: ReturnType<typeof setInterval> | null = null;

    try {
      // Both sockets must be authenticated before streaming: audio sent before
      // the viewer is listening produces transcripts nobody measures, which
      // would read as a caption failure that never happened.
      await Promise.all([
        waitForSocketOpen(viewer, this._config.upstreamWaitMs),
        waitForSocketOpen(source, this._config.upstreamWaitMs),
      ]);

      timeSyncTimer = setInterval(() => {
        source.send({
          type: TranscriptionStreamClientMessageType.TIME_SYNC_PING,
          t0: Date.now(),
        });
      }, TIME_SYNC_INTERVAL_MS);
      // Probe once immediately so `sentAt` is populated for most of the run
      // rather than only after the first interval elapses.
      source.send({
        type: TranscriptionStreamClientMessageType.TIME_SYNC_PING,
        t0: Date.now(),
      });

      const upstreamReady = await this._waitForUpstream(state);
      if (!upstreamReady) {
        return finalize(
          state,
          startedAtMs,
          sessionUid,
          this._config,
          CanaryOutcome.UPSTREAM_DOWN,
          'Node server never reported an upstream transcription connection for this session.',
        );
      }

      await this._streamAudio(source, chunks, state, clockSync);
      await sleep(this._config.drainMs);

      return finalize(state, startedAtMs, sessionUid, this._config, null, null);
    } catch (err) {
      return finalize(
        state,
        startedAtMs,
        sessionUid,
        this._config,
        classifyError(err),
        err instanceof Error ? err.message : String(err),
      );
    } finally {
      if (timeSyncTimer !== null) clearInterval(timeSyncTimer);
      source.terminate(1000, 'canary-complete');
      viewer.terminate(1000, 'canary-complete');
    }
  }

  private _observeViewer(viewer: StreamSocket, state: RunState): void {
    viewer.on('message', (msg) => {
      switch (msg.type) {
        case TranscriptionStreamServerMessageType.TRANSCRIPT: {
          state.transcriptCount++;
          state.firstTranscriptAtMs ??= Date.now();
          // `final` fragments accumulate; `inProgress` is a replaceable draft
          // and is deliberately not scored, or the same words would be counted
          // repeatedly as they firm up.
          if (msg.final !== null) {
            state.transcriptParts.push(msg.final.text.join(' '));
          }
          break;
        }
        case TranscriptionStreamServerMessageType.SESSION_STATUS:
          state.transcriptionServiceConnected =
            msg.transcriptionServiceConnected;
          state.sourceDeviceConnected = msg.sourceDeviceConnected;
          break;
        case TranscriptionStreamServerMessageType.LATENCY_UPDATE:
          // Only finalized samples are recorded. In-progress latency measures a
          // draft that will be revised, so mixing the two would understate the
          // latency a viewer actually experiences for settled captions.
          if (msg.kind === LatencyKind.FINAL) {
            state.pipelineMs.push(msg.pipelineMs);
            if (msg.e2eMs !== null) state.e2eMs.push(msg.e2eMs);
          }
          break;
        default:
          break;
      }
    });
    viewer.on('close', (code) => {
      state.closeCodes.push(code);
    });
  }

  private _observeSource(
    source: StreamSocket,
    state: RunState,
    clockSync: ClockSync,
  ): void {
    source.on('message', (msg) => {
      if (msg.type === TranscriptionStreamServerMessageType.TIME_SYNC_PONG) {
        clockSync.record(msg.t0, msg.t1, Date.now());
      } else if (
        msg.type === TranscriptionStreamServerMessageType.SESSION_STATUS
      ) {
        state.transcriptionServiceConnected = msg.transcriptionServiceConnected;
        state.sourceDeviceConnected = msg.sourceDeviceConnected;
      }
    });
    source.on('close', (code) => {
      state.closeCodes.push(code);
    });
  }

  /** Polls until the node reports an upstream link, or gives up. */
  private async _waitForUpstream(state: RunState): Promise<boolean> {
    const deadline = Date.now() + this._config.upstreamWaitMs;
    while (Date.now() < deadline) {
      if (state.transcriptionServiceConnected) return true;
      await sleep(100);
    }
    return state.transcriptionServiceConnected;
  }

  /**
   * Streams the fixture, paced at realtime and looping until the run window
   * closes.
   *
   * Realtime pacing is mandatory, not cosmetic. It no longer disconnects the
   * session — the transcription service used to raise "Client sent audio too
   * quickly" when a decode batch overran its buffer, and now drops the tail and
   * continues — but a canary streaming at full speed would still overrun that
   * buffer, lose most of its fixture to `audio_dropped_buffer_full`, and then
   * report the missing captions as a transcription fault it caused itself.
   */
  private async _streamAudio(
    source: StreamSocket,
    chunks: readonly AudioChunk[],
    state: RunState,
    clockSync: ClockSync,
  ): Promise<void> {
    if (chunks.length === 0) return;

    const deadline = Date.now() + this._config.runDurationMs;
    let nextSendAt = Date.now();

    for (let i = 0; Date.now() < deadline; i++) {
      const chunk = chunks[i % chunks.length];
      if (chunk === undefined) break;

      const sentAt = clockSync.toRemote(Date.now());
      const fields =
        sentAt !== null
          ? { chunkId: crypto.randomUUID(), sentAt }
          : { chunkId: crypto.randomUUID() };
      const frame = encodeAudioFrame(fields, new Uint8Array(chunk.wav));
      source.sendBinary(frame.buffer as ArrayBuffer);

      state.chunksSent++;
      state.firstChunkAtMs ??= Date.now();

      // Pace against an absolute schedule rather than sleeping a fixed amount
      // each iteration, so encoding time does not accumulate into drift that
      // would gradually push the stream slower than realtime.
      nextSendAt += chunk.durationMs;
      const delay = nextSendAt - Date.now();
      if (delay > 0) await sleep(delay);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Maps a thrown error onto the outcome that best explains it. */
function classifyError(err: unknown): CanaryOutcome {
  if (err instanceof NoActiveSessionError) return CanaryOutcome.NO_SESSION;
  if (err instanceof DeviceAuthError) return CanaryOutcome.AUTH_FAILED;
  if (err instanceof Error && err.message.includes('Socket')) {
    return CanaryOutcome.CONNECT_FAILED;
  }
  return CanaryOutcome.ERROR;
}

function percentile(sorted: number[], fraction: number): number | null {
  if (sorted.length === 0) return null;
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(fraction * sorted.length) - 1),
  );
  return sorted[index] ?? null;
}

function emptyResult(
  startedAtMs: number,
  sessionUid: string | null,
): CanaryRunResult {
  return {
    outcome: CanaryOutcome.ERROR,
    startedAtMs,
    durationMs: 0,
    sessionUid,
    error: null,
    timeToFirstTranscriptMs: null,
    transcriptCount: 0,
    chunksSent: 0,
    transcriptText: '',
    accuracy: null,
    repetitionRatio: null,
    pipelineMsP50: null,
    pipelineMsP95: null,
    e2eMsP95: null,
    clockSyncEstablished: false,
    transcriptionServiceConnected: false,
    sourceDeviceConnected: false,
    closeCodes: [],
  };
}

/** Scores the accumulated state into a result. */
function finalize(
  state: RunState,
  startedAtMs: number,
  sessionUid: string,
  config: CanarySessionConfig,
  forcedOutcome: CanaryOutcome | null,
  error: string | null,
): CanaryRunResult {
  const transcriptText = state.transcriptParts.join(' ').trim();
  const pipelineSorted = [...state.pipelineMs].sort((a, b) => a - b);
  const e2eSorted = [...state.e2eMs].sort((a, b) => a - b);

  // Streaming audio and getting nothing back is the failure A2 exists to
  // catch; it is decided here rather than by a threshold rule so the outcome
  // itself carries the meaning.
  const outcome =
    forcedOutcome ??
    (state.transcriptCount === 0 && state.chunksSent > 0
      ? CanaryOutcome.NO_TRANSCRIPTS
      : CanaryOutcome.OK);

  return {
    outcome,
    startedAtMs,
    durationMs: Date.now() - startedAtMs,
    sessionUid,
    error,
    timeToFirstTranscriptMs:
      state.firstTranscriptAtMs !== null && state.firstChunkAtMs !== null
        ? state.firstTranscriptAtMs - state.firstChunkAtMs
        : null,
    transcriptCount: state.transcriptCount,
    chunksSent: state.chunksSent,
    transcriptText,
    accuracy:
      transcriptText.length === 0
        ? null
        : scoreTranscript(config.expectedTranscript, transcriptText),
    repetitionRatio:
      transcriptText.length === 0 ? null : repetitionRatio(transcriptText),
    pipelineMsP50: percentile(pipelineSorted, 0.5),
    pipelineMsP95: percentile(pipelineSorted, 0.95),
    e2eMsP95: percentile(e2eSorted, 0.95),
    clockSyncEstablished: state.e2eMs.length > 0,
    transcriptionServiceConnected: state.transcriptionServiceConnected,
    sourceDeviceConnected: state.sourceDeviceConnected,
    closeCodes: state.closeCodes,
  };
}
