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

import { KioskServiceStatus } from './kiosk-service-status';

const MIN_RETRY_DELAY_MS = 1_000;
const MAX_RETRY_DELAY_MS = 60_000;

/**
 * Events emitted by {@link KioskService} to communicate status changes,
 * transcription output, and device/session lifecycle to the Redux middleware.
 */
interface KioskServiceEvents {
  statusChange: (status: KioskServiceStatus) => void;
  appendFinalizedTranscription: (sequence: TranscriptionSequenceInput) => void;
  replaceInProgressTranscription: (
    sequence: TranscriptionSequenceInput,
  ) => void;
  sessionStarted: (sessionId: string) => void;
  sessionEnded: () => void;
  deviceRegistered: (deviceName: string) => void;
  deviceUnregistered: () => void;
  prevEventIdUpdated: (eventId: number) => void;
}

/**
 * Core service that manages the kiosk device's connection to ScribeAR.
 * Runs an event-polling loop against the session manager to detect when a
 * session starts or ends, then opens a WebSocket audio-source connection to
 * the node server and streams microphone audio for transcription. Handles
 * exponential back-off retries for both the event and session loops.
 */
export class KioskService extends EventEmitter<KioskServiceEvents> {
  private _status: KioskServiceStatus;
  private _muted = true;

  private _microphoneService;
  private _sessionManagerClient;
  private _nodeServerClient;

  private _prevEventId = -1;

  private _stream: AudioStream | null = null;
  private _socket: WebSocketClient<typeof AUDIO_SOURCE_SCHEMA> | null = null;

  private _eventLoopToken = 0;
  private _eventLoopDelayMs = MIN_RETRY_DELAY_MS;

  private _sessionLoopToken = 0;
  private _sessionLoopDelayMs = MIN_RETRY_DELAY_MS;

  constructor(microphoneService: MicrophoneService) {
    super();
    this._status = KioskServiceStatus.INACTIVE;

    this._microphoneService = microphoneService;
    const baseUrl = window.location.origin;
    this._nodeServerClient = createNodeServerClient(baseUrl);
    this._sessionManagerClient = createSessionManagerClient(baseUrl);
  }

  /**
   * Returns the current `KioskServiceStatus` of this service instance.
   */
  get status() {
    return this._status;
  }

  private _setStatus(newStatus: KioskServiceStatus) {
    this._status = newStatus;
    this.emit('statusChange', newStatus);
  }

  private _closeSessionSocket(code?: number, reason?: string) {
    if (this._stream) {
      this._microphoneService.closeAudioStream(this._stream);
      this._stream = null;
    }

    if (!this._socket) return;

    this._socket.removeAllListeners();
    this._socket.close(code, reason);
    this._socket = null;
  }

  private async _connectSession(
    sessionId: string,
    token: number,
  ): Promise<boolean> {
    this._setStatus(KioskServiceStatus.SESSION_CONNECTING);
    this._closeSessionSocket(1000);

    // Fetch session token and transcription config
    const [authResponse, authError] =
      await this._sessionManagerClient.sourceDeviceSessionAuth({
        body: { sessionId },
      });

    if (token !== this._sessionLoopToken) return false;

    if (authError instanceof NetworkError) {
      this._setStatus(KioskServiceStatus.SESSION_ERROR);
      return false;
    }
    if (authError || authResponse.status === 400) {
      this._setStatus(KioskServiceStatus.ERROR);
      this._suspend();
      return false;
    }
    if (authResponse.status === 500) return false;

    if (authResponse.status === 401) {
      this._setStatus(KioskServiceStatus.SESSION_ERROR);
      return false;
    }

    const {
      sessionToken,
      transcriptionProviderKey,
      transcriptionProviderConfig,
    } = authResponse.data;

    // Open WebSocket connection to node server audio source
    const [socket, connectError] = await this._nodeServerClient.audioSource({
      params: { sessionId },
    });

    if (token !== this._sessionLoopToken) {
      socket?.close(1000);
      return false;
    }

    if (connectError) {
      this._setStatus(KioskServiceStatus.SESSION_ERROR);
      return false;
    }

    this._socket = socket;

    socket.send({ type: AudioSourceClientMessageType.AUTH, sessionToken });
    socket.send({
      type: AudioSourceClientMessageType.CONFIG,
      providerKey: transcriptionProviderKey,
      config: transcriptionProviderConfig,
    });

    this._setStatus(
      this._muted ? KioskServiceStatus.ACTIVE_MUTE : KioskServiceStatus.ACTIVE,
    );

    socket.on('message', (message) => {
      if (message.type === AudioSourceServerMessageType.FINAL_TRANSCRIPT) {
        this.emit('appendFinalizedTranscription', message);
      } else {
        this.emit('replaceInProgressTranscription', message);
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
        this._setStatus(KioskServiceStatus.SESSION_ERROR);
        resolve();
      });

      socket.on('error', (err) => {
        console.error(err);
        if (err instanceof WsSchemaValidationError) {
          this._setStatus(KioskServiceStatus.ERROR);
          this._suspend();
        } else {
          this._setStatus(KioskServiceStatus.SESSION_ERROR);
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
      this._setStatus(KioskServiceStatus.ERROR);
      this._suspend();
      return false;
    }
    if (response.status === 500) return false;

    // If not authorized, kiosk has not been registered properly
    if (response.status === 401) {
      this._setStatus(KioskServiceStatus.NOT_REGISTERED);
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
    } else {
      this._setStatus(KioskServiceStatus.IDLE);
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

  private _suspend() {
    this._stopEventLoop();
    this._stopSessionLoop();
  }

  /**
   * Registers this kiosk device with ScribeAR using the provided activation code.
   * On success, stores the device name and calls `activate()` to begin polling.
   */
  async registerDevice(activationCode: string) {
    this._setStatus(KioskServiceStatus.REGISTERING);

    const [response, error] = await this._sessionManagerClient.activateDevice({
      body: { activationCode },
    });

    if (error instanceof NetworkError) {
      this._setStatus(KioskServiceStatus.REGISTRATION_ERROR);
      return;
    }
    if (error || response.status === 400) {
      this._setStatus(KioskServiceStatus.ERROR);
      this._suspend();
      return;
    }
    if (response.status === 422 || response.status === 500) {
      this._setStatus(KioskServiceStatus.REGISTRATION_ERROR);
      return;
    }

    const deviceDetails = response.data;
    this.emit('deviceRegistered', deviceDetails.deviceName);
    this.activate(deviceDetails.deviceName, null, this._prevEventId);
  }

  /**
   * Starts (or restarts) the event-polling and session loops. If the device is
   * not yet registered, sets the status to `NOT_REGISTERED` and returns early.
   */
  activate(
    deviceName: string | null,
    activeSessionId: string | null,
    prevEventId: number,
  ) {
    this._suspend();
    this._eventLoopDelayMs = MIN_RETRY_DELAY_MS;
    this._sessionLoopDelayMs = MIN_RETRY_DELAY_MS;
    this._prevEventId = prevEventId;

    if (deviceName === null) {
      this._setStatus(KioskServiceStatus.NOT_REGISTERED);
      return;
    }

    this._setStatus(KioskServiceStatus.IDLE);
    this._startEventLoop();
    if (activeSessionId) {
      this._startSessionLoop(activeSessionId);
    }
  }

  /**
   * Stops all event and session loops and sets the status to `INACTIVE`.
   */
  deactivate() {
    this._setStatus(KioskServiceStatus.INACTIVE);
    this._suspend();
  }

  /**
   * Mutes outgoing audio and reflects the change in the service status.
   */
  mute() {
    this._muted = true;
    if (this._status === KioskServiceStatus.ACTIVE) {
      this._setStatus(KioskServiceStatus.ACTIVE_MUTE);
    }
  }

  /**
   * Unmutes outgoing audio and reflects the change in the service status.
   */
  unmute() {
    this._muted = false;
    if (this._status === KioskServiceStatus.ACTIVE_MUTE) {
      this._setStatus(KioskServiceStatus.ACTIVE);
    }
  }
}
