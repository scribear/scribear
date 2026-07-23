import type { FastifyRequest } from 'fastify';
import { Value } from 'typebox/value';
import type WebSocket from 'ws';

import {
  TRANSCRIPTION_STREAM_SCHEMA,
  TranscriptionStreamClientMessageType,
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
  private _metrics: AppDependencies['nodeServerMetricsService'];

  constructor(
    logger: AppDependencies['logger'],
    sessionTokenService: AppDependencies['sessionTokenService'],
    eventBusService: AppDependencies['eventBusService'],
    transcriptionOrchestratorService: AppDependencies['transcriptionOrchestratorService'],
    nodeServerMetricsService: AppDependencies['nodeServerMetricsService'],
  ) {
    this._logger = logger;
    this._sessionTokenService = sessionTokenService;
    this._eventBusService = eventBusService;
    this._transcriptionOrchestratorService = transcriptionOrchestratorService;
    this._metrics = nodeServerMetricsService;
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
      // Observability: the close code/reason is the only signal distinguishing
      // an auth rejection (1008 invalid-token) from a protocol error (1007)
      // from an orchestrator outage (1011). Logged at info so the monitoring
      // sidecar can tally close codes without raising node-server's log level.
      this._metrics.recordWsClose(code, reason, role, 'server');
      this._logger.info(
        { sessionUid, role, code, reason },
        'transcription-stream socket closed',
      );
      try {
        socket.close(code, reason);
      } catch (err) {
        this._logger.warn({ err, sessionUid }, 'failed to close socket');
      }
      service?.close();
    };

    authTimer = setTimeout(() => {
      if (ready || closed) return;
      this._metrics.recordAuthTimeout();
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
        // S2 (signing-key drift between session-manager and node-server) shows
        // up as this rate approaching 100%, not as any single failure, so the
        // success side is counted too - see recordAuthSuccess below.
        this._metrics.recordAuthFailure(result.reason);
        closeWith(result.code, result.reason);
        return;
      }

      service = new TranscriptionStreamService({
        role,
        sessionUid,
        eventBusService: this._eventBusService,
        transcriptionOrchestratorService:
          this._transcriptionOrchestratorService,
        nodeServerMetricsService: this._metrics,
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
        this._metrics.recordOrchestratorFailure();
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
      this._metrics.recordAuthSuccess();

      safeSend({ type: TranscriptionStreamServerMessageType.AUTH_OK });
      service.publishCurrentStatus();
    };

    socket.on('close', (code: number, reason: Buffer) => {
      if (closed) return;
      closed = true;
      clearAuthTimer();
      // Peer-initiated close (client navigated away, Wi-Fi dropped). Distinct
      // from closeWith above, which is server-initiated; the sidecar separates
      // the two by `initiator` so a flapping uplink doesn't look like an auth
      // failure.
      this._metrics.recordWsClose(code, reason.toString(), role, 'peer');
      this._logger.info(
        { sessionUid, role, code, reason: reason.toString() },
        'transcription-stream socket closed by peer',
      );
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

      switch (parsed.type) {
        case TranscriptionStreamClientMessageType.AUTH:
          void handleAuth(parsed.sessionToken);
          break;
        case TranscriptionStreamClientMessageType.TIME_SYNC_PING:
          // Reply immediately with our clock so the source can estimate the
          // offset (Cristian's algorithm). Deliberately not gated on auth: it
          // exposes only the server's wall clock and lets the source begin
          // syncing as early as possible. `t1` is read as late as possible.
          safeSend({
            type: TranscriptionStreamServerMessageType.TIME_SYNC_PONG,
            t0: parsed.t0,
            t1: Date.now(),
          });
          break;
      }
    });
  }
}
