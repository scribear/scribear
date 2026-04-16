import EventEmitter from 'eventemitter3';

import { NetworkError } from '@scribear/base-api-client';
import {
  type WebSocketClient,
  SchemaValidationError as WsSchemaValidationError,
} from '@scribear/base-websocket-client';
import type {
  AudioStream,
  MicrophoneService,
} from '@scribear/microphone-store';
import { createNodeServerClient } from '@scribear/node-server-client';
import {
  type AUDIO_SOURCE_SCHEMA,
  AudioSourceClientMessageType,
  AudioSourceServerMessageType,
} from '@scribear/node-server-schema';
import { createSessionManagerClient } from '@scribear/session-manager-client';
import { DeviceSessionEventType } from '@scribear/session-manager-schema';
import type { TranscriptionSequenceInput } from '@scribear/transcription-content-store';

import { RoomServiceStatus } from './room-service-status';

const MIN_RETRY_DELAY_MS = 1_000;
const MAX_RETRY_DELAY_MS = 60_000;
const TOKEN_REFRESH_BUFFER_MS = 2 * 60 * 1_000;
const JOIN_CODE_REFRESH_BUFFER_MS = 30 * 1_000;

interface SessionStatus {
  transcriptionServiceConnected: boolean;
  sourceDeviceConnected: boolean;
}

/**
 * Events emitted by {@link RoomService} to communicate status changes,
 * transcription output, and device/session lifecycle to the Redux middleware.
 */
interface TranscriptEvent {
  final: TranscriptionSequenceInput | null;
  inProgress: TranscriptionSequenceInput | null;
}

export interface UpcomingSession {
  sessionId: string;
  startTime: number;
  endTime: number | null;
  isActive: boolean;
}

interface RoomServiceEvents {
  statusChange: (status: RoomServiceStatus) => void;
  transcript: (event: TranscriptEvent) => void;
  sessionStarted: (sessionId: string) => void;
  sessionEnded: () => void;
  sessionStatus: (status: SessionStatus) => void;
  deviceRegistered: (deviceName: string, deviceId: string) => void;
  deviceUnregistered: () => void;
  prevEventIdUpdated: (eventId: number) => void;
  sessionRefreshTokenUpdated: (token: string | null) => void;
  joinCodeUpdated: (
    data: { joinCode: string; expiresAtUnixMs: number } | null,
  ) => void;
  upcomingSessionsUpdated: (sessions: UpcomingSession[]) => void;
}

/**
 * Core service that manages the room device's connection to ScribeAR.
 * Runs an event-polling loop against the session manager to detect when a
 * session starts or ends, then opens a WebSocket audio-source connection to
 * the node server and streams microphone audio for transcription. Handles
 * exponential back-off retries for both the event and session loops.
 *
 * Unlike KioskService, muting is communicated to the server via HTTP rather
 * than just a local flag. Also polls for upcoming sessions every 30 seconds.
 */
export class RoomService extends EventEmitter<RoomServiceEvents> {
  private _status: RoomServiceStatus;

  private _microphoneService;
  private _sessionManagerClient;
  private _nodeServerClient;

  private _prevEventId = -1;
  private _sessionToken: string | null = null;

  private _stream: AudioStream | null = null;
  private _socket: WebSocketClient<typeof AUDIO_SOURCE_SCHEMA> | null = null;
  private _sessionRefreshToken: string | null = null;
  private _storedSessionRefreshToken: string | null = null;
  private _refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private _joinCodeRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  private _upcomingSessionsInterval: ReturnType<typeof setInterval> | null =
    null;

  private _eventLoopToken = 0;
  private _eventLoopDelayMs = MIN_RETRY_DELAY_MS;

  private _sessionLoopToken = 0;
  private _sessionLoopDelayMs = MIN_RETRY_DELAY_MS;

  constructor(microphoneService: MicrophoneService) {
    super();
    this._status = RoomServiceStatus.INACTIVE;

    this._microphoneService = microphoneService;
    const baseUrl = window.location.origin;
    this._nodeServerClient = createNodeServerClient(baseUrl);
    this._sessionManagerClient = createSessionManagerClient(baseUrl);
  }

  /**
   * Returns the current `RoomServiceStatus` of this service instance.
   */
  get status() {
    return this._status;
  }

  private _setStatus(newStatus: RoomServiceStatus) {
    this._status = newStatus;
    this.emit('statusChange', newStatus);
  }

  private _closeSessionSocket(code?: number, reason?: string) {
    if (this._refreshTimer) {
      clearTimeout(this._refreshTimer);
      this._refreshTimer = null;
    }
    if (this._sessionRefreshToken) {
      this._sessionRefreshToken = null;
      this.emit('sessionRefreshTokenUpdated', null);
    }

    this._sessionToken = null;

    if (this._stream) {
      this._microphoneService.closeAudioStream(this._stream);
      this._stream = null;
    }

    if (!this._socket) return;

    this._socket.removeAllListeners();
    this._socket.close(code, reason);
    this._socket = null;
  }

  private _scheduleTokenRefresh(sessionToken: string, sessionId: string) {
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
      void this._refreshToken(sessionId);
    }, delay);
  }

  private async _refreshToken(sessionId: string) {
    if (!this._sessionRefreshToken || !this._socket) return;

    const [response, error] =
      await this._sessionManagerClient.refreshSessionToken({
        body: { sessionRefreshToken: this._sessionRefreshToken },
      });

    if (error || response.status !== 200) {
      console.error('Token refresh failed, closing session');
      this._closeSessionSocket(1000, 'Token refresh failed');
      this._setStatus(RoomServiceStatus.SESSION_ERROR);
      return;
    }

    const { sessionToken } = response.data;

    if (!this._socket) return;
    this._sessionToken = sessionToken;

    this._socket.send({
      type: AudioSourceClientMessageType.AUTH,
      sessionToken,
    });

    this._scheduleTokenRefresh(sessionToken, sessionId);
  }

  private async _fetchJoinCode(sessionId: string) {
    const [response, error] =
      await this._sessionManagerClient.getSessionJoinCode({
        params: { sessionId },
      });

    if (error || response.status !== 200) {
      this.emit('joinCodeUpdated', null);
      return;
    }

    const { joinCode, expiresAtUnixMs } = response.data;
    this.emit('joinCodeUpdated', { joinCode, expiresAtUnixMs });

    this._scheduleJoinCodeRefresh(sessionId, expiresAtUnixMs);
  }

  private _scheduleJoinCodeRefresh(sessionId: string, expiresAtUnixMs: number) {
    this._stopJoinCodeRefresh();

    const refreshAt = expiresAtUnixMs - JOIN_CODE_REFRESH_BUFFER_MS;
    const delay = Math.max(0, refreshAt - Date.now());

    this._joinCodeRefreshTimer = setTimeout(() => {
      void this._fetchJoinCode(sessionId);
    }, delay);
  }

  private _stopJoinCodeRefresh() {
    if (this._joinCodeRefreshTimer) {
      clearTimeout(this._joinCodeRefreshTimer);
      this._joinCodeRefreshTimer = null;
    }
  }

  /**
   * Attempts to obtain session credentials, first by refreshing a stored token
   * (preserving clientId across page refreshes), then falling back to device auth.
   */
  private async _authenticateSession(sessionId: string): Promise<{
    sessionToken: string;
    sessionRefreshToken: string;
  } | null> {
    // Try refreshing the stored token first to preserve clientId
    if (this._storedSessionRefreshToken) {
      const storedToken = this._storedSessionRefreshToken;
      this._storedSessionRefreshToken = null;

      const [refreshResponse, refreshError] =
        await this._sessionManagerClient.refreshSessionToken({
          body: { sessionRefreshToken: storedToken },
        });

      if (!refreshError && refreshResponse.status === 200) {
        return {
          sessionToken: refreshResponse.data.sessionToken,
          sessionRefreshToken: storedToken,
        };
      }
    }

    // Fall back to full device authentication
    const [authResponse, authError] =
      await this._sessionManagerClient.sourceDeviceSessionAuth({
        body: { sessionId },
      });

    if (authError instanceof NetworkError) return null;
    if (authError || authResponse.status !== 200) return null;

    return authResponse.data;
  }

  private async _connectSession(
    sessionId: string,
    token: number,
  ): Promise<boolean> {
    this._setStatus(RoomServiceStatus.SESSION_CONNECTING);
    this._closeSessionSocket(1000);

    const authResult = await this._authenticateSession(sessionId);

    if (token !== this._sessionLoopToken) return false;

    if (!authResult) {
      this._setStatus(RoomServiceStatus.SESSION_ERROR);
      return false;
    }

    const { sessionToken, sessionRefreshToken } = authResult;

    // Open WebSocket connection to node server audio source
    const [socket, connectError] = await this._nodeServerClient.audioSource({
      params: { sessionId },
    });

    if (token !== this._sessionLoopToken) {
      socket?.close(1000);
      return false;
    }

    if (connectError) {
      this._setStatus(RoomServiceStatus.SESSION_ERROR);
      return false;
    }

    this._socket = socket;
    this._sessionToken = sessionToken;
    this._sessionRefreshToken = sessionRefreshToken;
    this.emit('sessionRefreshTokenUpdated', sessionRefreshToken);

    socket.send({ type: AudioSourceClientMessageType.AUTH, sessionToken });
    this._scheduleTokenRefresh(sessionToken, sessionId);

    this._setStatus(RoomServiceStatus.ACTIVE);

    socket.on('message', (message) => {
      if (message.type === AudioSourceServerMessageType.TRANSCRIPT) {
        this.emit('transcript', {
          final: message.final,
          inProgress: message.in_progress,
        });
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
          'and reason:',
          reason,
        );
        this._closeSessionSocket();

        // Code 1000 with "Session ended" is a graceful end, not an error
        if (code === 1000) {
          this._setStatus(RoomServiceStatus.IDLE);
          this.emit('sessionEnded');
          this._stopSessionLoop();
        } else {
          this._setStatus(RoomServiceStatus.SESSION_ERROR);
        }
        resolve();
      });

      socket.on('error', (err) => {
        console.error(err);
        if (err instanceof WsSchemaValidationError) {
          this._setStatus(RoomServiceStatus.ERROR);
          this._suspend();
        } else {
          this._setStatus(RoomServiceStatus.SESSION_ERROR);
        }
        resolve();
      });
    });

    this._stream = await this._microphoneService.getAudioStream(
      1,
      16000,
      100,
      (buffer) => {
        this._socket?.sendBinary(buffer);
      },
    );

    await socketDone;

    return true;
  }

  private async _executeSessionLoop(sessionId: string, token: number) {
    if (token !== this._sessionLoopToken) return;
    const success = await this._connectSession(sessionId, token);
    if (token !== this._sessionLoopToken) return;

    const delayMs = success ? 0 : this._sessionLoopDelayMs;
    this._sessionLoopDelayMs = success
      ? MIN_RETRY_DELAY_MS
      : Math.min(MAX_RETRY_DELAY_MS, this._sessionLoopDelayMs * 2);

    setTimeout(() => {
      void this._executeSessionLoop(sessionId, token);
    }, delayMs);
  }

  private _startSessionLoop(sessionId: string) {
    void this._executeSessionLoop(sessionId, this._sessionLoopToken);
  }

  private _stopSessionLoop() {
    this._sessionLoopToken++;
    this._closeSessionSocket(1000);
    this._stopJoinCodeRefresh();
    this.emit('joinCodeUpdated', null);
  }

  private async _fetchEvents(token: number) {
    const [response, error] =
      await this._sessionManagerClient.getDeviceSessionEvents({
        querystring: {
          prevEventId: this._prevEventId,
        },
      });

    // Prevent state changes if event loop has been stopped
    if (token !== this._eventLoopToken) return false;

    // Handle errors
    if (error instanceof NetworkError) return false;
    if (error || response.status === 400) {
      this._setStatus(RoomServiceStatus.ERROR);
      this._suspend();
      return false;
    }
    if (response.status === 500) return false;

    // If not authorized, room device has not been registered properly
    if (response.status === 401) {
      this._setStatus(RoomServiceStatus.NOT_REGISTERED);
      this.emit('deviceUnregistered');
      return false;
    }

    const event = response.data;
    // Null indicates no new event
    if (!event) return true;

    this._prevEventId = event.eventId;
    this.emit('prevEventIdUpdated', event.eventId);

    if (event.eventType === DeviceSessionEventType.START_SESSION) {
      this.emit('sessionStarted', event.sessionId);
      this._startSessionLoop(event.sessionId);
      void this._fetchJoinCode(event.sessionId);
    } else {
      this._setStatus(RoomServiceStatus.IDLE);
      this.emit('sessionEnded');
      this._stopSessionLoop();
    }

    return true;
  }

  private async _executeEventLoop(token: number) {
    if (token !== this._eventLoopToken) return;
    const success = await this._fetchEvents(token);
    if (token !== this._eventLoopToken) return;

    const delayMs = success ? 0 : this._eventLoopDelayMs;
    this._eventLoopDelayMs = success
      ? MIN_RETRY_DELAY_MS
      : Math.min(MAX_RETRY_DELAY_MS, this._eventLoopDelayMs * 2);

    setTimeout(() => {
      void this._executeEventLoop(token);
    }, delayMs);
  }

  private _startEventLoop() {
    void this._executeEventLoop(this._eventLoopToken);
  }

  private _stopEventLoop() {
    this._eventLoopToken++;
  }

  private _stopUpcomingSessionsPolling(): void {
    if (this._upcomingSessionsInterval) {
      clearInterval(this._upcomingSessionsInterval);
      this._upcomingSessionsInterval = null;
    }
  }

  private _suspend() {
    this._stopEventLoop();
    this._stopSessionLoop();
    this._stopUpcomingSessionsPolling();
  }

  /**
   * Registers this room device with ScribeAR using the provided activation code.
   * On success, stores the device name and calls `activate()` to begin polling.
   */
  async registerDevice(activationCode: string) {
    this._setStatus(RoomServiceStatus.REGISTERING);

    const [response, error] = await this._sessionManagerClient.activateDevice({
      body: { activationCode },
    });

    if (error instanceof NetworkError) {
      this._setStatus(RoomServiceStatus.REGISTRATION_ERROR);
      return;
    }
    if (error || response.status === 400) {
      this._setStatus(RoomServiceStatus.ERROR);
      this._suspend();
      return;
    }
    if (response.status === 422 || response.status === 500) {
      this._setStatus(RoomServiceStatus.REGISTRATION_ERROR);
      return;
    }

    const deviceDetails = response.data;
    this.emit('deviceRegistered', deviceDetails.deviceName, deviceDetails.deviceId);
    this.activate(deviceDetails.deviceName, null, this._prevEventId, null);
  }

  /**
   * Starts (or restarts) the event-polling and session loops. If the device is
   * not yet registered, sets the status to `NOT_REGISTERED` and returns early.
   * Also starts the upcoming sessions polling interval.
   */
  activate(
    deviceName: string | null,
    activeSessionId: string | null,
    prevEventId: number,
    sessionRefreshToken: string | null,
  ) {
    this._suspend();
    this._eventLoopDelayMs = MIN_RETRY_DELAY_MS;
    this._sessionLoopDelayMs = MIN_RETRY_DELAY_MS;
    this._prevEventId = prevEventId;
    this._storedSessionRefreshToken = sessionRefreshToken;

    if (deviceName === null) {
      this._setStatus(RoomServiceStatus.NOT_REGISTERED);
      return;
    }

    this._setStatus(RoomServiceStatus.IDLE);
    this._startEventLoop();
    if (activeSessionId) {
      this._startSessionLoop(activeSessionId);
      void this._fetchJoinCode(activeSessionId);
    }

    // Start upcoming sessions polling
    void this.getUpcomingSessions();
    this._upcomingSessionsInterval = setInterval(() => {
      void this.getUpcomingSessions();
    }, 30_000);
  }

  /**
   * Stops all event and session loops and sets the status to `INACTIVE`.
   */
  deactivate() {
    this._setStatus(RoomServiceStatus.INACTIVE);
    this._suspend();
  }

  /**
   * Fetches upcoming sessions for this device from the session manager and
   * emits the `upcomingSessionsUpdated` event with the result.
   */
  async getUpcomingSessions(): Promise<void> {
    const [response, error] =
      await this._sessionManagerClient.getDeviceSessions({});

    if (error || response.status !== 200) return;

    this.emit('upcomingSessionsUpdated', response.data.sessions);
  }

  /**
   * Sends a mute/unmute request to the node server for the given session.
   * Updates the local status to reflect the new mute state.
   */
  async muteSession(sessionId: string, muted: boolean): Promise<void> {
    if (!this._sessionToken) return;

    const loopToken = this._sessionLoopToken;
    const token = this._sessionToken;
    const [, error] = await this._nodeServerClient.muteSession({
      params: { sessionId },
      body: { muted },
      headers: { authorization: `Bearer ${token}` },
    });

    if (error) {
      console.error('Failed to set mute state on server:', error);
      return;
    }

    if (loopToken !== this._sessionLoopToken) return;

    if (muted) {
      if (this._status === RoomServiceStatus.ACTIVE) {
        this._setStatus(RoomServiceStatus.ACTIVE_MUTE);
      }
    } else {
      if (this._status === RoomServiceStatus.ACTIVE_MUTE) {
        this._setStatus(RoomServiceStatus.ACTIVE);
      }
    }
  }
}
