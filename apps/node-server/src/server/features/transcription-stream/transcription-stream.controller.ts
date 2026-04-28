import type { FastifyRequest } from 'fastify';
import { Value } from 'typebox/value';
import type WebSocket from 'ws';

import { TRANSCRIPTION_STREAM_SCHEMA } from '@scribear/node-server-schema';

import type { AppDependencies } from '#src/server/dependency-injection/app-dependencies.js';

import {
  type TranscriptionStreamRole,
  TranscriptionStreamService,
} from './transcription-stream.service.js';

interface RouteParams {
  sessionUid: string;
}

/**
 * Per-connection controller for the transcription-stream WebSocket. Owns
 * the raw socket; instantiates a {@link TranscriptionStreamService} bound to
 * the role of the route the upgrade arrived on (`source` or `client`); wires
 * service-emitted `send`/`close` events to the socket and socket events to
 * service handlers.
 *
 * The controller is the only piece that touches the socket directly, which
 * keeps the service unit-testable without a real WebSocket.
 */
export class TranscriptionStreamController {
  private _logger: AppDependencies['logger'];
  private _sessionTokenService: AppDependencies['sessionTokenService'];
  private _eventBusService: AppDependencies['eventBusService'];
  private _transcriptionOrchestratorService: AppDependencies['transcriptionOrchestratorService'];

  constructor(
    logger: AppDependencies['logger'],
    sessionTokenService: AppDependencies['sessionTokenService'],
    eventBusService: AppDependencies['eventBusService'],
    transcriptionOrchestratorService: AppDependencies['transcriptionOrchestratorService'],
  ) {
    this._logger = logger;
    this._sessionTokenService = sessionTokenService;
    this._eventBusService = eventBusService;
    this._transcriptionOrchestratorService = transcriptionOrchestratorService;
  }

  handleSourceConnection(socket: WebSocket, request: FastifyRequest): void {
    this._handleConnection('source', socket, request);
  }

  handleClientConnection(socket: WebSocket, request: FastifyRequest): void {
    this._handleConnection('client', socket, request);
  }

  private _handleConnection(
    role: TranscriptionStreamRole,
    socket: WebSocket,
    request: FastifyRequest,
  ): void {
    const params = request.params as RouteParams;
    const sessionUid = params.sessionUid;

    const service = new TranscriptionStreamService({
      role,
      urlSessionUid: sessionUid,
      logger: this._logger,
      sessionTokenService: this._sessionTokenService,
      eventBusService: this._eventBusService,
      transcriptionOrchestratorService: this._transcriptionOrchestratorService,
    });

    service.on('send', (msg) => {
      try {
        socket.send(JSON.stringify(msg));
      } catch (err) {
        this._logger.warn({ err, sessionUid }, 'failed to send to socket');
      }
    });

    service.on('close', (code, reason) => {
      try {
        socket.close(code, reason);
      } catch (err) {
        this._logger.warn({ err, sessionUid }, 'failed to close socket');
      }
    });

    socket.on('message', (data, isBinary) => {
      if (isBinary) {
        const buffer = Buffer.isBuffer(data)
          ? data
          : Buffer.from(data as ArrayBuffer);
        service.handleBinary(buffer);
        return;
      }

      const text =
        typeof data === 'string'
          ? data
          : Buffer.isBuffer(data)
            ? data.toString('utf8')
            : Buffer.from(data as ArrayBuffer).toString('utf8');

      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        socket.close(1007, 'invalid-json');
        return;
      }
      if (!Value.Check(TRANSCRIPTION_STREAM_SCHEMA.clientMessage, parsed)) {
        socket.close(1007, 'invalid-message');
        return;
      }
      // The schema currently has a single `auth` client-message variant, so
      // we dispatch directly. When new variants are added, switch on
      // `parsed.type` and route to additional service methods.
      void service.handleAuth(parsed.sessionToken);
    });

    socket.on('close', () => {
      service.handleClose();
    });

    socket.on('error', (err) => {
      this._logger.warn(
        { err, sessionUid },
        'transcription-stream socket error',
      );
    });

    service.start();
  }
}
