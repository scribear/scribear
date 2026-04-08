import { createRedisSubscriber } from '@scribear/scribear-redis';
import { createSessionManagerClient } from '@scribear/session-manager-client';
import { SESSION_EVENT_CHANNEL } from '@scribear/session-manager-schema';
import { createTranscriptionServiceClient } from '@scribear/transcription-service-client';
import type { TranscriptionProviderConfig } from '@scribear/transcription-service-schema';
import {
  TranscriptionStreamClientMessageType,
  TranscriptionStreamServerMessageType,
} from '@scribear/transcription-service-schema';

import type { AppDependencies } from '#src/server/dependency-injection/register-dependencies.js';

export interface TranscriptionServiceManagerConfig {
  transcriptionServiceAddress: string;
  transcriptionServiceApiKey: string;
  sessionManagerAddress: string;
  nodeServerKey: string;
  redisUrl: string;
}

const GRACE_PERIOD_MS = 30_000;
const MAX_RECONNECT_DELAY_MS = 30_000;
const INITIAL_RECONNECT_DELAY_MS = 1_000;

interface SessionConfig {
  providerKey: string;
  providerConfig: TranscriptionProviderConfig;
  endTimeUnixMs: number | null;
}

interface SessionState {
  clientCount: number;
  config: SessionConfig | null;
  unsubAudio: (() => void) | null;
  closeTranscriptionWs: (() => void) | null;
  unsubRedis: (() => void) | null;
  endTimer: ReturnType<typeof setTimeout> | null;
  graceTimer: ReturnType<typeof setTimeout> | null;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  reconnectAttempt: number;
  transcriptionServiceConnected: boolean;
}

/**
 * Manages transcription service connections per session.
 * Fetches config from session manager, subscribes to Redis for session end,
 * and auto-reconnects to the transcription service with exponential backoff.
 */
export class TranscriptionServiceManager {
  private _log: AppDependencies['logger'];
  private _config: TranscriptionServiceManagerConfig;
  private _streamingEventBusService: AppDependencies['streamingEventBusService'];
  private _sessionManagerClient: ReturnType<typeof createSessionManagerClient>;
  private _redisSubscriber: ReturnType<
    typeof createRedisSubscriber<
      typeof SESSION_EVENT_CHANNEL.schema,
      [sessionId: string]
    >
  >;
  private _sessions = new Map<string, SessionState>();

  constructor(
    logger: AppDependencies['logger'],
    transcriptionServiceManagerConfig: TranscriptionServiceManagerConfig,
    streamingEventBusService: AppDependencies['streamingEventBusService'],
  ) {
    this._log = logger;
    this._config = transcriptionServiceManagerConfig;
    this._streamingEventBusService = streamingEventBusService;
    this._sessionManagerClient = createSessionManagerClient(
      transcriptionServiceManagerConfig.sessionManagerAddress,
    );
    this._redisSubscriber = createRedisSubscriber(
      SESSION_EVENT_CHANNEL,
      transcriptionServiceManagerConfig.redisUrl,
    );
  }

  /**
   * Registers a client for a session. On first client, fetches config,
   * connects to transcription service, and subscribes to Redis for session end.
   */
  async registerSession(sessionId: string): Promise<void> {
    const existing = this._sessions.get(sessionId);
    if (existing) {
      existing.clientCount++;
      if (existing.graceTimer) {
        clearTimeout(existing.graceTimer);
        existing.graceTimer = null;
      }
      return;
    }

    const state: SessionState = {
      clientCount: 1,
      config: null,
      unsubAudio: null,
      closeTranscriptionWs: null,
      unsubRedis: null,
      endTimer: null,
      graceTimer: null,
      reconnectTimer: null,
      reconnectAttempt: 0,
      transcriptionServiceConnected: false,
    };
    this._sessions.set(sessionId, state);

    await this._initializeSession(sessionId, state);
  }

  private async _initializeSession(
    sessionId: string,
    state: SessionState,
  ): Promise<void> {
    try {
      const config = await this._fetchSessionConfig(sessionId);
      if (!this._sessions.has(sessionId)) return;

      state.config = config;
      state.reconnectAttempt = 0;

      if (config.endTimeUnixMs !== null) {
        const delay = config.endTimeUnixMs - Date.now();
        if (delay <= 0) {
          this._endSession(sessionId);
          return;
        }
        state.endTimer = setTimeout(() => {
          this._endSession(sessionId);
        }, delay);
      }

      this._subscribeToRedisSessionEnd(sessionId, state);
      await this._connectTranscriptionService(sessionId, state);
    } catch (err) {
      this._log.error({ err, sessionId }, 'Failed to initialize session');
      this._scheduleReconnect(sessionId, state);
    }
  }

  /**
   * Unregisters a client from a session. Starts a grace period when the
   * last client disconnects; full cleanup occurs after the grace period.
   */
  unregisterSession(sessionId: string): void {
    const state = this._sessions.get(sessionId);
    if (!state) return;

    state.clientCount--;
    if (state.clientCount <= 0) {
      state.graceTimer = setTimeout(() => {
        this._cleanupSession(sessionId, state);
      }, GRACE_PERIOD_MS);
    }
  }

  private async _fetchSessionConfig(sessionId: string): Promise<SessionConfig> {
    const [response, err] = await this._sessionManagerClient.getSessionConfig({
      params: { sessionId },
      headers: { authorization: '' },
    });

    if (err || response.status !== 200) {
      throw new Error(
        `Failed to fetch session config for session ${sessionId}`,
      );
    }

    return {
      providerKey: response.data.transcriptionProviderKey,
      providerConfig: response.data.transcriptionProviderConfig,
      endTimeUnixMs: response.data.endTimeUnixMs,
    };
  }

  private _subscribeToRedisSessionEnd(
    sessionId: string,
    state: SessionState,
  ): void {
    this._redisSubscriber.subscribe(() => {
      this._endSession(sessionId);
    }, sessionId);
    state.unsubRedis = () => {
      this._redisSubscriber.unsubscribe(sessionId);
    };
  }

  private async _connectTranscriptionService(
    sessionId: string,
    state: SessionState,
  ): Promise<void> {
    if (!state.config) return;

    const client = createTranscriptionServiceClient(
      this._config.transcriptionServiceAddress,
    );
    const [wsClient, err] = await client.transcriptionStream({
      params: { providerKey: state.config.providerKey },
    });

    if (err) {
      this._log.error(
        { err, sessionId },
        'Failed to connect to transcription service',
      );
      this._scheduleReconnect(sessionId, state);
      return;
    }

    state.reconnectAttempt = 0;
    state.transcriptionServiceConnected = true;

    wsClient.send({
      type: TranscriptionStreamClientMessageType.AUTH,
      api_key: this._config.transcriptionServiceApiKey,
    });

    wsClient.send({
      type: TranscriptionStreamClientMessageType.CONFIG,
      config: state.config.providerConfig,
    });

    state.unsubAudio = this._streamingEventBusService.onAudioChunk(
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
      if (!currentState) return;

      currentState.transcriptionServiceConnected = false;
      currentState.unsubAudio?.();
      currentState.unsubAudio = null;
      currentState.closeTranscriptionWs = null;

      this._emitSessionStatus(sessionId, currentState);
      this._scheduleReconnect(sessionId, currentState);
    });

    wsClient.on('error', (wsErr) => {
      this._log.error(
        { err: wsErr, sessionId },
        'Transcription service WS error',
      );
    });

    state.closeTranscriptionWs = () => {
      wsClient.close(1000);
    };

    this._emitSessionStatus(sessionId, state);
  }

  private _scheduleReconnect(sessionId: string, state: SessionState): void {
    if (!this._sessions.has(sessionId)) return;

    const delay = Math.min(
      INITIAL_RECONNECT_DELAY_MS * 2 ** state.reconnectAttempt,
      MAX_RECONNECT_DELAY_MS,
    );
    state.reconnectAttempt++;

    this._log.info(
      { sessionId, delay, attempt: state.reconnectAttempt },
      'Scheduling transcription service reconnect',
    );

    state.reconnectTimer = setTimeout(() => {
      state.reconnectTimer = null;
      if (state.config) {
        void this._connectTranscriptionService(sessionId, state);
      } else {
        void this._initializeSession(sessionId, state);
      }
    }, delay);
  }

  private _endSession(sessionId: string): void {
    const state = this._sessions.get(sessionId);
    if (!state) return;

    this._streamingEventBusService.emitSessionEnd(sessionId);
    this._cleanupSession(sessionId, state);
  }

  private _cleanupSession(sessionId: string, state: SessionState): void {
    state.unsubAudio?.();
    state.closeTranscriptionWs?.();
    state.unsubRedis?.();
    if (state.endTimer) clearTimeout(state.endTimer);
    if (state.graceTimer) clearTimeout(state.graceTimer);
    if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
    this._sessions.delete(sessionId);
  }

  private _emitSessionStatus(sessionId: string, state: SessionState): void {
    this._streamingEventBusService.emitSessionStatus(sessionId, {
      transcriptionServiceConnected: state.transcriptionServiceConnected,
      sourceDeviceConnected: state.clientCount > 0,
    });
  }
}
