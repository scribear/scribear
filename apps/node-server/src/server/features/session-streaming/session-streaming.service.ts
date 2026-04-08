import { EventEmitter } from 'eventemitter3';

import { SessionTokenScope } from '@scribear/node-server-schema';

import type { AppDependencies } from '#src/server/dependency-injection/register-dependencies.js';

import type {
  SessionStatusEvent,
  TranscriptEvent,
} from './streaming-event-bus.service.js';

const AUTH_TIMEOUT_MS = 1_000;

interface SessionStreamingServiceEvents {
  close: [code: number, reason: string];
  send: [msg: string];
  'ip-transcript': [event: TranscriptEvent];
  'final-transcript': [event: TranscriptEvent];
  'session-status': [event: SessionStatusEvent];
}

/**
 * Manages the lifecycle of a single audio-source or session-client WebSocket connection.
 * Emits typed events for the controller to forward to the socket.
 * Scoped per connection.
 */
export class SessionStreamingService extends EventEmitter<SessionStreamingServiceEvents> {
  private _jwtService: AppDependencies['jwtService'];
  private _eventBus: AppDependencies['streamingEventBusService'];
  private _transcriptionServiceManager: AppDependencies['transcriptionServiceManager'];

  private _authenticated = false;
  private _sendAudioGranted = false;
  private _authTimeout: ReturnType<typeof setTimeout> | null = null;
  private _jwtExpiryTimeout: ReturnType<typeof setTimeout> | null = null;
  private _cleanupFns: (() => void)[] = [];

  constructor(
    jwtService: AppDependencies['jwtService'],
    streamingEventBusService: AppDependencies['streamingEventBusService'],
    transcriptionServiceManager: AppDependencies['transcriptionServiceManager'],
  ) {
    super();
    this._jwtService = jwtService;
    this._eventBus = streamingEventBusService;
    this._transcriptionServiceManager = transcriptionServiceManager;
  }

  /**
   * Starts the authentication deadline for an incoming connection.
   * Emits `close` with code 1008 if auth is not received within AUTH_TIMEOUT_MS.
   */
  startAuthTimeout(): void {
    this._authTimeout = setTimeout(() => {
      if (!this._authenticated) {
        this.emit('close', 1008, 'Authentication timeout');
      }
    }, AUTH_TIMEOUT_MS);
  }

  /**
   * Authenticates an incoming connection against the session token.
   * Supports re-auth: on subsequent calls with the same sessionId, resets the
   * JWT expiry timeout without re-subscribing to events.
   *
   * @param sessionId - The session ID from the URL param.
   * @param sessionToken - The JWT from the AUTH message.
   * @param required - Which scopes must be present in the token for this connection type.
   * @param required.sendAudio - Whether SEND_AUDIO is required.
   * @param required.receiveTranscriptions - Whether RECEIVE_TRANSCRIPTIONS is required.
   */
  handleClientAuth(
    sessionId: string,
    sessionToken: string,
    required: { sendAudio?: boolean; receiveTranscriptions?: boolean },
  ): void {
    if (this._authTimeout) {
      clearTimeout(this._authTimeout);
      this._authTimeout = null;
    }

    const payload = this._jwtService.verifySessionToken(sessionToken);

    if (payload?.sessionId !== sessionId) {
      this.emit('close', 1008, 'Invalid or expired token');
      return;
    }

    const hasSendAudio = payload.scopes.includes(SessionTokenScope.SEND_AUDIO);
    const hasReceiveTranscriptions = payload.scopes.includes(
      SessionTokenScope.RECEIVE_TRANSCRIPTIONS,
    );

    if (required.sendAudio && !hasSendAudio) {
      this.emit('close', 1008, 'Missing required scope: SEND_AUDIO');
      return;
    }
    if (required.receiveTranscriptions && !hasReceiveTranscriptions) {
      this.emit(
        'close',
        1008,
        'Missing required scope: RECEIVE_TRANSCRIPTIONS',
      );
      return;
    }

    // Reset JWT expiry timeout (supports re-auth)
    if (this._jwtExpiryTimeout) {
      clearTimeout(this._jwtExpiryTimeout);
    }
    const msUntilExpiry = payload.exp * 1000 - Date.now();
    this._jwtExpiryTimeout = setTimeout(() => {
      if (this._authenticated) {
        this.emit('close', 1008, 'Session token expired');
      }
    }, msUntilExpiry);

    // First auth: set up subscriptions
    if (!this._authenticated) {
      this._authenticated = true;

      if (hasSendAudio) {
        this._sendAudioGranted = true;
        void this._transcriptionServiceManager.registerSession(sessionId);
      }

      if (hasReceiveTranscriptions) {
        this._subscribeToTranscripts(sessionId);
      }

      this._subscribeToSessionStatus(sessionId);
      this._subscribeToSessionEnd(sessionId);
    }
  }

  /**
   * Forwards a binary audio chunk to the session event bus.
   * Silently ignored if SEND_AUDIO was not granted for this connection.
   *
   * @param sessionId - The session this chunk belongs to.
   * @param chunk - The raw audio data.
   */
  handleAudioChunk(sessionId: string, chunk: Buffer): void {
    if (!this._sendAudioGranted) return;
    this._eventBus.emitAudioChunk(sessionId, chunk);
  }

  /**
   * Cleans up resources when the WebSocket connection closes.
   * Unregisters this client from the transcription service manager if SEND_AUDIO was granted.
   *
   * @param sessionId - The session that disconnected.
   */
  handleClose(sessionId: string): void {
    const hadSendAudio = this._sendAudioGranted;
    this._cleanup();
    if (hadSendAudio) {
      this._transcriptionServiceManager.unregisterSession(sessionId);
    }
  }

  private _subscribeToTranscripts(sessionId: string): void {
    const unsubIp = this._eventBus.onIpTranscript(sessionId, (event) => {
      this.emit('ip-transcript', event);
    });
    const unsubFinal = this._eventBus.onFinalTranscript(sessionId, (event) => {
      this.emit('final-transcript', event);
    });
    this._cleanupFns.push(unsubIp, unsubFinal);
  }

  private _subscribeToSessionStatus(sessionId: string): void {
    const unsubStatus = this._eventBus.onSessionStatus(sessionId, (event) => {
      this.emit('session-status', event);
    });
    this._cleanupFns.push(unsubStatus);
  }

  private _subscribeToSessionEnd(sessionId: string): void {
    const unsubEnd = this._eventBus.onSessionEnd(sessionId, () => {
      this.emit('close', 1000, 'Session ended');
    });
    this._cleanupFns.push(unsubEnd);
  }

  private _cleanup(): void {
    if (this._authTimeout) {
      clearTimeout(this._authTimeout);
      this._authTimeout = null;
    }
    if (this._jwtExpiryTimeout) {
      clearTimeout(this._jwtExpiryTimeout);
      this._jwtExpiryTimeout = null;
    }
    for (const fn of this._cleanupFns) {
      fn();
    }
    this._cleanupFns = [];
  }
}
