import { EventEmitter } from 'eventemitter3';
import WebSocket from 'isomorphic-ws';

import type { TranscriptionStreamConfig } from './transcription-stream-configs.js';
import {
  type AuthMessage,
  ClientMessageTypes,
  type ConfigMessage,
} from './transcription-stream-messages/client-messages.js';
import {
  ServerMessageTypes,
  ServerMessageValidator,
} from './transcription-stream-messages/server-messages.js';

const TRANSCRIPTION_STREAM_ROUTE = '/transcription_stream/';

interface ClientEvents {
  connected: () => void;
  disconnected: (code: number, reason: string) => void;
  error: (error: Error) => void;
  ipTranscription: (
    text: string[],
    starts: number[] | null,
    ends: number[] | null,
  ) => void;
  finalTranscription: (
    text: string[],
    starts: number[] | null,
    ends: number[] | null,
  ) => void;
  latencyUpdate: (type: 'final' | 'in_progress', latency: number) => void;
}

enum ClientState {
  CONNECTING,
  CONNECTED,
  DISCONNECTED,
}

class TranscriptionStreamClient extends EventEmitter<ClientEvents> {
  private _ws: WebSocket | null = null;
  private _client_state: ClientState = ClientState.DISCONNECTED;

  private _pendingChunks = new Map<string, number>();

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
      const chunkId = crypto.randomUUID();
      this._pendingChunks.set(chunkId, Date.now());
      const encoder = new TextEncoder();
      const uuidBytes = encoder.encode(chunkId);

      let payload: Blob | Uint8Array;
      if (chunk instanceof Blob) {
        payload = new Blob([uuidBytes, chunk]);
      } else {
        const audioBytes = new Uint8Array(
          'buffer' in chunk ? chunk.buffer : (chunk as ArrayBuffer),
          'byteOffset' in chunk ? chunk.byteOffset : 0,
          'byteLength' in chunk
            ? chunk.byteLength
            : (chunk as ArrayBuffer).byteLength,
        );
        payload = new Uint8Array(uuidBytes.length + audioBytes.length);
        payload.set(uuidBytes, 0);
        payload.set(audioBytes, uuidBytes.length);
      }
      this._ws?.send(payload);
    }
  }

  disconnect() {
    if (this._client_state === ClientState.DISCONNECTED) return;

    this._client_state = ClientState.DISCONNECTED;
    this._pendingChunks.clear();
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
    if (serverMessage.chunk_ids && serverMessage.chunk_ids.length > 0) {
      const sourceId = serverMessage.chunk_ids[0];
      if (sourceId) {
        const sentTime = this._pendingChunks.get(sourceId);
        if (sentTime) {
          const latency = Date.now() - sentTime;
          const msgType =
            serverMessage.type === ServerMessageTypes.IP_TRANSCRIPT
              ? 'in_progress'
              : 'final';
          this.emit('latencyUpdate', msgType, latency);
          for (const [id, time] of this._pendingChunks.entries()) {
            if (time <= sentTime) {
              this._pendingChunks.delete(id);
            }
          }
        }
      }
    }
    if (serverMessage.type === ServerMessageTypes.IP_TRANSCRIPT) {
      this.emit(
        'ipTranscription',
        serverMessage.text,
        serverMessage.ends ?? null,
        serverMessage.starts ?? null,
      );
    } else {
      this.emit(
        'finalTranscription',
        serverMessage.text,
        serverMessage.ends ?? null,
        serverMessage.starts ?? null,
      );
    }
  }

  private _onclose(e: WebSocket.CloseEvent) {
    this._client_state = ClientState.DISCONNECTED;
    this.emit('disconnected', e.code, e.reason);
    this._pendingChunks.clear();

    this._ws = null;
  }
  private _onerror(e: WebSocket.ErrorEvent) {
    this.emit('error', new Error(e.message));
  }
}

export default TranscriptionStreamClient;
