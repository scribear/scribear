import {
  AudioFrameError,
  decodeAudioFrame,
} from '@scribear/audio-frame-protocol';
import type { LongPollClient } from '@scribear/base-long-poll-client';
import type {
  ConnectionState,
  WebSocketClient,
} from '@scribear/base-websocket-client';
import { LatencyKind } from '@scribear/node-server-schema';
import {
  type SESSION_CONFIG_STREAM_SCHEMA,
  type Session,
} from '@scribear/session-manager-schema';
import {
  TRANSCRIPTION_STREAM_SCHEMA,
  TranscriptionStreamClientMessageType,
} from '@scribear/transcription-service-schema';

import type { AppDependencies } from '#src/server/dependency-injection/app-dependencies.js';
import type { E2eOutcome } from '#src/server/shared/services/node-server-metrics.service.js';

import { AudioFrameChannel } from './events/audio-frame.events.js';
import { FleetStatusDeltaChannel } from './events/fleet-status-delta.events.js';
import { LatencyChannel } from './events/latency.events.js';
import { SessionEndedChannel } from './events/session-ended.events.js';
import {
  SessionStatusChannel,
  type SessionStatusMessage,
} from './events/session-status.events.js';
import { TranscriptChannel } from './events/transcript.events.js';

/**
 * Upper bound on the per-session map of audio frames still awaiting a matching
 * transcript. Chunks that never yield a transcript (e.g. pure silence) would
 * otherwise accumulate forever; when the cap is hit the oldest entry is
 * dropped. Sized generously - at ~10 frames/sec this is minutes of backlog.
 */
const MAX_PENDING_CHUNKS = 2000;

/**
 * A source audio frame awaiting correlation with a transcript.
 * `recvMono` is a monotonic-clock reading (skew-free) used for the pipeline
 * latency; `sentAt` is the source's clock-corrected send time (or null) used
 * for the end-to-end latency.
 */
interface PendingChunk {
  recvMono: number;
  sentAt: number | null;
}

type UpstreamClient = WebSocketClient<typeof TRANSCRIPTION_STREAM_SCHEMA>;
type SessionConfigPoll = LongPollClient<typeof SESSION_CONFIG_STREAM_SCHEMA>;

/**
 * Factory that returns a long-poll client tracking session config for the
 * given sessionUid. Injected so integration tests can swap in a stub that
 * resolves immediately with a fixed `Session`, while production wires this
 * to {@link LongPollClient} pointed at Session Manager's
 * `session-config-stream` endpoint.
 */
export type SessionConfigPollFactory = (
  sessionUid: string,
) => SessionConfigPoll;

/**
 * Live, per-session gauges reported by the status endpoint. Counters live in
 * `NodeServerMetricsService`; these are values only the orchestrator holds.
 */
export interface SessionSnapshot {
  sessionUid: string;
  roomUid: string | null;
  providerKey: string;
  sourceCount: number;
  pendingChunkCount: number;
  upstreamState: ConnectionState;
  upstreamRetryAttempt: number;
}

interface SessionState {
  sourceCount: number;
  /**
   * Provider the upstream was opened against. Read from the session's initial
   * config and kept, rather than re-read from the long-poll on demand, because
   * it is the provider actually in use: a later config change does not move a
   * live upstream (see the note in the `longPoll.on('data')` handler), so the
   * current config and this can legitimately disagree.
   */
  providerKey: string;
  /** Room this session belongs to, if known. Same rationale as `providerKey`. */
  roomUid: string | null;
  upstream: UpstreamClient;
  longPoll: SessionConfigPoll;
  audioUnsubscribe: () => void;
  /**
   * Last published `SessionStatus` snapshot, kept so we can suppress redundant
   * publishes (state changes that don't actually flip either flag) and so
   * `getStatus()` can return a stable view to newly-authenticating
   * connections without recomputing from sub-objects.
   */
  status: SessionStatusMessage;
  /**
   * Audio frames sent upstream but not yet correlated to a transcript, keyed
   * by chunkId in insertion order. Populated as source frames pass through,
   * consumed when the upstream echoes matching `chunk_ids` back, and bounded
   * by {@link MAX_PENDING_CHUNKS}.
   */
  pendingChunks: Map<string, PendingChunk>;
  /**
   * Scheduled timer that publishes `SessionEndedChannel` at the session's
   * `effectiveEnd`. Re-armed on every config update so extensions/contractions
   * are honored. `null` for open-ended sessions (`effectiveEnd === null`).
   */
  endTimer: ReturnType<typeof setTimeout> | null;
  /**
   * Last `effectiveEnd` (epoch ms) we armed `endTimer` for. Used to skip
   * re-arming when an unrelated config bump arrives without changing the end.
   */
  endTimerArmedFor: number | null;
  /**
   * Latches once the orchestrator has published `SessionEndedChannel` for this
   * session. Prevents duplicate publishes if a config change races with the
   * timer or if teardown is already in progress.
   */
  ended: boolean;
}

/**
 * Singleton that owns one upstream transcription connection per active
 * session and bridges audio (in via {@link AudioFrameChannel}) and
 * transcripts (out via {@link TranscriptChannel}).
 *
 * Sticky URL routing pins all connections for a given sessionUid to one
 * Node Server instance, so the singleton state for a session is always
 * co-located with the source connections feeding it.
 *
 * Each session's upstream is opened lazily on the first source registration
 * and torn down when the source-connection ref count drops back to zero.
 * Client (receive-only) connections never call into the orchestrator; they
 * subscribe to {@link TranscriptChannel} directly.
 */
export class TranscriptionOrchestratorService {
  private _sessions = new Map<string, SessionState>();
  /**
   * Status overrides for sessions that have no real upstream - only the
   * demo caption room (see `demo-room/`). Kept separate from
   * `_sessions` so nothing that iterates real session state (e.g.
   * `sessionSnapshots`, which dereferences `state.upstream`) ever sees a
   * session without an upstream connection.
   */
  private _syntheticStatuses = new Map<string, SessionStatusMessage>();
  private _logger: AppDependencies['logger'];
  private _eventBus: AppDependencies['eventBusService'];
  private _transcriptionServiceClient: AppDependencies['transcriptionServiceClient'];
  private _sessionConfigPollFactory: SessionConfigPollFactory;
  private _transcriptionApiKey: string;
  private _metrics: AppDependencies['nodeServerMetricsService'];

  constructor(
    logger: AppDependencies['logger'],
    eventBusService: AppDependencies['eventBusService'],
    transcriptionServiceClient: AppDependencies['transcriptionServiceClient'],
    sessionConfigPollFactory: SessionConfigPollFactory,
    transcriptionServiceClientConfig: AppDependencies['transcriptionServiceClientConfig'],
    nodeServerMetricsService: AppDependencies['nodeServerMetricsService'],
  ) {
    this._logger = logger;
    this._eventBus = eventBusService;
    this._transcriptionServiceClient = transcriptionServiceClient;
    this._sessionConfigPollFactory = sessionConfigPollFactory;
    this._transcriptionApiKey = transcriptionServiceClientConfig.apiKey;
    this._metrics = nodeServerMetricsService;
  }

  /**
   * Register a source connection for a session. The first registration for a
   * session opens the upstream transcription connection and starts tracking
   * config via long-poll; subsequent registrations just bump the ref count.
   *
   * Returns an unregister function the caller MUST invoke when the source
   * connection closes. The upstream is torn down when the count returns to 0.
   */
  async registerSource(sessionUid: string): Promise<() => void> {
    let state = this._sessions.get(sessionUid);
    if (state === undefined) {
      state = await this._openSession(sessionUid);
      this._sessions.set(sessionUid, state);
    }
    state.sourceCount += 1;
    this._setStatus(sessionUid, state);
    return () => {
      this._unregisterSource(sessionUid);
    };
  }

  /**
   * Register a status override for a session with no real upstream. Used only
   * by the demo caption room, which publishes transcripts to
   * {@link TranscriptChannel} directly and needs joining clients to see the
   * session as connected rather than "waiting for source". Ignored for any
   * session that also has real source connections (`_sessions` wins in
   * {@link getStatus}). No-op semantics otherwise.
   */
  registerSyntheticSession(
    sessionUid: string,
    status: SessionStatusMessage,
  ): void {
    this._syntheticStatuses.set(sessionUid, status);
  }

  /**
   * Current connectivity snapshot for a session. Sessions that have never had
   * a source register (or whose last source has unregistered) are reported as
   * fully disconnected.
   *
   * Per-connection services call this once after a successful auth so a newly
   * authenticated client sees the current state without waiting for the next
   * transition.
   */
  getStatus(sessionUid: string): SessionStatusMessage {
    const state = this._sessions.get(sessionUid);
    if (state === undefined) {
      const synthetic = this._syntheticStatuses.get(sessionUid);
      if (synthetic !== undefined) return synthetic;
      return {
        transcriptionServiceConnected: false,
        sourceDeviceConnected: false,
      };
    }
    return state.status;
  }

  /**
   * Number of sessions currently holding open upstream connections. Exposed
   * primarily for readiness checks and tests.
   */
  get activeSessionCount(): number {
    return this._sessions.size;
  }

  /**
   * Point-in-time gauges for each active session, for the status endpoint.
   *
   * Deliberately restates the fields rather than embedding the
   * {@link SessionStatusMessage} that `getStatus` returns: that message is part
   * of the client-facing WebSocket contract, and coupling an operator-facing
   * telemetry schema to it would mean neither could change independently.
   *
   * `limit` is applied here rather than by the caller so a large fleet of
   * sessions never materializes an array we intend to discard. The boolean
   * reports whether it bit.
   *
   * @param limit Maximum number of sessions to return.
   */
  sessionSnapshots(limit: number): {
    sessions: SessionSnapshot[];
    truncated: boolean;
  } {
    const sessions: SessionSnapshot[] = [];
    for (const [sessionUid, state] of this._sessions) {
      if (sessions.length >= limit) break;
      sessions.push({
        sessionUid,
        roomUid: state.roomUid,
        providerKey: state.providerKey,
        sourceCount: state.sourceCount,
        pendingChunkCount: state.pendingChunks.size,
        upstreamState: state.upstream.state,
        upstreamRetryAttempt: state.upstream.attempt,
      });
    }
    return { sessions, truncated: this._sessions.size > sessions.length };
  }

  /**
   * Recompute a session's status from its current state, comparing against
   * the last-published snapshot. Publishes only on transitions so subscribers
   * never see redundant identical messages back-to-back.
   */
  private _setStatus(sessionUid: string, state: SessionState): void {
    const next: SessionStatusMessage = {
      transcriptionServiceConnected: state.upstream.state === 'OPEN',
      sourceDeviceConnected: state.sourceCount > 0,
    };
    if (
      next.transcriptionServiceConnected ===
        state.status.transcriptionServiceConnected &&
      next.sourceDeviceConnected === state.status.sourceDeviceConnected
    ) {
      return;
    }
    state.status = next;
    this._eventBus.publish(SessionStatusChannel, next, sessionUid);
    this._eventBus.publish(FleetStatusDeltaChannel, {
      sessionUid,
      ...next,
      at: Date.now(),
    });
  }

  /**
   * Record an audio frame awaiting correlation, evicting the oldest entry
   * first if the per-session cap is reached.
   */
  private _recordPending(
    sessionUid: string,
    state: SessionState,
    chunkId: string,
    sentAt: number | null,
    recvMono: number,
  ): void {
    if (state.pendingChunks.size >= MAX_PENDING_CHUNKS) {
      const oldest = state.pendingChunks.keys().next().value;
      if (oldest !== undefined) state.pendingChunks.delete(oldest);
      // Sustained eviction means latency correlation is silently degrading:
      // any transcript for an evicted frame can no longer be matched. Warn
      // rather than debug - hitting a 2000-frame cap is not routine.
      this._metrics.recordPendingChunkEviction();
      this._logger.warn(
        { sessionUid, cap: MAX_PENDING_CHUNKS },
        'pending-chunk map at cap; evicting oldest',
      );
    }
    state.pendingChunks.set(chunkId, { recvMono, sentAt });
  }

  /**
   * Correlate a transcript back to the earliest audio frame that produced it
   * and publish a latency sample. `pipelineMs` uses the monotonic clock and is
   * always emitted; `e2eMs` uses the source's clock-corrected `sentAt` and is
   * null when unavailable or implausible (negative, i.e. clock still skewed).
   *
   * On a `final` transcript the matched frame and everything older are
   * finalized, so they are pruned; interim (`inProgress`) samples leave the
   * map intact because those frames are still in the provider's buffer.
   */
  private _emitLatency(
    sessionUid: string,
    state: SessionState,
    kind: LatencyKind,
    chunkIds: string[] | null | undefined,
  ): void {
    if (chunkIds === null || chunkIds === undefined || chunkIds.length === 0) {
      return;
    }
    const id = chunkIds[0];
    if (id === undefined) return;
    const entry = state.pendingChunks.get(id);
    if (entry === undefined) {
      // The frame was evicted at the cap or already pruned by an earlier
      // final. Counted because it is the downstream symptom of N3.
      this._metrics.recordLatencyUnmatchedChunk();
      return;
    }

    const pipelineMs = performance.now() - entry.recvMono;
    let e2eMs: number | null = null;
    let e2eOutcome: E2eOutcome = 'unavailable';
    if (entry.sentAt !== null) {
      const candidate = Date.now() - entry.sentAt;
      // A negative end-to-end time means the source clock is still ahead of
      // ours despite sync; report null rather than a nonsensical number.
      e2eMs = candidate >= 0 ? candidate : null;
      e2eOutcome = candidate >= 0 ? 'ok' : 'negative';
      if (candidate < 0) {
        // Debug, not warn: under real skew this fires on every chunk (S5).
        // The counter carries the rate; this line is for diagnosing one case.
        this._logger.debug(
          { sessionUid, skewMs: candidate },
          'discarding negative end-to-end latency; source clock ahead',
        );
      }
    }
    // Aggregated here rather than in the per-connection stream service: this
    // runs once per correlated transcript, whereas that runs once per
    // subscribed connection and would multiply-count every sample by the room
    // size (B1.4).
    this._metrics.recordLatencySample({
      sessionUid,
      kind,
      pipelineMs,
      e2eMs,
      e2eOutcome,
    });

    this._eventBus.publish(
      LatencyChannel,
      { kind, pipelineMs, e2eMs },
      sessionUid,
    );

    if (kind === LatencyKind.FINAL) {
      for (const [chunkId, pending] of state.pendingChunks) {
        if (pending.recvMono <= entry.recvMono) {
          state.pendingChunks.delete(chunkId);
        }
      }
    }
  }

  private async _openSession(sessionUid: string): Promise<SessionState> {
    const longPoll = this._sessionConfigPollFactory(sessionUid);
    const initial = await this._awaitFirstConfig(longPoll, sessionUid);

    // The config the upstream must be (re)told about on every connection. Held
    // in a mutable box rather than read from `initial` so a reconnect after a
    // config bump replays the CURRENT config, not the one this session opened
    // with. Updated by the long-poll handler below.
    let currentConfig = initial;

    const upstream = this._transcriptionServiceClient.transcriptionStream(
      { params: { providerKey: initial.transcriptionProviderId } },
      {
        // Auth and config belong in the handshake, not in a one-time send after
        // start(). The transcription service closes 1008 "Audio chunk before
        // authentication" on any binary that arrives unauthenticated, and this
        // client reconnects automatically - so sending them once meant that the
        // FIRST upstream blip permanently broke the session: reconnect, forward
        // audio, get closed, repeat forever, with the source still happily
        // streaming and nothing reaching a provider.
        //
        // Running here also fixes the ordering hazard. `onHandshake`'s sender
        // writes straight to the socket while the client is still HANDSHAKING,
        // and the outbound queue is not flushed until it reaches OPEN. Audio
        // buffered during the outage therefore lands strictly after auth and
        // config, instead of racing ahead of them - and it can no longer evict
        // them, which a 64-slot drop-oldest queue at ~10 frames/s otherwise did
        // after ~6.4s of any upstream that was slow to accept (a cold CUDA
        // model load being the obvious one).
        onHandshake: (sender) => {
          sender.send({
            type: TranscriptionStreamClientMessageType.AUTH,
            api_key: this._transcriptionApiKey,
          });
          sender.send({
            type: TranscriptionStreamClientMessageType.CONFIG,
            // Trusted by Session Manager when the session was created; the
            // upstream provider validates its own config schema on receipt.
            config: currentConfig.transcriptionStreamConfig as never,
            session_uid: sessionUid,
            room_uid: currentConfig.roomUid,
          });
          return Promise.resolve();
        },
      },
    );

    const state: SessionState = {
      sourceCount: 0,
      providerKey: initial.transcriptionProviderId,
      roomUid: initial.roomUid,
      upstream,
      longPoll,
      audioUnsubscribe: () => {
        // Replaced below once the audio bus subscription is established.
      },
      status: {
        transcriptionServiceConnected: false,
        sourceDeviceConnected: false,
      },
      pendingChunks: new Map<string, PendingChunk>(),
      endTimer: null,
      endTimerArmedFor: null,
      ended: false,
    };

    upstream.on('message', (msg) => {
      this._eventBus.publish(
        TranscriptChannel,
        { final: msg.final, inProgress: msg.in_progress },
        sessionUid,
      );
      this._emitLatency(
        sessionUid,
        state,
        LatencyKind.FINAL,
        msg.final_chunk_ids,
      );
      this._emitLatency(
        sessionUid,
        state,
        LatencyKind.IN_PROGRESS,
        msg.in_progress_chunk_ids,
      );
    });
    upstream.on('error', (err) => {
      this._logger.error({ err, sessionUid }, 'upstream transcription error');
    });
    // Republish status on every upstream transition. The session is removed
    // from the map before teardown, so terminate-driven state changes don't
    // accidentally re-publish stale state.
    upstream.on('stateChange', (to, from) => {
      if (this._sessions.get(sessionUid) !== state) return;
      this._metrics.recordUpstreamStateChange(from, to);
      // Observability: this is the only externally-visible trace of upstream
      // churn. A healthy session logs this a handful of times (IDLE ->
      // CONNECTING -> HANDSHAKING -> OPEN); a flapping upstream cycles through
      // WAITING_RETRY repeatedly, which is the BUG.txt signature the monitoring
      // sidecar alerts on. Info level so it survives the default LOG_LEVEL.
      this._logger.info(
        { sessionUid, from, to },
        'upstream transcription state change',
      );
      this._setStatus(sessionUid, state);
    });

    // Auth and config are sent by `onHandshake` above, on this connection and
    // on every reconnect after it.
    upstream.start();

    state.audioUnsubscribe = this._eventBus.subscribe(
      AudioFrameChannel,
      (frame) => {
        // Stamp ingress on the monotonic clock before any work, so the
        // pipeline latency excludes our own decode cost.
        const recvMono = performance.now();
        try {
          const decoded = decodeAudioFrame(frame);
          if (decoded.chunkId !== null) {
            this._recordPending(
              sessionUid,
              state,
              decoded.chunkId,
              decoded.sentAt,
              recvMono,
            );
          }
        } catch (err) {
          if (err instanceof AudioFrameError) {
            this._metrics.recordDecodeDrop();
            this._logger.warn(
              { err: err.message, sessionUid },
              'dropping malformed audio frame',
            );
            return;
          }
          throw err;
        }
        // Forward the original SAFP frame unchanged; the transcription service
        // decodes the same envelope to recover the chunkId it echoes back.
        upstream.sendBinary(frame);
      },
      sessionUid,
    );

    longPoll.on('data', (session) => {
      // Keep the handshake's view current, so a reconnect replays this config
      // rather than the one the session opened with.
      currentConfig = session;
      // Future iteration: reconnect the upstream if `transcriptionProviderId`
      // changed, or push a new CONFIG message if only the config did. For
      // now we just log so the long-poll keeps the cursor advancing and we
      // can observe config-bump events in production.
      this._logger.info(
        { sessionUid, version: session.sessionConfigVersion },
        'session config changed',
      );
      this._armEndTimer(sessionUid, state, session);
    });

    this._armEndTimer(sessionUid, state, initial);

    return state;
  }

  /**
   * Arm (or re-arm) the end timer for `state` based on the session's current
   * `effectiveEnd`. Called once on initial config and again on every
   * config-stream update so extensions/contractions are honored. Idempotent
   * when the new end matches the currently-armed end.
   *
   * If `effectiveEnd` is in the past relative to wall clock, the orchestrator
   * publishes `SessionEndedChannel` synchronously rather than scheduling a
   * zero-delay timer, so callers see the end signal as soon as the config
   * surfaces.
   */
  private _armEndTimer(
    sessionUid: string,
    state: SessionState,
    session: Session,
  ): void {
    if (state.ended) return;

    if (session.effectiveEnd === null) {
      // Open-ended: cancel any prior timer (the previous config may have had
      // a finite end) and leave the session running until a future update or
      // until the last source disconnects.
      if (state.endTimer !== null) {
        clearTimeout(state.endTimer);
        state.endTimer = null;
      }
      state.endTimerArmedFor = null;
      return;
    }

    const endMs = Date.parse(session.effectiveEnd);
    if (state.endTimerArmedFor === endMs) return;

    if (state.endTimer !== null) {
      clearTimeout(state.endTimer);
      state.endTimer = null;
    }
    state.endTimerArmedFor = endMs;

    const delayMs = endMs - Date.now();
    if (delayMs <= 0) {
      this._publishSessionEnded(sessionUid, state);
      return;
    }
    state.endTimer = setTimeout(() => {
      state.endTimer = null;
      // The session may have been torn down between scheduling and firing
      // (last source disconnected); the map check guards against a stale
      // publish from such a race.
      if (this._sessions.get(sessionUid) !== state) return;
      this._publishSessionEnded(sessionUid, state);
    }, delayMs);
  }

  private _publishSessionEnded(sessionUid: string, state: SessionState): void {
    if (state.ended) return;
    state.ended = true;
    if (state.endTimer !== null) {
      clearTimeout(state.endTimer);
      state.endTimer = null;
    }
    this._logger.info({ sessionUid }, 'session reached effectiveEnd');
    // Connections subscribed on the bus will send `sessionEnded` and close
    // 1000; their close handlers unregister sources, which drains
    // `_unregisterSource` to zero and tears down upstream + long-poll.
    this._eventBus.publish(SessionEndedChannel, {}, sessionUid);
  }

  private async _awaitFirstConfig(
    longPoll: SessionConfigPoll,
    sessionUid: string,
  ): Promise<Session> {
    return await new Promise<Session>((resolve, reject) => {
      const onData = (session: Session) => {
        longPoll.off('error', onError);
        resolve(session);
      };
      const onError = (err: Error) => {
        longPoll.off('data', onData);
        longPoll.close();
        this._logger.error(
          { err, sessionUid },
          'session-config long-poll error',
        );
        reject(err);
      };
      longPoll.once('data', onData);
      longPoll.once('error', onError);
      longPoll.start();
    });
  }

  private _unregisterSource(sessionUid: string): void {
    const state = this._sessions.get(sessionUid);
    if (state === undefined) return;
    state.sourceCount -= 1;
    if (state.sourceCount > 0) {
      this._setStatus(sessionUid, state);
      return;
    }

    // Drop the session from the map before tearing down so the upstream
    // stateChange listener installed in `_openSession` skips its publish path
    // and we can emit one authoritative final-status message ourselves.
    this._sessions.delete(sessionUid);
    state.audioUnsubscribe();
    state.longPoll.close();
    state.upstream.terminate(1000, 'no-more-sources');
    if (state.endTimer !== null) {
      clearTimeout(state.endTimer);
      state.endTimer = null;
    }

    if (
      state.status.transcriptionServiceConnected ||
      state.status.sourceDeviceConnected
    ) {
      this._eventBus.publish(
        SessionStatusChannel,
        { transcriptionServiceConnected: false, sourceDeviceConnected: false },
        sessionUid,
      );
    }
  }
}
