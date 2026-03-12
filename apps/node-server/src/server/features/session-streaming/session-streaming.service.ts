import { EventEmitter } from 'eventemitter3';

import {
  AudioSourceServerMessageType,
  SessionClientServerMessageType,
  SessionTokenScope,
} from '@scribear/node-server-schema';
import type { TranscriptionProviderConfig } from '@scribear/transcription-service-schema';

import type { AppDependencies } from '#src/server/dependency-injection/register-dependencies.js';

const AUTH_TIMEOUT_MS = 10_000;

interface SessionStreamingServiceEvents {
  close: [code: number, reason: string];
  send: [msg: string];
}

/**
 * Manages the lifecycle of a single audio-source or session-client WebSocket connection.
 * Emits `close` and `send` events for the controller to forward to the socket.
 * Scoped per connection — one instance per WebSocket.
 */
export class SessionStreamingService extends EventEmitter<SessionStreamingServiceEvents> {
  private _jwtService: AppDependencies['jwtService'];
  private _eventBus: AppDependencies['streamingEventBusService'];
  private _transcriptionService: AppDependencies['transcriptionService'];

  private _authenticated = false;
  private _sendAudioGranted = false;
  private _authTimeout: ReturnType<typeof setTimeout> | null = null;
  private _cleanupFns: (() => void)[] = [];

  constructor(
    jwtService: AppDependencies['jwtService'],
    streamingEventBusService: AppDependencies['streamingEventBusService'],
    transcriptionService: AppDependencies['transcriptionService'],
  ) {
    super();
    this._jwtService = jwtService;
    this._eventBus = streamingEventBusService;
    this._transcriptionService = transcriptionService;
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
   * Enforces required scopes via flags, then sets up capabilities for any
   * scope present in the token: audio routing for SEND_AUDIO, transcript
   * forwarding for RECEIVE_TRANSCRIPTIONS.
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

    this._authenticated = true;

    if (hasSendAudio) {
      this._sendAudioGranted = true;
      this._transcriptionService.addClient(sessionId);
    }

    if (hasReceiveTranscriptions) {
      const ipType = hasSendAudio
        ? AudioSourceServerMessageType.IP_TRANSCRIPT
        : SessionClientServerMessageType.IP_TRANSCRIPT;
      const finalType = hasSendAudio
        ? AudioSourceServerMessageType.FINAL_TRANSCRIPT
        : SessionClientServerMessageType.FINAL_TRANSCRIPT;

      const unsubIp = this._eventBus.onIpTranscript(sessionId, (event) => {
        this.emit('send', JSON.stringify({ type: ipType, ...event }));
      });
      const unsubFinal = this._eventBus.onFinalTranscript(
        sessionId,
        (event) => {
          this.emit('send', JSON.stringify({ type: finalType, ...event }));
        },
      );
      this._cleanupFns.push(unsubIp, unsubFinal);
    }
  }

  /**
   * Processes a CONFIG message from an audio-source connection.
   * Connects to the transcription service and begins routing audio chunks.
   * Emits `close` with code 1008 if the connection has not yet authenticated.
   *
   * @param sessionId - The session to configure.
   * @param providerKey - The transcription provider to use.
   * @param config - Provider-specific configuration.
   */
  async handleAudioSourceConfig(
    sessionId: string,
    providerKey: string,
    config: TranscriptionProviderConfig,
  ): Promise<void> {
    if (!this._authenticated) {
      this.emit('close', 1008, 'Not authenticated');
      return;
    }

    await this._transcriptionService.configureSession(
      sessionId,
      providerKey,
      config,
    );
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
   * Removes this client from the transcription service if SEND_AUDIO was granted.
   *
   * @param sessionId - The session that disconnected.
   */
  handleClose(sessionId: string): void {
    const hadSendAudio = this._sendAudioGranted;
    this._cleanup();
    if (hadSendAudio) {
      this._transcriptionService.removeClient(sessionId);
    }
  }

  private _cleanup(): void {
    if (this._authTimeout) {
      clearTimeout(this._authTimeout);
      this._authTimeout = null;
    }
    for (const fn of this._cleanupFns) {
      fn();
    }
    this._cleanupFns = [];
  }
}
