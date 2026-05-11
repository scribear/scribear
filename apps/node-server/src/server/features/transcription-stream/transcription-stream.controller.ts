import type { FastifyRequest } from 'fastify';
import { Value } from 'typebox/value';
import type WebSocket from 'ws';

import {
  TRANSCRIPTION_STREAM_SCHEMA,
  TranscriptionStreamServerMessageType,
} from '@scribear/node-server-schema';

import type { AppDependencies } from '#src/server/dependency-injection/app-dependencies.js';

import {
  type TranscriptionStreamRole,
  verifyAuth,
} from './transcription-stream.auth.js';
import { TranscriptionStreamService } from './transcription-stream.service.js';

interface RouteParams {
  sessionUid: string;
}

const AUTH_TIMEOUT_MS = 5000;

/**
 * Per-connection controller for the transcription-stream WebSocket. Owns
 * the raw socket and the auth handshake (token verification, scope check,
 * timeout watchdog, auth-success response). Once auth succeeds it constructs
 * a {@link TranscriptionStreamService} bound to the route's role and forwards
 * binary audio frames to it.
 *
 * The split keeps the service free of any protocol or auth-format
 * knowledge - the controller decides who is allowed to talk and how
 * responses are framed; the service decides what the connection's
 * presence implies for the session.
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

    let service: TranscriptionStreamService | null = null;
    let ready = false;
    let authInFlight = false;
    let closed = false;
    let authTimer: ReturnType<typeof setTimeout> | null = null;

    const safeSend = (msg: unknown) => {
      try {
        socket.send(JSON.stringify(msg));
      } catch (err) {
        this._logger.warn({ err, sessionUid }, 'failed to send to socket');
      }
    };

    const clearAuthTimer = () => {
      if (authTimer !== null) {
        clearTimeout(authTimer);
        authTimer = null;
      }
    };

    const closeWith = (code: number, reason: string) => {
      if (closed) return;
      closed = true;
      clearAuthTimer();
      try {
        socket.close(code, reason);
      } catch (err) {
        this._logger.warn({ err, sessionUid }, 'failed to close socket');
      }
      service?.close();
    };

    authTimer = setTimeout(() => {
      if (ready || closed) return;
      closeWith(1008, 'auth-timeout');
    }, AUTH_TIMEOUT_MS);

    const handleAuth = async (token: string) => {
      // Idempotent: a duplicate auth message after the first succeeded - or
      // while one is already being verified - is silently ignored.
      if (ready || authInFlight) return;
      authInFlight = true;

      const result = verifyAuth(
        role,
        sessionUid,
        token,
        this._sessionTokenService,
      );
      if (!result.ok) {
        authInFlight = false;
        closeWith(result.code, result.reason);
        return;
      }

      service = new TranscriptionStreamService({
        role,
        sessionUid,
        eventBusService: this._eventBusService,
        transcriptionOrchestratorService:
          this._transcriptionOrchestratorService,
      });
      service.on('send', (msg) => {
        safeSend(msg);
      });
      service.on('close', (code, reason) => {
        closeWith(code, reason);
      });

      try {
        await service.start();
      } catch (err) {
        authInFlight = false;
        this._logger.error({ err, sessionUid }, 'orchestrator register failed');
        closeWith(1011, 'orchestrator-unavailable');
        return;
      }
      // The socket may have closed while we awaited orchestrator
      // registration; service.start() has already released its registration
      // in that case, so we just bail before flipping the ready flag.
      if (closed) {
        authInFlight = false;
        return;
      }

      ready = true;
      authInFlight = false;
      clearAuthTimer();

      safeSend({ type: TranscriptionStreamServerMessageType.AUTH_OK });
      service.publishCurrentStatus();
    };

    socket.on('close', () => {
      if (closed) return;
      closed = true;
      clearAuthTimer();
      service?.close();
    });

    socket.on('error', (err) => {
      this._logger.warn(
        { err, sessionUid },
        'transcription-stream socket error',
      );
    });

    socket.on('message', (data, isBinary) => {
      if (closed) return;

      if (isBinary) {
        if (role !== 'source') {
          closeWith(1008, 'binary-not-allowed-for-role');
          return;
        }
        if (!ready) {
          closeWith(1008, 'binary-before-auth');
          return;
        }
        const buffer = Buffer.isBuffer(data)
          ? data
          : Buffer.from(data as ArrayBuffer);
        service?.handleBinary(buffer);
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
        closeWith(1007, 'invalid-json');
        return;
      }
      if (!Value.Check(TRANSCRIPTION_STREAM_SCHEMA.clientMessage, parsed)) {
        closeWith(1007, 'invalid-message');
        return;
      }

      // The schema currently has a single `auth` client-message variant, so
      // we dispatch directly. When new variants are added, switch on
      // `parsed.type` and route accordingly.
      void handleAuth(parsed.sessionToken);
    });
  }
}
