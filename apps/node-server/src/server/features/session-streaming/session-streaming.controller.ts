import { Value } from 'typebox/value';
import type { RawData, WebSocket } from 'ws';

import type { BaseFastifyReply, BaseFastifyRequest } from '@scribear/base-fastify-server';
import {
  AUDIO_SOURCE_SCHEMA,
  AudioSourceServerMessageType,
  MUTE_SESSION_SCHEMA,
  SESSION_CLIENT_SCHEMA,
  SessionClientServerMessageType,
  SessionTokenScope,
} from '@scribear/node-server-schema';

import type { AppDependencies } from '#src/server/dependency-injection/register-dependencies.js';

/**
 * Handles WebSocket connections for both audio-source and session-client endpoints.
 * Validates incoming message schemas, delegates business logic to the service,
 * and maps generic service events to client-type-specific message formats.
 */
export class SessionStreamingController {
  private _sessionStreamingService: AppDependencies['sessionStreamingService'];
  private _jwtService: AppDependencies['jwtService'];
  private _transcriptionServiceManager: AppDependencies['transcriptionServiceManager'];

  constructor(
    sessionStreamingService: AppDependencies['sessionStreamingService'],
    jwtService: AppDependencies['jwtService'],
    transcriptionServiceManager: AppDependencies['transcriptionServiceManager'],
  ) {
    this._sessionStreamingService = sessionStreamingService;
    this._jwtService = jwtService;
    this._transcriptionServiceManager = transcriptionServiceManager;
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
      transcriptType: AudioSourceServerMessageType.TRANSCRIPT,
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
      transcriptType: SessionClientServerMessageType.TRANSCRIPT,
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
   * Handles a POST request to mute or unmute audio forwarding for a session.
   * Validates the Bearer JWT, checks SEND_AUDIO scope and sessionId match,
   * then delegates to TranscriptionServiceManager.
   *
   * @param req - The Fastify request with sessionId param and muted body.
   * @param res - The Fastify reply.
   */
  async muteSession(
    req: BaseFastifyRequest<typeof MUTE_SESSION_SCHEMA>,
    res: BaseFastifyReply<typeof MUTE_SESSION_SCHEMA>,
  ): Promise<void> {
    const authHeader = req.headers.authorization ?? '';
    const token = authHeader.startsWith('Bearer ')
      ? authHeader.slice('Bearer '.length)
      : '';

    const payload = this._jwtService.verifySessionToken(token);
    if (
      payload === null ||
      !payload.scopes.includes(SessionTokenScope.SEND_AUDIO)
    ) {
      await res.status(401).send({ message: 'Unauthorized' });
      return;
    }

    if (payload.sessionId !== req.params.sessionId) {
      await res.status(401).send({ message: 'Unauthorized' });
      return;
    }

    const found = this._transcriptionServiceManager.setMuted(
      req.params.sessionId,
      req.body.muted,
    );
    if (!found) {
      await res.status(404).send({ message: 'Session not found' });
      return;
    }

    await res.status(200).send({});
  }

  /**
   * Wires up common service events (close, send, transcripts, status)
   * to the WebSocket, mapping generic events to client-type-specific message types.
   */
  private _wireCommonEvents(
    socket: WebSocket,
    messageTypes: {
      transcriptType: string;
      sessionStatusType: string;
    },
  ): void {
    this._sessionStreamingService.on('close', (code, reason) => {
      socket.close(code, reason);
    });
    this._sessionStreamingService.on('send', (msg) => {
      socket.send(msg);
    });
    this._sessionStreamingService.on('transcript', (event) => {
      socket.send(
        JSON.stringify({
          type: messageTypes.transcriptType,
          final: event.final,
          in_progress: event.inProgress,
        }),
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
