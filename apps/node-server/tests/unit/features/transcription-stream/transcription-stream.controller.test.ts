import { type Mock, afterEach, beforeEach, describe, expect, vi } from 'vitest';

import { TranscriptionStreamController } from '#src/server/features/transcription-stream/transcription-stream.controller.js';
import { type MockLogger, createMockLogger } from '#tests/utils/mock-logger.js';

interface MockService {
  start: Mock;
  close: Mock;
  handleBinary: Mock;
  publishCurrentStatus: Mock;
  on: (event: string, cb: (...args: unknown[]) => void) => void;
  emit: (event: string, ...args: unknown[]) => void;
}

const {
  verifyAuthMock,
  MockTranscriptionStreamService,
  serviceInstances,
  setStartAutoResolve,
  setStartPending,
  setStartReject,
} = vi.hoisted(() => {
  const verifyAuthMock = vi.fn();
  const serviceInstances: MockService[] = [];
  let startPromise: Promise<void> = Promise.resolve();
  const setStartAutoResolve = (): void => {
    startPromise = Promise.resolve();
  };
  const setStartPending = (): (() => void) => {
    let resolve!: () => void;
    startPromise = new Promise<void>((r) => {
      resolve = r;
    });
    return resolve;
  };
  const setStartReject = (err: Error): void => {
    startPromise = Promise.reject(err);
  };

  class MockTranscriptionStreamService {
    start = vi.fn((): Promise<void> => startPromise);
    close = vi.fn();
    handleBinary = vi.fn();
    publishCurrentStatus = vi.fn();
    private _handlers: Record<string, ((...args: unknown[]) => void)[]> = {};

    on(event: string, cb: (...args: unknown[]) => void): void {
      (this._handlers[event] ??= []).push(cb);
    }

    emit(event: string, ...args: unknown[]): void {
      for (const cb of this._handlers[event] ?? []) {
        cb(...args);
      }
    }

    constructor() {
      serviceInstances.push(this);
    }
  }

  return {
    verifyAuthMock,
    MockTranscriptionStreamService,
    serviceInstances,
    setStartAutoResolve,
    setStartPending,
    setStartReject,
  };
});

vi.mock('#src/server/features/transcription-stream/transcription-stream.auth.js', () => ({
  verifyAuth: verifyAuthMock,
}));

vi.mock('#src/server/features/transcription-stream/transcription-stream.service.js', () => ({
  TranscriptionStreamService: MockTranscriptionStreamService,
}));

const SESSION_UID = 'test-session-uid';
const FAKE_NOW = new Date('2025-01-01T00:00:00.000Z').getTime();
const AUTH_OK = JSON.stringify({ type: 'authOk' });

type CloseHandler = (code: number, reason: Buffer) => void;
type ErrorHandler = (err: Error) => void;
type MessageHandler = (data: unknown, isBinary: boolean) => void;

interface SocketHandlers {
  close: CloseHandler;
  error: ErrorHandler;
  message: MessageHandler;
}

interface SocketMock {
  on: Mock;
  send: Mock;
  close: Mock;
}

interface Harness {
  controller: TranscriptionStreamController;
  socket: SocketMock;
  handlers: SocketHandlers;
  metrics: ReturnType<typeof makeMetrics>;
  logger: MockLogger;
  role: 'source' | 'client';
}

function makeSocket(): { socket: SocketMock; handlers: SocketHandlers } {
  const handlers: SocketHandlers = {
    close: () => undefined,
    error: () => undefined,
    message: () => undefined,
  };
  const socket: SocketMock = {
    on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
      if (event === 'close') handlers.close = cb;
      else if (event === 'error') handlers.error = cb;
      else if (event === 'message') handlers.message = cb;
    }),
    send: vi.fn(),
    close: vi.fn(),
  };
  return { socket, handlers };
}

function makeMetrics() {
  return {
    recordWsClose: vi.fn(),
    recordAuthTimeout: vi.fn(),
    recordAuthFailure: vi.fn(),
    recordAuthSuccess: vi.fn(),
    recordOrchestratorFailure: vi.fn(),
    recordConnectionOpen: vi.fn(),
    recordConnectionClose: vi.fn(),
    recordBinaryBeforeAuthDrop: vi.fn(),
  };
}

function makeHarness(role: 'source' | 'client' = 'source'): Harness {
  verifyAuthMock.mockReturnValue({ ok: true });
  const logger = createMockLogger();
  const metrics = makeMetrics();
  const { socket, handlers } = makeSocket();
  const controller = new TranscriptionStreamController(
    logger as never,
    { verify: vi.fn() } as never,
    {} as never,
    {} as never,
    metrics as never,
  );
  const request = { params: { sessionUid: SESSION_UID } } as never;
  if (role === 'source') {
    controller.handleSourceConnection(socket as never, request);
  } else {
    controller.handleClientConnection(socket as never, request);
  }
  return { controller, socket, handlers, metrics, logger, role };
}

function sendAuth(h: Harness, token = 'good-token'): void {
  h.handlers.message(JSON.stringify({ type: 'auth', sessionToken: token }), false);
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('TranscriptionStreamController', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: FAKE_NOW });
    verifyAuthMock.mockReset();
    serviceInstances.length = 0;
    setStartAutoResolve();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('auth flow', (it) => {
    it('sends AUTH_OK, starts the service, publishes status, and records success on a valid source auth', async () => {
      const h = makeHarness('source');
      sendAuth(h);
      await flush();

      expect(verifyAuthMock).toHaveBeenCalledWith(
        'source',
        SESSION_UID,
        'good-token',
        expect.anything(),
      );
      expect(h.socket.send).toHaveBeenCalledWith(AUTH_OK);
      const service = serviceInstances[0]!;
      expect(service.start).toHaveBeenCalledTimes(1);
      expect(service.publishCurrentStatus).toHaveBeenCalledTimes(1);
      expect(h.metrics.recordAuthSuccess).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(5001);
      expect(h.metrics.recordAuthTimeout).not.toHaveBeenCalled();
    });

    it('sends AUTH_OK and records success on a valid client auth', async () => {
      const h = makeHarness('client');
      sendAuth(h);
      await flush();

      expect(verifyAuthMock).toHaveBeenCalledWith(
        'client',
        SESSION_UID,
        'good-token',
        expect.anything(),
      );
      expect(h.socket.send).toHaveBeenCalledWith(AUTH_OK);
      expect(serviceInstances[0]!.start).toHaveBeenCalledTimes(1);
      expect(h.metrics.recordAuthSuccess).toHaveBeenCalledTimes(1);
    });

    it('closes with the failure code/reason and records the failure on an invalid token', async () => {
      const h = makeHarness('source');
      verifyAuthMock.mockReturnValue({
        ok: false,
        code: 1008,
        reason: 'invalid-token',
      });
      sendAuth(h);
      await flush();

      expect(h.metrics.recordAuthFailure).toHaveBeenCalledWith('invalid-token');
      expect(h.socket.close).toHaveBeenCalledWith(1008, 'invalid-token');
      expect(h.metrics.recordWsClose).toHaveBeenCalledWith(
        1008,
        'invalid-token',
        'source',
        'server',
      );
      expect(h.socket.send).not.toHaveBeenCalled();
      expect(serviceInstances).toHaveLength(0);
    });

    it('closes with 1008 auth-timeout and records the timeout when no auth arrives in time', () => {
      const h = makeHarness('source');
      vi.advanceTimersByTime(5001);

      expect(h.metrics.recordAuthTimeout).toHaveBeenCalledTimes(1);
      expect(h.socket.close).toHaveBeenCalledWith(1008, 'auth-timeout');
      expect(h.metrics.recordWsClose).toHaveBeenCalledWith(
        1008,
        'auth-timeout',
        'source',
        'server',
      );
    });

    it('ignores a duplicate auth message after a successful auth', async () => {
      const h = makeHarness('source');
      sendAuth(h);
      await flush();
      expect(verifyAuthMock).toHaveBeenCalledTimes(1);

      sendAuth(h);
      await flush();

      expect(verifyAuthMock).toHaveBeenCalledTimes(1);
      expect(serviceInstances[0]!.start).toHaveBeenCalledTimes(1);
      expect(h.metrics.recordAuthSuccess).toHaveBeenCalledTimes(1);
    });

    it('ignores an auth message that arrives while another auth is being verified', async () => {
      const resolveStart = setStartPending();
      const h = makeHarness('source');
      sendAuth(h);

      sendAuth(h);

      expect(verifyAuthMock).toHaveBeenCalledTimes(1);

      resolveStart();
      await flush();

      expect(h.socket.send).toHaveBeenCalledWith(AUTH_OK);
      expect(serviceInstances[0]!.start).toHaveBeenCalledTimes(1);
    });
  });

  describe('orchestrator failure', (it) => {
    it('records an orchestrator failure and closes 1011 when service.start() throws', async () => {
      setStartReject(new Error('orchestrator-down'));
      const h = makeHarness('source');
      sendAuth(h);
      await flush();

      expect(h.metrics.recordOrchestratorFailure).toHaveBeenCalledTimes(1);
      expect(h.socket.close).toHaveBeenCalledWith(
        1011,
        'orchestrator-unavailable',
      );
      expect(h.metrics.recordWsClose).toHaveBeenCalledWith(
        1011,
        'orchestrator-unavailable',
        'source',
        'server',
      );
      expect(h.socket.send).not.toHaveBeenCalled();
      expect(h.metrics.recordAuthSuccess).not.toHaveBeenCalled();
    });

    it('does not flip ready or send AUTH_OK when the socket closes during service.start()', async () => {
      const resolveStart = setStartPending();
      const h = makeHarness('source');
      sendAuth(h);

      h.handlers.close(1000, Buffer.from('peer-left'));

      resolveStart();
      await flush();

      expect(h.socket.send).not.toHaveBeenCalledWith(AUTH_OK);
      expect(h.metrics.recordAuthSuccess).not.toHaveBeenCalled();
      expect(serviceInstances[0]!.close).toHaveBeenCalledTimes(1);
      expect(h.metrics.recordWsClose).toHaveBeenCalledWith(
        1000,
        'peer-left',
        'source',
        'peer',
      );
    });
  });

  describe('message handling', (it) => {
    it('forwards binary frames from a source to service.handleBinary after auth', async () => {
      const h = makeHarness('source');
      sendAuth(h);
      await flush();

      const frame = Buffer.from([1, 2, 3]);
      h.handlers.message(frame, true);

      expect(serviceInstances[0]!.handleBinary).toHaveBeenCalledWith(frame);
    });

    it('forwards binary frames delivered as an ArrayBuffer by coercing them to a Buffer', async () => {
      const h = makeHarness('source');
      sendAuth(h);
      await flush();

      const ab = new Uint8Array([1, 2, 3]).buffer;
      h.handlers.message(ab, true);

      expect(serviceInstances[0]!.handleBinary).toHaveBeenCalledWith(
        Buffer.from([1, 2, 3]),
      );
    });

    it('parses a text message delivered as a Buffer', () => {
      const h = makeHarness('source');
      const t0 = 42;
      const buf = Buffer.from(
        JSON.stringify({ type: 'timeSyncPing', t0 }),
        'utf8',
      );
      h.handlers.message(buf, false);

      expect(h.socket.send).toHaveBeenCalledWith(
        JSON.stringify({ type: 'timeSyncPong', t0, t1: FAKE_NOW }),
      );
    });

    it('parses a text message delivered as an ArrayBuffer', () => {
      const h = makeHarness('source');
      const t0 = 7;
      const ab = new TextEncoder().encode(
        JSON.stringify({ type: 'timeSyncPing', t0 }),
      ).buffer;
      h.handlers.message(ab, false);

      expect(h.socket.send).toHaveBeenCalledWith(
        JSON.stringify({ type: 'timeSyncPong', t0, t1: FAKE_NOW }),
      );
    });

    it('closes with 1008 binary-not-allowed-for-role when a client sends a binary frame', () => {
      const h = makeHarness('client');
      h.handlers.message(Buffer.from([1]), true);

      expect(h.socket.close).toHaveBeenCalledWith(
        1008,
        'binary-not-allowed-for-role',
      );
      expect(h.metrics.recordWsClose).toHaveBeenCalledWith(
        1008,
        'binary-not-allowed-for-role',
        'client',
        'server',
      );
    });

    it('drops pre-auth binary without closing and counts it (H1)', () => {
      const h = makeHarness('source');
      h.handlers.message(Buffer.from([1]), true);

      // Old behaviour closed 1008 `binary-before-auth` and reconnect-looped
      // the kiosk; new behaviour drops the worthless pre-auth frame and lets
      // the socket live to complete auth, after which audio flows.
      expect(h.socket.close).not.toHaveBeenCalled();
      expect(h.metrics.recordBinaryBeforeAuthDrop).toHaveBeenCalledTimes(1);
      // The drop must NOT be double-counted as a ws close.
      expect(h.metrics.recordWsClose).not.toHaveBeenCalled();
    });

    it('closes with 1007 invalid-json when a text message is not valid JSON', () => {
      const h = makeHarness('source');
      h.handlers.message('not-json{', false);

      expect(h.socket.close).toHaveBeenCalledWith(1007, 'invalid-json');
      expect(h.metrics.recordWsClose).toHaveBeenCalledWith(
        1007,
        'invalid-json',
        'source',
        'server',
      );
    });

    it('closes with 1007 invalid-message when a text message fails schema validation', () => {
      const h = makeHarness('source');
      h.handlers.message(JSON.stringify({ type: 'unknown' }), false);

      expect(h.socket.close).toHaveBeenCalledWith(1007, 'invalid-message');
      expect(h.metrics.recordWsClose).toHaveBeenCalledWith(
        1007,
        'invalid-message',
        'source',
        'server',
      );
    });

    it('replies with timeSyncPong (t0 echoed, t1=now) for a timeSyncPing before auth', () => {
      const h = makeHarness('source');
      const t0 = 12345;
      h.handlers.message(JSON.stringify({ type: 'timeSyncPing', t0 }), false);

      expect(h.socket.send).toHaveBeenCalledWith(
        JSON.stringify({ type: 'timeSyncPong', t0, t1: FAKE_NOW }),
      );
    });

    it('still replies to timeSyncPing after auth', async () => {
      const h = makeHarness('source');
      sendAuth(h);
      await flush();

      const t0 = 67890;
      h.handlers.message(JSON.stringify({ type: 'timeSyncPing', t0 }), false);

      expect(h.socket.send).toHaveBeenCalledWith(
        JSON.stringify({ type: 'timeSyncPong', t0, t1: FAKE_NOW }),
      );
    });
  });

  describe('socket lifecycle', (it) => {
    it('records a peer-initiated close and closes the service when one exists', async () => {
      const h = makeHarness('source');
      sendAuth(h);
      await flush();

      const service = serviceInstances[0]!;
      h.handlers.close(1000, Buffer.from('peer-left'));

      expect(h.metrics.recordWsClose).toHaveBeenCalledWith(
        1000,
        'peer-left',
        'source',
        'peer',
      );
      expect(service.close).toHaveBeenCalledTimes(1);
    });

    it('logs a socket error but does not close the socket', () => {
      const h = makeHarness('source');
      const err = new Error('socket boom');
      h.handlers.error(err);

      expect(h.logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ err, sessionUid: SESSION_UID }),
        'transcription-stream socket error',
      );
      expect(h.socket.close).not.toHaveBeenCalled();
    });

    it('records a server-initiated close with initiator=server via closeWith', () => {
      const h = makeHarness('source');
      h.handlers.message('not-json', false);

      expect(h.metrics.recordWsClose).toHaveBeenCalledWith(
        1007,
        'invalid-json',
        'source',
        'server',
      );
    });

    it('ignores a peer close that arrives after the socket is already closed', () => {
      const h = makeHarness('source');
      h.handlers.message('not-json', false);

      h.handlers.close(1000, Buffer.from('peer-left'));

      expect(h.metrics.recordWsClose).toHaveBeenCalledTimes(1);
      expect(h.metrics.recordWsClose).not.toHaveBeenCalledWith(
        1000,
        'peer-left',
        'source',
        'peer',
      );
    });

    it('ignores messages that arrive after the socket is closed', () => {
      const h = makeHarness('source');
      h.handlers.message('not-json', false);

      h.handlers.message(
        JSON.stringify({ type: 'timeSyncPing', t0: 1 }),
        false,
      );

      expect(h.socket.send).not.toHaveBeenCalled();
    });

    it('logs a warning but still closes the service when socket.close itself throws', () => {
      const h = makeHarness('source');
      h.socket.close.mockImplementation(() => {
        throw new Error('close failed');
      });
      h.handlers.message('not-json', false);

      expect(h.logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          err: expect.any(Error),
          sessionUid: SESSION_UID,
        }),
        'failed to close socket',
      );
      expect(h.metrics.recordWsClose).toHaveBeenCalledWith(
        1007,
        'invalid-json',
        'source',
        'server',
      );
    });
  });

  describe('service event forwarding', (it) => {
    it('forwards service send events to the socket via safeSend', async () => {
      const h = makeHarness('source');
      sendAuth(h);
      await flush();

      const msg = { type: 'sessionEnded' };
      serviceInstances[0]!.emit('send', msg);

      expect(h.socket.send).toHaveBeenCalledWith(JSON.stringify(msg));
    });

    it('closes the socket via closeWith when the service emits close', async () => {
      const h = makeHarness('source');
      sendAuth(h);
      await flush();

      const service = serviceInstances[0]!;
      service.emit('close', 1000, 'session-ended');

      expect(h.socket.close).toHaveBeenCalledWith(1000, 'session-ended');
      expect(h.metrics.recordWsClose).toHaveBeenCalledWith(
        1000,
        'session-ended',
        'source',
        'server',
      );
      expect(service.close).toHaveBeenCalledTimes(1);
    });

    it('is idempotent when the service emits close more than once', async () => {
      const h = makeHarness('source');
      sendAuth(h);
      await flush();

      const service = serviceInstances[0]!;
      service.emit('close', 1000, 'session-ended');
      service.emit('close', 1000, 'session-ended');

      expect(h.metrics.recordWsClose).toHaveBeenCalledTimes(1);
      expect(h.socket.close).toHaveBeenCalledTimes(1);
    });
  });

  describe('metrics', (it) => {
    it('swallows socket.send errors in safeSend and logs a warning', () => {
      const h = makeHarness('source');
      h.socket.send.mockImplementation(() => {
        throw new Error('socket gone');
      });
      h.handlers.message(JSON.stringify({ type: 'timeSyncPing', t0: 1 }), false);

      expect(h.logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          err: expect.any(Error),
          sessionUid: SESSION_UID,
        }),
        'failed to send to socket',
      );
      expect(h.socket.close).not.toHaveBeenCalled();
    });
  });
});
