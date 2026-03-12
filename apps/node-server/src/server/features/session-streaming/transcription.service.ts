import { createTranscriptionServiceClient } from '@scribear/transcription-service-client';
import {
  type TranscriptionProviderConfig,
  TranscriptionStreamClientMessageType,
  TranscriptionStreamServerMessageType,
} from '@scribear/transcription-service-schema';

import type { AppDependencies } from '#src/server/dependency-injection/register-dependencies.js';

export interface TranscriptionServiceConfig {
  address: string;
  apiKey: string;
}

interface SessionState {
  clientCount: number;
  unsubAudio: (() => void) | null;
  closeConnection: (() => void) | null;
}

/**
 * Manages WebSocket connections to the transcription service, one per session.
 * Routes audio chunks from the event bus to the transcription service and
 * publishes transcription events back to the bus.
 */
export class TranscriptionService {
  private _config: AppDependencies['transcriptionServiceConfig'];
  private _streamingEventBusService: AppDependencies['streamingEventBusService'];
  private _log: AppDependencies['logger'];
  private _sessions = new Map<string, SessionState>();

  constructor(
    logger: AppDependencies['logger'],
    transcriptionServiceConfig: AppDependencies['transcriptionServiceConfig'],
    streamingEventBusService: AppDependencies['streamingEventBusService'],
  ) {
    this._log = logger;
    this._config = transcriptionServiceConfig;
    this._streamingEventBusService = streamingEventBusService;
  }

  /**
   * Records that a client has joined a session.
   *
   * @param sessionId - The session being joined.
   */
  addClient(sessionId: string): void {
    const state = this._sessions.get(sessionId);
    if (state) {
      state.clientCount++;
    } else {
      this._sessions.set(sessionId, {
        clientCount: 1,
        unsubAudio: null,
        closeConnection: null,
      });
    }
  }

  /**
   * Records that a client has left a session.
   * Closes the transcription WS connection when the last client leaves.
   *
   * @param sessionId - The session being left.
   */
  removeClient(sessionId: string): void {
    const state = this._sessions.get(sessionId);
    if (!state) return;

    state.clientCount--;
    if (state.clientCount <= 0) {
      this._cleanupSession(sessionId, state);
    }
  }

  /**
   * Connects to the transcription service for a session and starts relaying
   * audio chunks from the event bus. No-op if already configured for this session.
   *
   * @param sessionId - The session to configure.
   * @param providerKey - The transcription provider to use.
   * @param config - Provider-specific configuration.
   */
  async configureSession(
    sessionId: string,
    providerKey: string,
    config: TranscriptionProviderConfig,
  ): Promise<void> {
    const state = this._sessions.get(sessionId);
    if (state?.unsubAudio) return;

    const client = createTranscriptionServiceClient(this._config.address);
    const [wsClient, err] = await client.transcriptionStream({
      params: { providerKey },
    });

    if (err) {
      this._log.error(
        { err, sessionId },
        'Failed to connect to transcription service',
      );
      throw new Error('Failed to connect to transcription service');
    }

    wsClient.send({
      type: TranscriptionStreamClientMessageType.AUTH,
      api_key: this._config.apiKey,
    });

    wsClient.send({
      type: TranscriptionStreamClientMessageType.CONFIG,
      config,
    });

    const unsubAudio = this._streamingEventBusService.onAudioChunk(
      sessionId,
      (chunk) => {
        wsClient.sendBinary(chunk);
      },
    );

    wsClient.on('message', (msg) => {
      if (msg.type === TranscriptionStreamServerMessageType.IP_TRANSCRIPT) {
        this._streamingEventBusService.emitIpTranscript(sessionId, {
          text: msg.text,
          starts: msg.starts,
          ends: msg.ends,
        });
      } else {
        this._streamingEventBusService.emitFinalTranscript(sessionId, {
          text: msg.text,
          starts: msg.starts,
          ends: msg.ends,
        });
      }
    });

    wsClient.on('close', () => {
      const currentState = this._sessions.get(sessionId);
      if (currentState) {
        this._cleanupSession(sessionId, currentState);
      }
    });

    wsClient.on('error', (err) => {
      this._log.error({ err, sessionId }, 'Transcription service WS error');
    });

    const sessionState = this._sessions.get(sessionId) ?? {
      clientCount: 0,
      unsubAudio: null,
      closeConnection: null,
    };

    sessionState.unsubAudio = unsubAudio;
    sessionState.closeConnection = () => {
      wsClient.close();
    };
    this._sessions.set(sessionId, sessionState);
  }

  private _cleanupSession(sessionId: string, state: SessionState): void {
    state.unsubAudio?.();
    state.closeConnection?.();
    this._sessions.delete(sessionId);
  }
}
