import { EventEmitter } from 'eventemitter3';
import WebSocket from 'isomorphic-ws';
import { type Static, type TSchema } from 'typebox';
import { Value } from 'typebox/value';

import type { BaseWebSocketRouteSchema } from '@scribear/base-schema';

import { SchemaValidationError } from './errors.js';

function normalizeLegacyTranscriptMessage(parsed: unknown): unknown {
  if (typeof parsed !== 'object' || parsed === null) return parsed;
  const candidate = parsed as Record<string, unknown>;
  if (candidate.type === 'ip_transcript') {
    return {
      type: 'transcript',
      final: null,
      in_progress: {
        text: candidate.text,
        starts: candidate.starts,
        ends: candidate.ends,
      },
    };
  }
  if (candidate.type === 'final_transcript') {
    return {
      type: 'transcript',
      final: {
        text: candidate.text,
        starts: candidate.starts,
        ends: candidate.ends,
      },
      in_progress: null,
    };
  }
  return parsed;
}

/**
 * The type of server messages derived from the route schema.
 */
type ServerMessage<S extends BaseWebSocketRouteSchema> =
  S['serverMessage'] extends TSchema ? Static<S['serverMessage']> : never;

/**
 * The type of client messages derived from the route schema.
 */
type ClientMessage<S extends BaseWebSocketRouteSchema> =
  S['clientMessage'] extends TSchema ? Static<S['clientMessage']> : never;

/**
 * Narrows the WebSocket close code to the literal union of codes declared in
 * the route schema's `closeCodes` field. Falls back to `number` if none are
 * declared.
 */
type WsCloseCodeOf<S extends BaseWebSocketRouteSchema> =
  S['closeCodes'] extends Partial<Record<infer K extends number, unknown>>
    ? K
    : number;

interface WebSocketEvents<S extends BaseWebSocketRouteSchema> {
  message: (msg: ServerMessage<S>) => void;
  binaryMessage: (data: Buffer | ArrayBuffer) => void;
  close: (code: WsCloseCodeOf<S>, reason: string) => void;
  error: (err: SchemaValidationError | Error) => void;
}

/**
 * A typed WebSocket client wrapping a live connection.
 */
export class WebSocketClient<
  S extends BaseWebSocketRouteSchema,
> extends EventEmitter<WebSocketEvents<S>> {
  private _ws: WebSocket;
  private _schema: S;

  /**
   * @param ws - The underlying WebSocket instance (already open).
   * @param schema - The route schema used for server message validation.
   */
  constructor(ws: WebSocket, schema: S) {
    super();
    this._ws = ws;
    this._schema = schema;

    this._ws.onmessage = (event) => {
      const { data } = event;

      if (
        data instanceof ArrayBuffer ||
        (typeof Buffer !== 'undefined' && data instanceof Buffer)
      ) {
        if (!this._schema.allowServerBinaryMessage) {
          this.emit(
            'error',
            new SchemaValidationError(
              'Receiving binary message is not allowed.',
            ),
          );
          return;
        }

        this.emit('binaryMessage', data);
        return;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(data as string);
      } catch {
        this.emit(
          'error',
          new SchemaValidationError('Received message is not valid JSON.'),
        );
        return;
      }

      const normalizedParsed = normalizeLegacyTranscriptMessage(parsed);

      if (!Value.Check(this._schema.serverMessage, normalizedParsed)) {
        this.emit(
          'error',
          new SchemaValidationError(
            'Received message did not match expected server message schema.',
          ),
        );
        return;
      }

      this.emit('message', normalizedParsed as ServerMessage<S>);
    };

    this._ws.onclose = (event) => {
      if (!(event.code in this._schema.closeCodes)) {
        this.emit(
          'error',
          new SchemaValidationError(
            `Received unexpected WebSocket close code: ${event.code.toString()}.`,
          ),
        );
        return;
      }
      this.emit('close', event.code as WsCloseCodeOf<S>, event.reason);
    };

    this._ws.onerror = (event) => {
      this.emit(
        'error',
        event.error instanceof Error ? event.error : new Error(event.message),
      );
    };
  }

  /**
   * Sends a typed JSON client message to the server.
   *
   * @param message - The client message to send.
   */
  send(message: ClientMessage<S>): void {
    this._ws.send(JSON.stringify(message));
  }

  /**
   * Sends a raw binary message to the server.
   *
   * @param data - The binary data to send.
   */
  sendBinary(data: ArrayBuffer | Buffer): void {
    this._ws.send(data);
  }

  /**
   * Closes the underlying WebSocket connection.
   */
  close(code?: number, reason?: string): void {
    this._ws.close(code, reason);
  }
}
