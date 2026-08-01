import { EventEmitter } from 'eventemitter3';
import type { Static } from 'typebox';

import {
  TRANSCRIPTION_STREAM_SCHEMA,
  TranscriptionStreamServerMessageType,
} from '@scribear/node-server-schema';

import type { AppDependencies } from '#src/server/dependency-injection/app-dependencies.js';

import { AudioFrameChannel } from './events/audio-frame.events.js';
import { LatencyChannel } from './events/latency.events.js';
import { SessionEndedChannel } from './events/session-ended.events.js';
import { SessionStatusChannel } from './events/session-status.events.js';
import { TranscriptChannel } from './events/transcript.events.js';
import {
  type ClientHandle,
  SessionAlreadyEndedError,
  type SourceHandle,
} from './transcription-orchestrator.service.js';
import type { TranscriptionStreamRole } from './transcription-stream.auth.js';

type ServerMessage = Static<
  (typeof TRANSCRIPTION_STREAM_SCHEMA)['serverMessage']
>;

export type { TranscriptionStreamRole };

export interface TranscriptionStreamServiceEvents {
  send: (msg: ServerMessage) => void;
  close: (code: number, reason: string) => void;
}

export interface TranscriptionStreamServiceOptions {
  role: TranscriptionStreamRole;
  sessionUid: string;
  eventBusService: AppDependencies['eventBusService'];
  transcriptionOrchestratorService: AppDependencies['transcriptionOrchestratorService'];
  nodeServerMetricsService: AppDependencies['nodeServerMetricsService'];
}

/**
 * Per-connection business logic for the transcription-stream WebSocket. The
 * class is transport-agnostic and auth-agnostic: the controller is expected
 * to authenticate the caller and pin a role before invoking
 * {@link TranscriptionStreamService.start}.
 *
 * Role-aware behavior is limited to whether the connection should acquire an
 * orchestrator source registration; both roles subscribe to the per-session
 * transcript / status / ended buses identically, and both subscribe *before*
 * registering anything, so a session end announced during registration is
 * never missed.
 *
 * Nothing is written to the socket until the controller reports that `authOk`
 * has been sent ({@link TranscriptionStreamService.onAuthAcknowledged}); the
 * service holds the outbound gate shut until then.
 */
export class TranscriptionStreamService extends EventEmitter<TranscriptionStreamServiceEvents> {
  private _role: TranscriptionStreamRole;
  private _sessionUid: string;
  private _eventBusService: AppDependencies['eventBusService'];
  private _transcriptionOrchestratorService: AppDependencies['transcriptionOrchestratorService'];

  private _unsubscribeTranscripts: (() => void) | null = null;
  private _unsubscribeLatency: (() => void) | null = null;
  private _unsubscribeSessionStatus: (() => void) | null = null;
  private _unsubscribeSessionEnded: (() => void) | null = null;
  private _orchestratorHandle: SourceHandle | null = null;
  private _endWatchHandle: ClientHandle | null = null;
  private _closed = false;
  private _metrics: AppDependencies['nodeServerMetricsService'];
  /**
   * Whether this connection is currently counted as a subscriber. Guards the
   * decrement, since `_cleanup` is idempotent and also runs on connections
   * that closed before they ever subscribed.
   */
  private _counted = false;
  /**
   * Whether the controller has sent `authOk`. Until it has, nothing may be
   * written to the socket - see {@link _mayForward}.
   */
  private _ready = false;
  /**
   * An end signal that arrived before `authOk` and so could not be forwarded
   * when it happened. Delivered by {@link onAuthAcknowledged}.
   *
   * This is the whole point of subscribing before registering: `sessionEnded`
   * is terminal and nothing resends it, so a connection that misses its own
   * end signal never learns the session is over.
   */
  private _sessionEndedPending = false;

  constructor(options: TranscriptionStreamServiceOptions) {
    super();
    this._role = options.role;
    this._sessionUid = options.sessionUid;
    this._eventBusService = options.eventBusService;
    this._transcriptionOrchestratorService =
      options.transcriptionOrchestratorService;
    this._metrics = options.nodeServerMetricsService;
  }

  /**
   * Acquire orchestrator resources for source-role connections and subscribe
   * to per-session buses. Throws if the orchestrator is unavailable so the
   * controller can translate that into a 1011 close frame.
   *
   * Does NOT emit any messages. The controller is responsible for sending the
   * auth-success protocol response and then invoking
   * {@link onAuthAcknowledged}, which opens the outbound gate and gives the
   * client a deterministic initial snapshot after the success message.
   */
  async start(): Promise<void> {
    // The socket can be closed before `start()` is ever reached (the peer hung
    // up during auth verification). Bail before subscribing rather than
    // subscribing and immediately tearing it back down.
    if (this._isClosed()) return;

    // Subscribed BEFORE any orchestrator registration, and before the await
    // that registration implies.
    //
    // The event bus is synchronous, and registering a source publishes
    // `sessionEnded` from inside that await whenever the session's config
    // surfaces an `effectiveEnd` that has already passed. Subscribing
    // afterwards meant the publish landed on an empty channel: the source was
    // never told, never closed, and went on streaming audio into a session the
    // server considered over while holding an upstream transcription
    // connection open. The client path below has always been ordered this way
    // for exactly this reason; this is the same rule applied to both roles.
    this._subscribeToSessionBuses();

    // Counted here rather than in the constructor: a connection costs fan-out
    // from the moment it is subscribed, which is now this point rather than
    // after registration. Every exit below runs `_cleanup`, which decrements,
    // so a registration that fails or a socket that closed mid-await nets to
    // zero. Both roles count - receive-only clients are what make a large room
    // expensive (N4), and the orchestrator never sees them.
    this._metrics.recordConnectionOpen(this._sessionUid);
    this._counted = true;

    if (this._role === 'source') {
      let handle: SourceHandle;
      try {
        handle = await this._transcriptionOrchestratorService.registerSource(
          this._sessionUid,
        );
      } catch (err) {
        if (err instanceof SessionAlreadyEndedError) {
          // The session is over, not broken. No registration was created and
          // no upstream was dialed, so there is nothing to release; the
          // connection stays alive just long enough for the controller to
          // send `authOk`, after which `onAuthAcknowledged` sends
          // `sessionEnded` and closes 1000. Deliberately not rethrown: a 1011
          // here would put a kiosk into a reconnect loop against a session
          // that is never coming back.
          this._sessionEndedPending = true;
          return;
        }
        // Genuine orchestrator failure. The controller maps this to 1011 and
        // closes, which calls `close()` - but unsubscribing here as well keeps
        // `start()` self-contained, so the subscriptions it took out cannot
        // outlive it no matter how the caller handles the throw.
        this._cleanup();
        throw err;
      }
      // The connection may have closed while we awaited orchestrator
      // registration; if so, release the registration and drop the
      // subscriptions rather than leaving them attached to a dead socket.
      if (this._isClosed()) {
        handle.unregister();
        this._cleanup();
        return;
      }
      this._orchestratorHandle = handle;
    }

    if (this._role === 'client') {
      // Take out the session's end-watch, so a viewer on a session with no
      // source attached is still told when it ends. Deliberately last: the
      // watch can publish `sessionEnded` the moment it learns the session is
      // already over, and the subscription above has to exist by then for
      // this connection to hear it.
      //
      // `registerClient` is synchronous and does not throw - a viewer must
      // not be disconnected because Session Manager is unreachable - so
      // unlike the source path there is nothing here for the controller to
      // map to a 1011.
      const handle = this._transcriptionOrchestratorService.registerClient(
        this._sessionUid,
      );
      if (this._isClosed()) {
        // Retained as a guard rather than as a live path: a synchronous
        // `sessionEnded` from the watch now latches `_sessionEndedPending`
        // instead of closing (the socket has not seen `authOk` yet), so
        // nothing here should have closed this connection. If some future
        // caller manages it anyway, release the registration rather than
        // leaking it into the ref count.
        handle.unregister();
        this._cleanup();
        return;
      }
      this._endWatchHandle = handle;
    }
  }

  /**
   * Called by the controller immediately after - and only after - it has sent
   * the auth-success message. Two duties, both of which have to happen in this
   * order and nowhere else:
   *
   * 1. Open the outbound gate (see {@link _mayForward}). Nothing may reach the
   *    socket before `authOk`, and the controller is the only thing that knows
   *    when that has been written.
   * 2. Deliver either the end signal that arrived while the gate was shut, or
   *    the orchestrator's current status snapshot, so the client sees the
   *    server's view of connectivity without waiting for the next transition.
   *
   * An already-ended session yields `sessionEnded` + close 1000 instead of a
   * status snapshot: publishing connectivity for a session that is over would
   * tell the client to keep waiting for a source that is never coming.
   */
  onAuthAcknowledged(): void {
    if (this._closed) return;
    this._ready = true;

    if (this._sessionEndedPending) {
      this._sessionEndedPending = false;
      this.emit('send', {
        type: TranscriptionStreamServerMessageType.SESSION_ENDED,
      });
      this._closeWith(1000, 'session-ended');
      return;
    }

    const status = this._transcriptionOrchestratorService.getStatus(
      this._sessionUid,
    );
    this.emit('send', {
      type: TranscriptionStreamServerMessageType.SESSION_STATUS,
      ...status,
    });
  }

  /**
   * Publish a binary audio frame to the per-session audio bus. The controller
   * gates this on role + auth state; the service trusts the caller.
   */
  handleBinary(frame: Buffer): void {
    if (this._closed) return;
    this._eventBusService.publish(AudioFrameChannel, frame, this._sessionUid);
  }

  /**
   * Forward a source-state message (mic active/on/off) to the orchestrator.
   * Only meaningful for source-role connections; client-role connections are
   * ignored. The orchestrator aggregates across sources and publishes a
   * session-status delta so the fleet dashboard can distinguish "mic is off"
   * from "something broke."
   */
  handleSourceState(microphoneActive: boolean): void {
    if (this._closed) return;
    this._orchestratorHandle?.setMicrophoneActive(microphoneActive);
  }

  /**
   * Called by the controller when the underlying socket closes. Releases
   * orchestrator and bus resources held by this connection.
   */
  close(): void {
    this._cleanup();
  }

  /**
   * `_closed` behind a call rather than read directly.
   *
   * TypeScript keeps property narrowing across an `await`, so a plain
   * `if (this._closed) return` early in {@link start} would narrow the field
   * to `false` for every check after the registration await - and those later
   * checks exist precisely because the socket really can close during it.
   * Reading through a method leaves each check honest.
   */
  private _isClosed(): boolean {
    return this._closed;
  }

  /**
   * Whether a bus message may be written to the socket right now.
   *
   * `_ready` is false until the controller has sent `authOk`, and messages
   * that arrive before then are **dropped**, not queued:
   *
   * - Writing anything ahead of `authOk` is a protocol violation. Both the
   *   kiosk and the client webapp hold their WebSocket handshake open until
   *   `authOk` arrives, so a message sent earlier reaches a peer that has not
   *   yet agreed it is connected.
   * - Nothing of value is lost. `sessionStatus` is superseded moments later by
   *   the snapshot {@link onAuthAcknowledged} sends, and transcripts and
   *   latency are live streams with no replay semantics - a connection that
   *   has not finished authenticating has no claim on them. This is also
   *   exactly what happened before these subscriptions moved above
   *   registration: they simply did not exist yet, so the same messages went
   *   nowhere.
   *
   * The one message this must NOT be applied to is `sessionEnded`. It is
   * terminal and nothing resends it, so its handler latches
   * {@link _sessionEndedPending} rather than dropping.
   */
  private _mayForward(): boolean {
    return !this._closed && this._ready;
  }

  /**
   * Subscribe to the four per-session buses this connection fans out to.
   *
   * Extracted so {@link start} can take the subscriptions out before it does
   * anything that can await or publish, and so the pre-`authOk` policy above
   * is stated once for every channel rather than re-decided per handler.
   */
  private _subscribeToSessionBuses(): void {
    this._unsubscribeTranscripts = this._eventBusService.subscribe(
      TranscriptChannel,
      (transcript) => {
        if (!this._mayForward()) return;
        this.emit('send', {
          type: TranscriptionStreamServerMessageType.TRANSCRIPT,
          final: transcript.final,
          inProgress: transcript.inProgress,
        });
      },
      this._sessionUid,
    );

    this._unsubscribeLatency = this._eventBusService.subscribe(
      LatencyChannel,
      (latency) => {
        if (!this._mayForward()) return;
        this.emit('send', {
          type: TranscriptionStreamServerMessageType.LATENCY_UPDATE,
          kind: latency.kind,
          pipelineMs: latency.pipelineMs,
          e2eMs: latency.e2eMs,
        });
      },
      this._sessionUid,
    );

    this._unsubscribeSessionStatus = this._eventBusService.subscribe(
      SessionStatusChannel,
      (status) => {
        if (!this._mayForward()) return;
        this.emit('send', {
          type: TranscriptionStreamServerMessageType.SESSION_STATUS,
          ...status,
        });
      },
      this._sessionUid,
    );

    this._unsubscribeSessionEnded = this._eventBusService.subscribe(
      SessionEndedChannel,
      () => {
        if (this._closed) return;
        if (!this._ready) {
          // Published while this connection was still registering, i.e. before
          // the controller could send `authOk`. Remember it: this is the
          // signal that must never be dropped, and `onAuthAcknowledged`
          // delivers it in protocol order a moment from now.
          this._sessionEndedPending = true;
          return;
        }
        this.emit('send', {
          type: TranscriptionStreamServerMessageType.SESSION_ENDED,
        });
        this._closeWith(1000, 'session-ended');
      },
      this._sessionUid,
    );
  }

  private _closeWith(code: number, reason: string): void {
    if (this._closed) return;
    this._closed = true;
    this.emit('close', code, reason);
    this._cleanup();
  }

  private _cleanup(): void {
    this._closed = true;
    if (this._counted) {
      this._metrics.recordConnectionClose(this._sessionUid);
      this._counted = false;
    }
    this._unsubscribeTranscripts?.();
    this._unsubscribeTranscripts = null;
    this._unsubscribeLatency?.();
    this._unsubscribeLatency = null;
    this._unsubscribeSessionStatus?.();
    this._unsubscribeSessionStatus = null;
    this._unsubscribeSessionEnded?.();
    this._unsubscribeSessionEnded = null;
    this._orchestratorHandle?.unregister();
    this._orchestratorHandle = null;
    this._endWatchHandle?.unregister();
    this._endWatchHandle = null;
  }
}
