import EventEmitter from 'eventemitter3';

import { NetworkError } from '@scribear/base-api-client';
import {
  type WebSocketClient,
  SchemaValidationError as WsSchemaValidationError,
} from '@scribear/base-websocket-client';
import { createNodeServerClient } from '@scribear/node-server-client';
import {
  type SESSION_CLIENT_SCHEMA,
  SessionClientClientMessageType,
  SessionClientServerMessageType,
} from '@scribear/node-server-schema';
import { createSessionManagerClient } from '@scribear/session-manager-client';
import type { TranscriptionSequenceInput } from '@scribear/transcription-content-store';

import { ClientSessionServiceStatus } from './client-session-service-status';

const MIN_RETRY_DELAY_MS = 1_000;
const MAX_RETRY_DELAY_MS = 60_000;
const TOKEN_REFRESH_BUFFER_MS = 2 * 60 * 1_000;

interface SessionStatus {
  transcriptionServiceConnected: boolean;
  sourceDeviceConnected: boolean;
}

/**
 * Events emitted by {@link ClientSessionService} to communicate status changes,
 * transcription output, and session lifecycle to the Redux middleware.
 */
interface ClientSessionServiceEvents {
  statusChange: (status: ClientSessionServiceStatus) => void;
  appendFinalizedTranscription: (sequence: TranscriptionSequenceInput) => void;
  replaceInProgressTranscription: (
    sequence: TranscriptionSequenceInput,
  ) => void;
  sessionStatus: (status: SessionStatus) => void;
  sessionRefreshTokenUpdated: (token: string | null) => void;
  sessionIdUpdated: (sessionId: string | null) => void;
}

/**
 * Service that manages a client's connection to a transcription session.
 * Authenticates via join code, opens a WebSocket to receive transcriptions,
 * and handles token refresh with exponential back-off retries.
 */
export class ClientSessionService extends EventEmitter<ClientSessionServiceEvents> {
  private _status: ClientSessionServiceStatus;

  private _sessionManagerClient;
  private _nodeServerClient;

  private _sessionId: string | null = null;
  private _sessionRefreshToken: string | null = null;
  private _socket: WebSocketClient<typeof SESSION_CLIENT_SCHEMA> | null = null;
  private _refreshTimer: ReturnType<typeof setTimeout> | null = null;

  private _connectionLoopToken = 0;
  private _connectionLoopDelayMs = MIN_RETRY_DELAY_MS;

  constructor() {
    super();
    this._status = ClientSessionServiceStatus.IDLE;

    const baseUrl = window.location.origin;
    this._sessionManagerClient = createSessionManagerClient(baseUrl);
    this._nodeServerClient = createNodeServerClient(baseUrl);
  }

  /** Returns the current service status. */
  get status() {
    return this._status;
  }

  private _setStatus(newStatus: ClientSessionServiceStatus) {
    this._status = newStatus;
    this.emit('statusChange', newStatus);
  }

  private _closeSocket(code?: number, reason?: string) {
    if (this._refreshTimer) {
      clearTimeout(this._refreshTimer);
      this._refreshTimer = null;
    }

    if (!this._socket) return;

    this._socket.removeAllListeners();
    this._socket.close(code, reason);
    this._socket = null;
  }

  private _scheduleTokenRefresh(sessionToken: string) {
    if (this._refreshTimer) {
      clearTimeout(this._refreshTimer);
      this._refreshTimer = null;
    }

    let exp: number;
    try {
      const payload = JSON.parse(atob(sessionToken.split('.')[1] ?? '')) as {
        exp: number;
      };
      exp = payload.exp;
    } catch {
      return;
    }

    const refreshAt = exp * 1000 - TOKEN_REFRESH_BUFFER_MS;
    const delay = Math.max(0, refreshAt - Date.now());

    this._refreshTimer = setTimeout(() => {
      void this._refreshToken();
    }, delay);
  }

  private async _refreshToken() {
    if (!this._sessionRefreshToken || !this._socket) return;

    const [response, error] =
      await this._sessionManagerClient.refreshSessionToken({
        body: { sessionRefreshToken: this._sessionRefreshToken },
      });

    if (error || response.status !== 200) {
      console.error('Token refresh failed, closing session');
      this._closeSocket(1000, 'Token refresh failed');
      this._setStatus(ClientSessionServiceStatus.CONNECTION_ERROR);
      return;
    }

    const { sessionToken } = response.data;

    this._socket.send({
      type: SessionClientClientMessageType.AUTH,
      sessionToken,
    });

    this._scheduleTokenRefresh(sessionToken);
  }

  private async _connect(token: number): Promise<boolean> {
    if (!this._sessionId || !this._sessionRefreshToken) return false;

    this._setStatus(ClientSessionServiceStatus.CONNECTING);
    this._closeSocket(1000);

    // Refresh token to get a fresh session token
    const [refreshResponse, refreshError] =
      await this._sessionManagerClient.refreshSessionToken({
        body: { sessionRefreshToken: this._sessionRefreshToken },
      });

    if (token !== this._connectionLoopToken) return false;

    if (refreshError || refreshResponse.status !== 200) {
      this._setStatus(ClientSessionServiceStatus.CONNECTION_ERROR);

      // 401 means refresh token is invalid — session is over
      if (!refreshError && refreshResponse.status === 401) {
        this.leaveSession();
      }
      return false;
    }

    const { sessionToken } = refreshResponse.data;

    // Open WebSocket connection to node server session client
    const [socket, connectError] = await this._nodeServerClient.sessionClient({
      params: { sessionId: this._sessionId },
    });

    if (token !== this._connectionLoopToken) {
      socket?.close(1000);
      return false;
    }

    if (connectError) {
      this._setStatus(ClientSessionServiceStatus.CONNECTION_ERROR);
      return false;
    }

    this._socket = socket;

    socket.send({
      type: SessionClientClientMessageType.AUTH,
      sessionToken,
    });
    this._scheduleTokenRefresh(sessionToken);

    this._setStatus(ClientSessionServiceStatus.ACTIVE);

    socket.on('message', (message) => {
      if (message.type === SessionClientServerMessageType.FINAL_TRANSCRIPT) {
        this.emit('appendFinalizedTranscription', message);
      } else if (
        message.type === SessionClientServerMessageType.IP_TRANSCRIPT
      ) {
        this.emit('replaceInProgressTranscription', message);
      } else {
        this.emit('sessionStatus', {
          transcriptionServiceConnected: message.transcriptionServiceConnected,
          sourceDeviceConnected: message.sourceDeviceConnected,
        });
      }
    });

    // Await until the socket closes or encounters a terminal error
    const socketDone = new Promise<void>((resolve) => {
      socket.on('close', (code, reason) => {
        console.log(
          'Session connection closed with code:',
          code,
          'reason:',
          reason,
        );
        this._closeSocket();

        if (code === 1000) {
          this.leaveSession();
        } else {
          this._setStatus(ClientSessionServiceStatus.CONNECTION_ERROR);
        }
        resolve();
      });

      socket.on('error', (err) => {
        console.error(err);
        if (err instanceof WsSchemaValidationError) {
          this.leaveSession();
        } else {
          this._setStatus(ClientSessionServiceStatus.CONNECTION_ERROR);
        }
        resolve();
      });
    });

    await socketDone;

    return true;
  }

  private async _executeConnectionLoop(token: number) {
    if (token !== this._connectionLoopToken) return;
    const success = await this._connect(token);
    if (token !== this._connectionLoopToken) return;

    const delayMs = success ? 0 : this._connectionLoopDelayMs;
    this._connectionLoopDelayMs = success
      ? MIN_RETRY_DELAY_MS
      : Math.min(MAX_RETRY_DELAY_MS, this._connectionLoopDelayMs * 2);

    setTimeout(() => {
      void this._executeConnectionLoop(token);
    }, delayMs);
  }

  private _startConnectionLoop() {
    this._connectionLoopDelayMs = MIN_RETRY_DELAY_MS;
    void this._executeConnectionLoop(this._connectionLoopToken);
  }

  private _stopConnectionLoop() {
    this._connectionLoopToken++;
    this._closeSocket(1000);
  }

  /**
   * Authenticates with a join code and starts the session connection loop.
   */
  async joinSession(joinCode: string) {
    this._setStatus(ClientSessionServiceStatus.JOINING);
    this._stopConnectionLoop();

    const [response, error] =
      await this._sessionManagerClient.sessionJoinCodeAuth({
        body: { joinCode },
      });

    if (error instanceof NetworkError) {
      this._setStatus(ClientSessionServiceStatus.JOIN_ERROR);
      return;
    }
    if (error || response.status !== 200) {
      this._setStatus(ClientSessionServiceStatus.JOIN_ERROR);
      return;
    }

    const { sessionToken, sessionRefreshToken } = response.data;

    // Decode session ID from the JWT
    let sessionId: string;
    try {
      const payload = JSON.parse(atob(sessionToken.split('.')[1] ?? '')) as {
        sessionId: string;
      };
      sessionId = payload.sessionId;
    } catch {
      this._setStatus(ClientSessionServiceStatus.JOIN_ERROR);
      return;
    }

    this._sessionId = sessionId;
    this._sessionRefreshToken = sessionRefreshToken;
    this.emit('sessionIdUpdated', sessionId);
    this.emit('sessionRefreshTokenUpdated', sessionRefreshToken);

    this._startConnectionLoop();
  }

  /**
   * Resumes a session using a stored refresh token and session ID.
   */
  resumeSession(sessionId: string, sessionRefreshToken: string) {
    this._stopConnectionLoop();

    this._sessionId = sessionId;
    this._sessionRefreshToken = sessionRefreshToken;

    this._startConnectionLoop();
  }

  /**
   * Disconnects from the current session and resets to idle.
   */
  leaveSession() {
    this._stopConnectionLoop();

    this._sessionId = null;
    this._sessionRefreshToken = null;
    this.emit('sessionIdUpdated', null);
    this.emit('sessionRefreshTokenUpdated', null);

    this._setStatus(ClientSessionServiceStatus.IDLE);
  }
}
