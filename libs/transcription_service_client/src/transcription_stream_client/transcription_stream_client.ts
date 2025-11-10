import { EventEmitter } from 'eventemitter3';
import WebSocket from 'isomorphic-ws';

import type { TranscriptionStreamConfig } from './transcription_stream_configs.js';
import {
  type AuthMessage,
  ClientMessageTypes,
  type ConfigMessage,
} from './transcription_stream_messages/client_messages.js';
import {
  ServerMessageTypes,
  ServerMessageValidator,
} from './transcription_stream_messages/server_messages.js';

const TRANSCRIPTION_STREAM_ROUTE = '/transcription_stream/';

interface ClientEvents {
  'connected'(): void;
  'disconnected'(code: number, reason: string): void;
  'error'(error: Error): void;
  'ip_transcription'(
    text: string[],
    starts: number[] | null,
    ends: number[] | null,
  ): void;
  'final_transcription'(
    text: string[],
    starts: number[] | null,
    ends: number[] | null,
  ): void;
}

enum ClientState {
  CONNECTING,
  CONNECTED,
  DISCONNECTED,
}

class TranscriptionStreamClient extends EventEmitter<ClientEvents> {
  private _ws: WebSocket | null = null;
  private _client_state: ClientState = ClientState.DISCONNECTED;

  constructor(
    private _server_address: string,
    private _api_key: string,
    private _use_ssl: boolean,
    private _provider_key: string,
    private _config: TranscriptionStreamConfig,
  ) {
    super();
  }

  connect() {
    this._client_state = ClientState.CONNECTING;

    const protocol = this._use_ssl ? 'wss://' : 'ws://';
    const url = `${protocol}${this._server_address}${TRANSCRIPTION_STREAM_ROUTE}${this._provider_key}`;

    this._ws = new WebSocket(url);

    this._ws.onopen = this._onopen.bind(this);
    this._ws.onmessage = this._onmessage.bind(this);
    this._ws.onclose = this._onclose.bind(this);
    this._ws.onerror = this._onerror.bind(this);
  }

  send_audio(chunk: ArrayBufferLike | Blob | ArrayBufferView) {
    if (this._client_state === ClientState.CONNECTED) {
      this._ws?.send(chunk);
    }
  }

  disconnect() {
    if (this._client_state === ClientState.DISCONNECTED) return;

    this._client_state = ClientState.DISCONNECTED;

    this._ws?.close(1000);
    this._ws = null;
  }

  private _onopen() {
    const authMessage: AuthMessage = {
      type: ClientMessageTypes.AUTH,
      api_key: this._api_key,
    };
    this._ws?.send(JSON.stringify(authMessage));

    const configMessage: ConfigMessage = {
      type: ClientMessageTypes.CONFIG,
      config: this._config,
    };
    this._ws?.send(JSON.stringify(configMessage));

    this._client_state = ClientState.CONNECTED;
    this.emit('connected');
  }

  private _onmessage(e: WebSocket.MessageEvent) {
    const message = e.data;
    const isBinary = !(typeof message === 'string');

    if (isBinary) return;

    const serverMessage = ServerMessageValidator.Parse(JSON.parse(message));
    if (serverMessage.type === ServerMessageTypes.IP_TRANSCRIPT) {
      this.emit(
        'ip_transcription',
        serverMessage.text,
        serverMessage.ends ?? null,
        serverMessage.starts ?? null,
      );
    } else {
      this.emit(
        'final_transcription',
        serverMessage.text,
        serverMessage.ends ?? null,
        serverMessage.starts ?? null,
      );
    }
  }

  private _onclose(e: WebSocket.CloseEvent) {
    this._client_state = ClientState.DISCONNECTED;
    this.emit('disconnected', e.code, e.reason);

    this._ws = null;
  }

  private _onerror(e: WebSocket.ErrorEvent) {
    this.emit('error', new Error(e.message));
  }
}

export default TranscriptionStreamClient;
