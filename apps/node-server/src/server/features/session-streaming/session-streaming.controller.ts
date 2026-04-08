import { Value } from 'typebox/value';
import type { RawData, WebSocket } from 'ws';

import type { BaseFastifyRequest } from '@scribear/base-fastify-server';
import {
  AUDIO_SOURCE_SCHEMA,
  AudioSourceServerMessageType,
  SESSION_CLIENT_SCHEMA,
  SessionClientServerMessageType,
} from '@scribear/node-server-schema';

import type { AppDependencies } from '#src/server/dependency-injection/register-dependencies.js';

/**
 * Handles WebSocket connections for both audio-source and session-client endpoints.
 * Validates incoming message schemas, delegates business logic to the service,
 * and maps generic service events to client-type-specific message formats.
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

    this._wireCommonEvents(socket, {
      ipTranscriptType: AudioSourceServerMessageType.IP_TRANSCRIPT,
      finalTranscriptType: AudioSourceServerMessageType.FINAL_TRANSCRIPT,
      sessionStatusType: AudioSourceServerMessageType.SESSION_STATUS,
    });
    this._sessionStreamingService.startAuthTimeout();

    socket.on('message', (rawData: RawData, isBinary: boolean) => {
      if (isBinary) {
        this._sessionStreamingService.handleAudioChunk(
          sessionId,
          rawData as Buffer,
        );
        return;
      }

      const parsed = this._parseJson(socket, rawData);
      if (parsed === null) return;

      if (!Value.Check(AUDIO_SOURCE_SCHEMA.clientMessage, parsed)) {
        socket.close(1007, 'Invalid message format');
        return;
      }

      this._sessionStreamingService.handleClientAuth(
        sessionId,
        parsed.sessionToken,
        {
          sendAudio: true,
        },
      );
    });

    socket.on('close', () => {
      this._sessionStreamingService.handleClose(sessionId);
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

    this._wireCommonEvents(socket, {
      ipTranscriptType: SessionClientServerMessageType.IP_TRANSCRIPT,
      finalTranscriptType: SessionClientServerMessageType.FINAL_TRANSCRIPT,
      sessionStatusType: SessionClientServerMessageType.SESSION_STATUS,
    });
    this._sessionStreamingService.startAuthTimeout();

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

      this._sessionStreamingService.handleClientAuth(
        sessionId,
        parsed.sessionToken,
        {
          receiveTranscriptions: true,
        },
      );
    });

    socket.on('close', () => {
      this._sessionStreamingService.handleClose(sessionId);
    });
  }

  /**
   * Wires up common service events (close, send, transcripts, status)
   * to the WebSocket, mapping generic events to client-type-specific message types.
   */
  private _wireCommonEvents(
    socket: WebSocket,
    messageTypes: {
      ipTranscriptType: string;
      finalTranscriptType: string;
      sessionStatusType: string;
    },
  ): void {
    this._sessionStreamingService.on('close', (code, reason) => {
      socket.close(code, reason);
    });
    this._sessionStreamingService.on('send', (msg) => {
      socket.send(msg);
    });
    this._sessionStreamingService.on('ip-transcript', (event) => {
      socket.send(
        JSON.stringify({ type: messageTypes.ipTranscriptType, ...event }),
      );
    });
    this._sessionStreamingService.on('final-transcript', (event) => {
      socket.send(
        JSON.stringify({ type: messageTypes.finalTranscriptType, ...event }),
      );
    });
    this._sessionStreamingService.on('session-status', (event) => {
      socket.send(
        JSON.stringify({
          type: messageTypes.sessionStatusType,
          transcriptionServiceConnected: event.transcriptionServiceConnected,
          sourceDeviceConnected: event.sourceDeviceConnected,
        }),
      );
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
