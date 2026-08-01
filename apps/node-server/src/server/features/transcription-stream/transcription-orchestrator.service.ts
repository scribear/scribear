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
  TranscriptionServiceDisconnectReason,
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
  /**
   * Binary frames received from the source since the session opened, counted
   * before decode (so a malformed frame still counts as "the source is sending
   * something"; the malformed subset is tracked by `decodeDropsTotal`).
   * Monotonic per session (resets when `SessionState` is destroyed). The fleet
   * dashboard uses this to distinguish "source sent nothing" (0) from "source
   * is sending but the ASR is silent" (>0) — the ambiguity that made the
   * original "no audio arriving" report a blind guess.
   */
  audioFramesReceived: number;
  /**
   * `true` if any connected source reports its mic active, `false` if every
   * source that has reported says otherwise, `null` if none has reported. The
   * third case is not the same as "off" and must stay distinguishable: an
   * older kiosk never sends the message at all.
   */
  sourceMicrophoneActive: boolean | null;
}

/**
 * Handle returned by {@link TranscriptionOrchestratorService.registerSource}.
 * The caller MUST call `unregister` when the source connection closes. The
 * caller SHOULD call `setMicrophoneActive` when the source's mic state
 * changes (and once after auth to seed it).
 */
export interface SourceHandle {
  unregister: () => void;
  setMicrophoneActive: (active: boolean) => void;
}

/**
 * Handle returned by {@link TranscriptionOrchestratorService.registerClient}.
 * The caller MUST call `unregister` when the client connection closes, so the
 * session's end-watch is torn down once the last viewer leaves.
 */
export interface ClientHandle {
  unregister: () => void;
}

/**
 * Anything that may own the timer that publishes `SessionEndedChannel` for a
 * session: the real {@link SessionState}, or a source-free
 * {@link SessionEndWatch}. Named so {@link
 * TranscriptionOrchestratorService._publishSessionEnded} can latch every
 * owner a session has, which is what makes "exactly one publish per session
 * end" hold across both paths.
 */
interface EndTimerOwner {
  /**
   * Scheduled timer that publishes `SessionEndedChannel` at the session's
   * `effectiveEnd`. Re-armed on every config update so extensions and
   * contractions are honored. `null` for open-ended sessions
   * (`effectiveEnd === null`) and while the owner is disarmed.
   */
  endTimer: ReturnType<typeof setTimeout> | null;
  /**
   * Last `effectiveEnd` (epoch ms) this owner armed `endTimer` for. Used to
   * skip re-arming when an unrelated config bump arrives without moving the
   * end. `null` when nothing is armed.
   */
  endTimerArmedFor: number | null;
  /**
   * Latches once `SessionEndedChannel` has been published for this session.
   * Prevents a duplicate publish if a config change races with the timer, if
   * teardown is already in progress, or if the session's other end-timer
   * owner reaches the end at the same moment.
   */
  ended: boolean;
}

/**
 * Maps an upstream WebSocket close code onto the reason a viewer is told, or
 * `undefined` when the close carries no information worth distinguishing
 * (1006, 1011, a clean 1000 during teardown...). Only the two codes the
 * transcription service chooses *deliberately* are named here; everything else
 * stays undistinguished, exactly as before this mapping existed.
 */
function closeCodeToDisconnectReason(
  code: number | null,
): TranscriptionServiceDisconnectReason | undefined {
  if (code === 1013) return TranscriptionServiceDisconnectReason.AT_CAPACITY;
  if (code === 1007) {
    return TranscriptionServiceDisconnectReason.INVALID_REQUEST;
  }
  return undefined;
}

interface SessionState extends EndTimerOwner {
  sourceCount: number;
  /** Monotonic counter for per-source IDs within this session. */
  nextSourceId: number;
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
  /**
   * Binary frames received from the source since the session opened.
   * Incremented in the `AudioFrameChannel` callback before decode, so a
   * malformed frame still counts as "received" (the source is sending
   * *something*) — `recordDecodeDrop` already tracks the malformed subset.
   * Monotonic per session; reset to 0 when `SessionState` is created.
   */
  audioFramesReceived: number;
  /**
   * Per-source microphone state, keyed by a source ID assigned at
   * registration. `true` = mic active (unmuted), `false` = mic off.
   * Absent = source has not reported yet. The aggregate
   * `sourceMicrophoneActive` is computed in `_setStatus` as "any source
   * reports true", or `null` when no source has reported.
   */
  sourceMicStates: Map<number, boolean | undefined>;
  upstream: UpstreamClient;
  /**
   * Close code from the upstream's most recent `close` event, or `null` if it
   * has never closed. Recorded so `_setStatus` can distinguish the closes the
   * transcription service chooses deliberately - a capacity refusal (1013) and
   * a rejected request (1007) - from any other disconnect ("service
   * crashed"-shaped disconnects included) - see
   * `archived-plans/2026-07-27-02-PLAN-AdmissionControl.md` §4. Stale values
   * are harmless: `_setStatus` only consults this while
   * `upstream.state !== 'OPEN'`, and it is overwritten on every subsequent
   * close.
   */
  lastUpstreamCloseCode: number | null;
  /** Close reason string paired with {@link lastUpstreamCloseCode}. */
  lastUpstreamCloseReason: string | null;
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
}

/**
 * A source-free watch on a session's end, held on behalf of client
 * (receive-only) connections.
 *
 * It is a session-config long-poll and a timer, and nothing else - in
 * particular it opens NO upstream transcription connection. A viewer must cost
 * the transcription service zero resources: audio-less connections registering
 * a job and consuming admission capacity is the exact fault `e80eea2` was
 * written for.
 *
 * Kept in its own map rather than as a `SessionState` with a null upstream so
 * that everything which iterates real session state (`sessionSnapshots`,
 * `_setStatus`, `getStatus`) keeps its existing guarantee that a session in
 * `_sessions` always has an upstream - the same reason `_syntheticStatuses` is
 * separate.
 */
interface SessionEndWatch extends EndTimerOwner {
  /** Number of client-role connections sharing this watch. */
  clientCount: number;
  longPoll: SessionConfigPoll;
  /**
   * Most recent config the long-poll delivered, or `null` before the first
   * response. Retained so the watch can re-arm itself from the current
   * `effectiveEnd` when a source's `SessionState` is torn down under it,
   * without waiting for the next config bump.
   */
  lastSession: Session | null;
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
 * Client (receive-only) connections take out an *end-watch* instead
 * ({@link registerClient}): a config long-poll and a timer, no upstream, so a
 * room full of viewers with no source attached still learns when the session
 * ends without costing the transcription service anything.
 */
export class TranscriptionOrchestratorService {
  private _sessions = new Map<string, SessionState>();
  /**
   * Source-free end-watches, keyed by sessionUid, one per session with at
   * least one client-role connection. Deliberately not merged into
   * `_sessions`: see the note on {@link SessionEndWatch}.
   */
  private _endWatches = new Map<string, SessionEndWatch>();
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
   * Returns a {@link SourceHandle} whose `unregister` the caller MUST invoke
   * when the source connection closes, and whose `setMicrophoneActive` the
   * caller SHOULD invoke to report mic state. The upstream is torn down when
   * the count returns to 0.
   */
  async registerSource(sessionUid: string): Promise<SourceHandle> {
    let state = this._sessions.get(sessionUid);
    if (state === undefined) {
      state = await this._openSession(sessionUid);
      this._sessions.set(sessionUid, state);
    }
    // A real session is the authoritative end-timer owner while it exists, so
    // any end-watch a viewer opened before the source arrived stands down now
    // rather than racing this session's own timer. `_unregisterSource` hands
    // the watch its timer back when this state is torn down.
    const watch = this._endWatches.get(sessionUid);
    if (watch !== undefined) this._disarmEndWatch(watch);

    const sourceId = state.nextSourceId++;
    state.sourceCount += 1;
    state.sourceMicStates.set(sourceId, undefined);
    this._setStatus(sessionUid, state);
    return {
      unregister: () => {
        this._unregisterSource(sessionUid, sourceId);
      },
      setMicrophoneActive: (active: boolean) => {
        this._setSourceMicrophone(sessionUid, sourceId, active);
      },
    };
  }

  /**
   * Register a client (receive-only) connection for a session. The first
   * registration opens an {@link SessionEndWatch}; subsequent ones just bump
   * the ref count, and the watch is torn down when the last client-role
   * connection for the session disconnects.
   *
   * The watch exists so a viewer on a session with **no source attached**
   * still learns the session ended on time. Without it nothing fetches that
   * session's config at all, so `SessionEndedChannel` is never published and
   * the viewer sits on stale captions until its next token refresh happens to
   * be rejected - up to half the token lifetime.
   *
   * Synchronous and infallible on purpose, unlike {@link registerSource}:
   *
   * - Synchronous, so a viewer's `authOk` is never made to wait on Session
   *   Manager. The watch arms itself when the long-poll's first response
   *   arrives.
   * - Infallible, so a config fetch that fails cannot disconnect someone who
   *   is happily receiving captions. A source that cannot reach Session
   *   Manager is useless and rightly gets 1011; a viewer that cannot is only
   *   missing its end signal, which degrades to the pre-end-watch behaviour.
   */
  registerClient(sessionUid: string): ClientHandle {
    const existing = this._endWatches.get(sessionUid);
    if (existing !== undefined) {
      existing.clientCount += 1;
    } else if (!this._startEndWatch(sessionUid)) {
      // Degraded, not fatal - see the doc comment above.
      return { unregister: () => undefined };
    }

    // Guarded rather than bare like `SourceHandle.unregister`, which is keyed
    // by a per-source id: this one only has a count to decrement, and a
    // double release would drop the watch out from under the viewers still on
    // it.
    let released = false;
    return {
      unregister: () => {
        if (released) return;
        released = true;
        this._unregisterClient(sessionUid);
      },
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
        sourceMicrophoneActive: null,
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
        audioFramesReceived: state.audioFramesReceived,
        sourceMicrophoneActive: this._aggregateMicState(state),
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
    const connected = state.upstream.state === 'OPEN';
    // Only meaningful while disconnected; a reconnect that reaches OPEN
    // clears it implicitly via `connected`, without needing to reset the
    // stored close code. See the field doc on `lastUpstreamCloseCode`.
    //
    // Omitted (not set to `undefined`) when not applicable:
    // `exactOptionalPropertyTypes` treats an explicit `undefined` on an
    // optional TypeBox-derived property as a type error, not "absent".
    //
    // 1007 is the other close the upstream makes on purpose: it rejected our
    // request as unacceptable (a `transcriptionProviderId` absent from the
    // deployment's `provider_config.json` raises "Invalid Provider Key", which
    // the transcription service maps to 1007). Unlike 1013 that is permanent -
    // the retry loop re-sends the identical config and is refused identically,
    // forever - so it gets its own reason rather than being collapsed into the
    // undistinguished "disconnected" that reads to a viewer as a transient
    // blip.
    const disconnectReason = !connected
      ? closeCodeToDisconnectReason(state.lastUpstreamCloseCode)
      : undefined;
    const next: SessionStatusMessage = {
      transcriptionServiceConnected: connected,
      sourceDeviceConnected: state.sourceCount > 0,
      sourceMicrophoneActive: this._aggregateMicState(state),
      ...(disconnectReason !== undefined && {
        transcriptionServiceDisconnectReason: disconnectReason,
      }),
    };
    if (
      next.transcriptionServiceConnected ===
        state.status.transcriptionServiceConnected &&
      next.sourceDeviceConnected === state.status.sourceDeviceConnected &&
      next.sourceMicrophoneActive === state.status.sourceMicrophoneActive &&
      next.transcriptionServiceDisconnectReason ===
        state.status.transcriptionServiceDisconnectReason
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
   * Computes the aggregate mic state: `true` if any source reports mic
   * active, `false` if all sources report mic off, `null` if no source has
   * reported yet. A disconnected source is removed from the map by
   * `_unregisterSource`, so stale entries don't influence the aggregate.
   */
  private _aggregateMicState(state: SessionState): boolean | null {
    if (state.sourceMicStates.size === 0) return null;
    let anyReported = false;
    for (const micState of state.sourceMicStates.values()) {
      if (micState === true) return true;
      if (micState === false) anyReported = true;
    }
    return anyReported ? false : null;
  }

  /**
   * Update one source's mic state and recompute the aggregate. Called by the
   * `SourceHandle.setMicrophoneActive` closure.
   */
  private _setSourceMicrophone(
    sessionUid: string,
    sourceId: number,
    active: boolean,
  ): void {
    const state = this._sessions.get(sessionUid);
    if (state === undefined) return;
    if (!state.sourceMicStates.has(sourceId)) return;
    state.sourceMicStates.set(sourceId, active);
    this._setStatus(sessionUid, state);
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
      nextSourceId: 0,
      providerKey: initial.transcriptionProviderId,
      roomUid: initial.roomUid,
      audioFramesReceived: 0,
      sourceMicStates: new Map(),
      upstream,
      lastUpstreamCloseCode: null,
      lastUpstreamCloseReason: null,
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
    // Record the close code/reason so `_setStatus` can tell a capacity
    // refusal (1013) apart from any other disconnect - see
    // `archived-plans/2026-07-27-02-PLAN-AdmissionControl.md` §4. This fires
    // AFTER the `stateChange` this
    // same close triggers (the client emits `close` last in `_handleClose`),
    // so the `stateChange` listener's `_setStatus` call above still sees the
    // previous close code; publish again here once the new one is recorded.
    upstream.on('close', (code, reason) => {
      if (this._sessions.get(sessionUid) !== state) return;
      state.lastUpstreamCloseCode = code;
      state.lastUpstreamCloseReason = reason;
      this._setStatus(sessionUid, state);
    });

    // Auth and config are sent by `onHandshake` above, on this connection and
    // on every reconnect after it.
    upstream.start();

    state.audioUnsubscribe = this._eventBus.subscribe(
      AudioFrameChannel,
      (frame) => {
        // Count every frame the source sent — before decode, so a malformed
        // frame still registers as "the source is sending something." The
        // malformed subset is tracked separately by recordDecodeDrop.
        state.audioFramesReceived += 1;
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

  /**
   * Start a source-free end-watch for `sessionUid` on behalf of its first
   * client connection: a session-config long-poll and nothing else. Returns
   * `false` if it could not be started, which the caller degrades rather than
   * propagates.
   *
   * The long-poll is the same one `_openSession` uses, deliberately: a
   * session's `effectiveEnd` moves (`startSessionEarly` / `endSessionEarly`
   * bump `sessionConfigVersion`), so the watch has to follow config rather
   * than read the end once. `endSessionEarly` sets `end_override = now`, which
   * arrives here as an already-past end and publishes immediately.
   *
   * The watch is registered and counted BEFORE the poll is started, so a
   * response that arrives synchronously finds it in `_endWatches` and a
   * publish it triggers has a ref count to release.
   */
  private _startEndWatch(sessionUid: string): boolean {
    let watch: SessionEndWatch;
    try {
      watch = {
        clientCount: 1,
        longPoll: this._sessionConfigPollFactory(sessionUid),
        lastSession: null,
        endTimer: null,
        endTimerArmedFor: null,
        ended: false,
      };
    } catch (err) {
      this._logger.error(
        { err, sessionUid },
        'failed to create session end-watch; viewers will not be told when this session ends',
      );
      return false;
    }

    watch.longPoll.on('data', (session) => {
      // Ignore a response that arrives after this watch was torn down or
      // replaced, mirroring the stale-publish guards on `_sessions`.
      if (this._endWatches.get(sessionUid) !== watch) return;
      watch.lastSession = session;
      this._armEndWatch(sessionUid, watch);
    });
    watch.longPoll.on('error', (err) => {
      // Not terminal: `LongPollClient` retries with backoff on its own, and
      // this must never reach the viewer's socket. Warn rather than error -
      // an unreachable Session Manager costs a viewer only its end signal.
      this._logger.warn(
        { err, sessionUid },
        'session-config long-poll error on end-watch',
      );
    });

    this._endWatches.set(sessionUid, watch);
    try {
      watch.longPoll.start();
    } catch (err) {
      this._endWatches.delete(sessionUid);
      this._logger.error(
        { err, sessionUid },
        'failed to start session end-watch; viewers will not be told when this session ends',
      );
      return false;
    }
    return true;
  }

  /**
   * Arm (or re-arm) an end-watch's timer from the config it last saw. Called
   * on every config-stream response, and again by `_unregisterSource` when a
   * session's own state is torn down under the watch.
   *
   * The watch defers to a live {@link SessionState}: that state already arms a
   * timer off the same `effectiveEnd`, so while it exists the watch holds no
   * timer at all and this is where that is enforced. There is therefore never
   * more than one armed timer per session.
   */
  private _armEndWatch(sessionUid: string, watch: SessionEndWatch): void {
    if (watch.ended) return;
    const session = watch.lastSession;
    if (session === null) return;

    const state = this._sessions.get(sessionUid);
    if (state !== undefined && !state.ended) {
      this._disarmEndWatch(watch);
      return;
    }

    if (session.effectiveEnd === null) {
      // Open-ended: cancel any prior timer (a previous config may have had a
      // finite end) and wait for the next config update.
      this._disarmEndWatch(watch);
      return;
    }

    const endMs = Date.parse(session.effectiveEnd);
    if (watch.endTimerArmedFor === endMs) return;

    if (watch.endTimer !== null) {
      clearTimeout(watch.endTimer);
      watch.endTimer = null;
    }
    watch.endTimerArmedFor = endMs;

    const delayMs = endMs - Date.now();
    if (delayMs <= 0) {
      // Already over - a viewer joining an ended session, or an
      // `endSessionEarly` that moved the end into the past. Publish now
      // rather than scheduling a zero-delay timer, exactly as `_armEndTimer`
      // does, so the viewer is not left hanging.
      this._publishSessionEnded(sessionUid, watch);
      return;
    }
    watch.endTimer = setTimeout(() => {
      watch.endTimer = null;
      // The watch may have been torn down between scheduling and firing (last
      // viewer disconnected); the map check guards a stale publish.
      if (this._endWatches.get(sessionUid) !== watch) return;
      this._publishSessionEnded(sessionUid, watch);
    }, delayMs);
  }

  /** Cancel an end-watch's timer, leaving it able to re-arm on a later config. */
  private _disarmEndWatch(watch: SessionEndWatch): void {
    if (watch.endTimer !== null) {
      clearTimeout(watch.endTimer);
      watch.endTimer = null;
    }
    watch.endTimerArmedFor = null;
  }

  private _unregisterClient(sessionUid: string): void {
    const watch = this._endWatches.get(sessionUid);
    if (watch === undefined) return;
    watch.clientCount -= 1;
    if (watch.clientCount > 0) return;

    this._endWatches.delete(sessionUid);
    this._disarmEndWatch(watch);
    watch.longPoll.close();
  }

  /**
   * Publish `SessionEndedChannel` for a session, at most once per end.
   *
   * A session can have two end-timer owners over its lifetime - the
   * {@link SessionState} a source opens and the {@link SessionEndWatch} its
   * viewers hold - and only one of them is ever armed at a time
   * (`_armEndWatch` stands the watch down while a live state exists). This
   * latches *both* regardless, so the loser of any race cannot publish a
   * second time: in particular the source-side teardown that follows a
   * publish deletes the state and calls back into `_armEndWatch`, which must
   * find the watch already latched rather than re-arm it for an end that has
   * just passed.
   *
   * `initiator` is passed rather than looked up because `_openSession` arms
   * the session's timer before `registerSource` inserts the state into
   * `_sessions`; a lookup would miss it and leave that state unlatched.
   */
  private _publishSessionEnded(
    sessionUid: string,
    initiator: EndTimerOwner,
  ): void {
    if (initiator.ended) return;
    this._latchEnded(initiator);

    const state = this._sessions.get(sessionUid);
    if (state !== undefined && state !== initiator) this._latchEnded(state);
    const watch = this._endWatches.get(sessionUid);
    if (watch !== undefined && watch !== initiator) this._latchEnded(watch);

    this._logger.info({ sessionUid }, 'session reached effectiveEnd');
    // Connections subscribed on the bus will send `sessionEnded` and close
    // 1000; their close handlers unregister sources and client end-watch
    // registrations, which drains `_unregisterSource` / `_unregisterClient` to
    // zero and tears down upstream + long-poll(s).
    this._eventBus.publish(SessionEndedChannel, {}, sessionUid);
  }

  /** Mark an end-timer owner as having published, and cancel its timer. */
  private _latchEnded(owner: EndTimerOwner): void {
    owner.ended = true;
    if (owner.endTimer !== null) {
      clearTimeout(owner.endTimer);
      owner.endTimer = null;
    }
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

  private _unregisterSource(sessionUid: string, sourceId: number): void {
    const state = this._sessions.get(sessionUid);
    if (state === undefined) return;
    state.sourceCount -= 1;
    state.sourceMicStates.delete(sourceId);
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

    // Viewers outlive the source routinely (the kiosk is unplugged, the room
    // keeps watching). This state was the session's end-timer owner and has
    // just gone, so hand the job back to the end-watch if one is held. A
    // no-op when the state got here by publishing `sessionEnded`, since that
    // latched the watch too.
    const watch = this._endWatches.get(sessionUid);
    if (watch !== undefined) this._armEndWatch(sessionUid, watch);

    if (
      state.status.transcriptionServiceConnected ||
      state.status.sourceDeviceConnected
    ) {
      this._eventBus.publish(
        SessionStatusChannel,
        {
          transcriptionServiceConnected: false,
          sourceDeviceConnected: false,
          // `null`, not `false`: the last source has gone, so the mic state is
          // unknown rather than known-off. Reporting `false` here would put
          // "mic off" on a session that has no source at all - which is the
          // same species of misleading readout this field exists to remove,
          // and would disagree with `getStatus()`, which already answers
          // `null` for a session it holds no state for.
          sourceMicrophoneActive: null,
        },
        sessionUid,
      );
    }
  }
}
