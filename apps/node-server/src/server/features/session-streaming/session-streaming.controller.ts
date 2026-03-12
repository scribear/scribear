import { Value } from 'typebox/value';
import type { RawData, WebSocket } from 'ws';

import type { BaseFastifyRequest } from '@scribear/base-fastify-server';
import {
  AUDIO_SOURCE_SCHEMA,
  AudioSourceClientMessageType,
  SESSION_CLIENT_SCHEMA,
} from '@scribear/node-server-schema';

import type { AppDependencies } from '#src/server/dependency-injection/register-dependencies.js';

/**
 * Handles WebSocket connections for both audio-source and session-client endpoints.
 * Validates incoming message schemas and delegates business logic to the service.
 */
export class SessionStreamingController {
  private _sessionStreamingService: AppDependencies['sessionStreamingService'];

  constructor(
    sessionStreamingService: AppDependencies['sessionStreamingService'],
  ) {
    this._sessionStreamingService = sessionStreamingService;
  }

  /**
   * Handles an audio-source WebSocket connection lifecycle.
   *
   * @param socket - The WebSocket connection.
   * @param req - The Fastify request with sessionId URL param.
   */
  audioSource(
    socket: WebSocket,
    req: BaseFastifyRequest<typeof AUDIO_SOURCE_SCHEMA>,
  ): void {
    const { sessionId } = req.params;
    const svc = this._sessionStreamingService;

    svc.on('close', (code, reason) => {
      socket.close(code, reason);
    });
    svc.on('send', (msg) => {
      socket.send(msg);
    });
    svc.startAuthTimeout();

    socket.on('message', (rawData: RawData, isBinary: boolean) => {
      if (isBinary) {
        svc.handleAudioChunk(sessionId, rawData as Buffer);
        return;
      }

      const parsed = this._parseJson(socket, rawData);
      if (parsed === null) return;

      if (!Value.Check(AUDIO_SOURCE_SCHEMA.clientMessage, parsed)) {
        socket.close(1007, 'Invalid message format');
        return;
      }

      const msg = parsed;

      if (msg.type === AudioSourceClientMessageType.AUTH) {
        svc.handleClientAuth(sessionId, msg.sessionToken, { sendAudio: true });
      } else {
        svc
          .handleAudioSourceConfig(sessionId, msg.providerKey, msg.config)
          .catch(() => {
            socket.close(1011, 'Internal server error');
          });
      }
    });

    socket.on('close', () => {
      svc.handleClose(sessionId);
    });
  }

  /**
   * Handles a session-client WebSocket connection lifecycle.
   *
   * @param socket - The WebSocket connection.
   * @param req - The Fastify request with sessionId URL param.
   */
  sessionClient(
    socket: WebSocket,
    req: BaseFastifyRequest<typeof SESSION_CLIENT_SCHEMA>,
  ): void {
    const { sessionId } = req.params;
    const svc = this._sessionStreamingService;

    svc.on('close', (code, reason) => {
      socket.close(code, reason);
    });
    svc.on('send', (msg) => {
      socket.send(msg);
    });
    svc.startAuthTimeout();

    socket.on('message', (rawData: RawData, isBinary: boolean) => {
      if (isBinary) {
        socket.close(1007, 'Binary messages not allowed');
        return;
      }

      const parsed = this._parseJson(socket, rawData);
      if (parsed === null) return;

      if (!Value.Check(SESSION_CLIENT_SCHEMA.clientMessage, parsed)) {
        socket.close(1007, 'Invalid message format');
        return;
      }

      const msg = parsed;
      svc.handleClientAuth(sessionId, msg.sessionToken, {
        receiveTranscriptions: true,
      });
    });

    socket.on('close', () => {
      svc.handleClose(sessionId);
    });
  }

  /**
   * Parses a raw WebSocket message as JSON.
   * Closes the socket with code 1007 and returns null if parsing fails.
   *
   * @param socket - The WebSocket to close on parse failure.
   * @param rawData - The raw message data from the socket.
   * @returns The parsed value, or null if invalid JSON.
   */
  private _parseJson(socket: WebSocket, rawData: RawData): unknown {
    try {
      return JSON.parse(Buffer.from(rawData as Buffer).toString()) as unknown;
    } catch {
      socket.close(1007, 'Invalid JSON');
      return null;
    }
  }
}
