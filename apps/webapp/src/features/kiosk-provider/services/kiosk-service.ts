import EventEmitter from 'eventemitter3';

import { NetworkError } from '@scribear/base-api-client';
import {
  type WebSocketClient,
  SchemaValidationError as WsSchemaValidationError,
} from '@scribear/base-websocket-client';
import { createNodeServerClient } from '@scribear/node-server-client';
import {
  type AUDIO_SOURCE_SCHEMA,
  AudioSourceClientMessageType,
  AudioSourceServerMessageType,
} from '@scribear/node-server-schema';
import { createSessionManagerClient } from '@scribear/session-manager-client';
import { DeviceSessionEventType } from '@scribear/session-manager-schema';

import type {
  AudioStream,
  MicrophoneService,
} from '#src/core/microphone/services/microphone-service.js';
import {
  appendFinalizedTranscription,
  replaceInProgressTranscription,
} from '#src/core/transcription-content/store/transcription-content-slice.js';
import type { AppStore } from '#src/stores/store.js';

import {
  selectActiveSessionId,
  selectDeviceName,
  selectPrevEventId,
  setActiveSessionId,
  setDeviceName,
  setPrevEventId,
} from '../stores/kiosk-config-slice';
import { setKioskServiceStatus } from '../stores/kiosk-service-slice';
import { KioskServiceStatus } from './kiosk-service-status';

const MIN_RETRY_DELAY_MS = 1_000;
const MAX_RETRY_DELAY_MS = 60_000;

export class KioskService extends EventEmitter {
  private _status: KioskServiceStatus;
  private _muted = true;

  private _store;
  private _microphoneService;
  private _sessionManagerClient;
  private _nodeServerClient;

  private _stream: AudioStream | null = null;
  private _socket: WebSocketClient<typeof AUDIO_SOURCE_SCHEMA> | null = null;

  private _eventLoopToken = 0;
  private _eventLoopDelayMs = MIN_RETRY_DELAY_MS;

  private _sessionLoopToken = 0;
  private _sessionLoopDelayMs = MIN_RETRY_DELAY_MS;

  constructor(
    store: Pick<AppStore, 'dispatch' | 'getState'>,
    microphoneService: MicrophoneService,
  ) {
    super();
    this._status = KioskServiceStatus.INACTIVE;

    this._store = store;
    this._microphoneService = microphoneService;
    const baseUrl = window.location.origin;
    this._nodeServerClient = createNodeServerClient(baseUrl);
    this._sessionManagerClient = createSessionManagerClient(baseUrl);
  }

  get status() {
    return this._status;
  }

  private _setStatus(newStatus: KioskServiceStatus) {
    this._status = newStatus;
    this._store.dispatch(setKioskServiceStatus(newStatus));
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

    this._stream = await this._microphoneService.getAudioStream(
      1,
      16000,
      100,
      (buffer) => {
        this._socket?.sendBinary(buffer);
      },
    );

    socket.on('message', (message) => {
      if (message.type === AudioSourceServerMessageType.FINAL_TRANSCRIPT) {
        this._store.dispatch(appendFinalizedTranscription(message));
      } else {
        this._store.dispatch(replaceInProgressTranscription(message));
      }
    });

    // Await until the socket closes or encounters a terminal error
    await new Promise<void>((resolve) => {
      socket.on('close', (code, reason) => {
        console.log(
          'Session connection closed with code:',
          code,
          'and reason:',
          reason,
        );
        this._socket = null;
        this._setStatus(KioskServiceStatus.SESSION_ERROR);
        resolve();
      });

      socket.on('error', (err) => {
        console.error(err);
        if (err instanceof WsSchemaValidationError) {
          this._setStatus(KioskServiceStatus.ERROR);
          this._suspend();
        }
        resolve();
      });
    });

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
          prevEventId: selectPrevEventId(this._store.getState()),
        },
      });

    // Prevent state changes if event loop has been stopped
    if (token != this._eventLoopToken) return false;

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
      this._store.dispatch(setDeviceName(null));
      return false;
    }

    const event = response.data;
    // Null indicates no new event
    if (!event) return true;

    this._store.dispatch(setPrevEventId(event.eventId));

    if (event.eventType == DeviceSessionEventType.START_SESSION) {
      this._store.dispatch(setActiveSessionId(event.sessionId));
      this._startSessionLoop(event.sessionId);
    } else {
      this._setStatus(KioskServiceStatus.IDLE);
      this._store.dispatch(setActiveSessionId(null));
      this._stopSessionLoop();
    }

    return true;
  }

  private async _executeEventLoop(token: number) {
    if (token != this._eventLoopToken) return;
    const success = await this._fetchEvents(token);
    if (token != this._eventLoopToken) return;

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
    this._store.dispatch(setDeviceName(deviceDetails.deviceName));
    this.activate();
  }

  activate() {
    this._suspend();

    const state = this._store.getState();
    const deviceName = selectDeviceName(state);
    const activeSessionId = selectActiveSessionId(state);

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

  deactivate() {
    this._setStatus(KioskServiceStatus.INACTIVE);
    this._suspend();
  }

  mute() {
    this._muted = true;
    if (this._status === KioskServiceStatus.ACTIVE) {
      this._setStatus(KioskServiceStatus.ACTIVE_MUTE);
    }
  }

  unmute() {
    this._muted = false;
    if (this._status === KioskServiceStatus.ACTIVE_MUTE) {
      this._setStatus(KioskServiceStatus.ACTIVE);
    }
  }
}
