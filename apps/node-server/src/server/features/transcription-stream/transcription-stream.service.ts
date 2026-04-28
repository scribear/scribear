import { EventEmitter } from 'eventemitter3';
import type { Static } from 'typebox';

import {
  TRANSCRIPTION_STREAM_SCHEMA,
  TranscriptionStreamServerMessageType,
} from '@scribear/node-server-schema';
import type { SessionScope } from '@scribear/session-manager-schema';

import type { AppDependencies } from '#src/server/dependency-injection/app-dependencies.js';

import { AudioFrameChannel } from './events/audio-frame.events.js';
import { SessionStatusChannel } from './events/session-status.events.js';
import { TranscriptChannel } from './events/transcript.events.js';

type ServerMessage = Static<
  (typeof TRANSCRIPTION_STREAM_SCHEMA)['serverMessage']
>;

export type TranscriptionStreamRole = 'source' | 'client';

export interface TranscriptionStreamServiceEvents {
  send: (msg: ServerMessage) => void;
  close: (code: number, reason: string) => void;
}

const REQUIRED_SCOPE: Record<TranscriptionStreamRole, SessionScope> = {
  source: 'SEND_AUDIO',
  client: 'RECEIVE_TRANSCRIPTIONS',
};

const DEFAULT_AUTH_TIMEOUT_MS = 5000;

export interface TranscriptionStreamServiceOptions {
  role: TranscriptionStreamRole;
  urlSessionUid: string;
  logger: AppDependencies['logger'];
  sessionTokenService: AppDependencies['sessionTokenService'];
  eventBusService: AppDependencies['eventBusService'];
  transcriptionOrchestratorService: AppDependencies['transcriptionOrchestratorService'];
  /** Test seam for the auth handshake watchdog. Defaults to 5s. */
  authTimeoutMs?: number;
}

/**
 * Per-connection behavior for the transcription-stream WebSocket. The class
 * is transport-agnostic: it consumes already-validated client messages, emits
 * `send` (typed server messages) and `close` (close code + reason) for the
 * controller to translate into socket calls.
 *
 * Role-aware:
 * - `source`: requires `SEND_AUDIO`, registers with the orchestrator on
 *   successful auth, forwards binary audio frames to the audio bus.
 * - `client`: requires `RECEIVE_TRANSCRIPTIONS`, never registers with the
 *   orchestrator and rejects binary frames.
 *
 * Both roles subscribe to the transcript bus once authenticated so any
 * connection holding the receive scope sees transcripts as the orchestrator
 * publishes them.
 */
export class TranscriptionStreamService extends EventEmitter<TranscriptionStreamServiceEvents> {
  private _role: TranscriptionStreamRole;
  private _urlSessionUid: string;
  private _logger: AppDependencies['logger'];
  private _sessionTokenService: AppDependencies['sessionTokenService'];
  private _eventBusService: AppDependencies['eventBusService'];
  private _transcriptionOrchestratorService: AppDependencies['transcriptionOrchestratorService'];
  private _authTimeoutMs: number;

  private _authed = false;
  private _authPending = false;
  private _authTimer: ReturnType<typeof setTimeout> | null = null;
  private _unsubscribeTranscripts: (() => void) | null = null;
  private _unsubscribeSessionStatus: (() => void) | null = null;
  private _orchestratorUnregister: (() => void) | null = null;
  private _closed = false;

  constructor(options: TranscriptionStreamServiceOptions) {
    super();
    this._role = options.role;
    this._urlSessionUid = options.urlSessionUid;
    this._logger = options.logger;
    this._sessionTokenService = options.sessionTokenService;
    this._eventBusService = options.eventBusService;
    this._transcriptionOrchestratorService =
      options.transcriptionOrchestratorService;
    this._authTimeoutMs = options.authTimeoutMs ?? DEFAULT_AUTH_TIMEOUT_MS;
  }

  /**
   * Begin the connection lifecycle. Schedules the auth watchdog; the client
   * has `authTimeoutMs` to send its `auth` message before the connection is
   * closed 1008.
   */
  start(): void {
    this._authTimer = setTimeout(() => {
      if (this._authed || this._closed) return;
      this._closeWith(1008, 'auth-timeout');
    }, this._authTimeoutMs);
  }

  /**
   * Authenticate the connection with the given session token. Called by the
   * controller after it has decoded an `auth` client message. Idempotent:
   * after the first successful auth (or while one is in flight), subsequent
   * calls are ignored.
   *
   * @param token Session token issued by Session Manager.
   */
  async handleAuth(token: string): Promise<void> {
    // The controller stops dispatching messages once the socket has closed,
    // so we skip the `_closed` check at the top here - including it would
    // narrow `_closed` to false for the remainder of the method and defeat
    // the post-await race-recovery check below.
    if (this._authed || this._authPending) return;
    this._authPending = true;

    const payload = this._sessionTokenService.verify(token);
    if (payload === null) {
      this._authPending = false;
      this._closeWith(1008, 'invalid-token');
      return;
    }
    if (payload.exp * 1000 < Date.now()) {
      this._authPending = false;
      this._closeWith(1008, 'token-expired');
      return;
    }
    if (payload.sessionUid !== this._urlSessionUid) {
      this._authPending = false;
      this._closeWith(1008, 'session-mismatch');
      return;
    }
    if (!payload.scopes.includes(REQUIRED_SCOPE[this._role])) {
      this._authPending = false;
      this._closeWith(1008, 'missing-scope');
      return;
    }

    if (this._role === 'source') {
      let unregister: () => void;
      try {
        unregister =
          await this._transcriptionOrchestratorService.registerSource(
            this._urlSessionUid,
          );
      } catch (err) {
        this._authPending = false;
        this._logger.error(
          { err, sessionUid: this._urlSessionUid },
          'orchestrator register failed',
        );
        this._closeWith(1011, 'orchestrator-unavailable');
        return;
      }
      // The connection may have closed while we awaited orchestrator
      // registration; if so, immediately release the registration and bail
      // out before subscribing to the transcript bus.
      if (this._closed) {
        unregister();
        return;
      }
      this._orchestratorUnregister = unregister;
    }

    this._unsubscribeTranscripts = this._eventBusService.subscribe(
      TranscriptChannel,
      (transcript) => {
        if (this._closed) return;
        this.emit('send', {
          type: TranscriptionStreamServerMessageType.TRANSCRIPT,
          final: transcript.final,
          inProgress: transcript.inProgress,
        });
      },
      this._urlSessionUid,
    );

    // Subscribe to session-status before reading the initial snapshot so any
    // transition that happens between the two reaches us via the bus rather
    // than being silently lost. The snapshot is then read synchronously in
    // the same tick, so the worst case is one duplicate message - cheap to
    // tolerate, expensive to skip.
    this._unsubscribeSessionStatus = this._eventBusService.subscribe(
      SessionStatusChannel,
      (status) => {
        if (this._closed) return;
        this.emit('send', {
          type: TranscriptionStreamServerMessageType.SESSION_STATUS,
          ...status,
        });
      },
      this._urlSessionUid,
    );

    this._authed = true;
    this._authPending = false;
    if (this._authTimer !== null) {
      clearTimeout(this._authTimer);
      this._authTimer = null;
    }

    this.emit('send', {
      type: TranscriptionStreamServerMessageType.AUTH_OK,
    });

    // Initial snapshot so the client knows current connectivity without
    // waiting for the next transition.
    const initialStatus = this._transcriptionOrchestratorService.getStatus(
      this._urlSessionUid,
    );
    this.emit('send', {
      type: TranscriptionStreamServerMessageType.SESSION_STATUS,
      ...initialStatus,
    });
  }

  /**
   * Handle a binary frame from the client. Audio frames are accepted only
   * after auth completes and only on the `source` role; everything else is a
   * protocol violation that closes 1008.
   */
  handleBinary(frame: Buffer): void {
    if (this._closed) return;
    if (!this._authed) {
      this._closeWith(1008, 'binary-before-auth');
      return;
    }
    if (this._role !== 'source') {
      this._closeWith(1008, 'binary-not-allowed-for-role');
      return;
    }
    this._eventBusService.publish(
      AudioFrameChannel,
      frame,
      this._urlSessionUid,
    );
  }

  /**
   * Called by the controller when the underlying socket closes. Releases
   * orchestrator and bus resources held by this connection.
   */
  handleClose(): void {
    this._cleanup();
  }

  private _closeWith(code: number, reason: string): void {
    if (this._closed) return;
    this._closed = true;
    this.emit('close', code, reason);
    this._cleanup();
  }

  private _cleanup(): void {
    this._closed = true;
    if (this._authTimer !== null) {
      clearTimeout(this._authTimer);
      this._authTimer = null;
    }
    this._unsubscribeTranscripts?.();
    this._unsubscribeTranscripts = null;
    this._unsubscribeSessionStatus?.();
    this._unsubscribeSessionStatus = null;
    this._orchestratorUnregister?.();
    this._orchestratorUnregister = null;
  }
}
