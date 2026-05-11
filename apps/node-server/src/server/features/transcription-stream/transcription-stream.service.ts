import { EventEmitter } from 'eventemitter3';
import type { Static } from 'typebox';

import {
  TRANSCRIPTION_STREAM_SCHEMA,
  TranscriptionStreamServerMessageType,
} from '@scribear/node-server-schema';

import type { AppDependencies } from '#src/server/dependency-injection/app-dependencies.js';

import { AudioFrameChannel } from './events/audio-frame.events.js';
import { SessionEndedChannel } from './events/session-ended.events.js';
import { SessionStatusChannel } from './events/session-status.events.js';
import { TranscriptChannel } from './events/transcript.events.js';
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
}

/**
 * Per-connection business logic for the transcription-stream WebSocket. The
 * class is transport-agnostic and auth-agnostic: the controller is expected
 * to authenticate the caller and pin a role before invoking
 * {@link TranscriptionStreamService.start}.
 *
 * Role-aware behavior is limited to whether the connection should acquire an
 * orchestrator source registration; both roles subscribe to the per-session
 * transcript / status / ended buses identically.
 */
export class TranscriptionStreamService extends EventEmitter<TranscriptionStreamServiceEvents> {
  private _role: TranscriptionStreamRole;
  private _sessionUid: string;
  private _eventBusService: AppDependencies['eventBusService'];
  private _transcriptionOrchestratorService: AppDependencies['transcriptionOrchestratorService'];

  private _unsubscribeTranscripts: (() => void) | null = null;
  private _unsubscribeSessionStatus: (() => void) | null = null;
  private _unsubscribeSessionEnded: (() => void) | null = null;
  private _orchestratorUnregister: (() => void) | null = null;
  private _closed = false;

  constructor(options: TranscriptionStreamServiceOptions) {
    super();
    this._role = options.role;
    this._sessionUid = options.sessionUid;
    this._eventBusService = options.eventBusService;
    this._transcriptionOrchestratorService =
      options.transcriptionOrchestratorService;
  }

  /**
   * Acquire orchestrator resources for source-role connections and subscribe
   * to per-session buses. Throws if the orchestrator is unavailable so the
   * controller can translate that into a 1011 close frame.
   *
   * Does NOT emit any messages. The controller is responsible for sending the
   * auth-success protocol response and then invoking
   * {@link publishCurrentStatus} so the client sees a deterministic initial
   * snapshot after the success message.
   */
  async start(): Promise<void> {
    if (this._role === 'source') {
      const unregister =
        await this._transcriptionOrchestratorService.registerSource(
          this._sessionUid,
        );
      // The connection may have closed while we awaited orchestrator
      // registration; if so, immediately release the registration and bail
      // out before subscribing to the buses.
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
      this._sessionUid,
    );

    this._unsubscribeSessionStatus = this._eventBusService.subscribe(
      SessionStatusChannel,
      (status) => {
        if (this._closed) return;
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
        this.emit('send', {
          type: TranscriptionStreamServerMessageType.SESSION_ENDED,
        });
        this._closeWith(1000, 'session-ended');
      },
      this._sessionUid,
    );
  }

  /**
   * Emit the orchestrator's current session-status snapshot. Called once by
   * the controller right after the auth-success message so the client sees
   * the orchestrator's view of connectivity without waiting for the next
   * transition.
   */
  publishCurrentStatus(): void {
    if (this._closed) return;
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
   * Called by the controller when the underlying socket closes. Releases
   * orchestrator and bus resources held by this connection.
   */
  close(): void {
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
    this._unsubscribeTranscripts?.();
    this._unsubscribeTranscripts = null;
    this._unsubscribeSessionStatus?.();
    this._unsubscribeSessionStatus = null;
    this._unsubscribeSessionEnded?.();
    this._unsubscribeSessionEnded = null;
    this._orchestratorUnregister?.();
    this._orchestratorUnregister = null;
  }
}
