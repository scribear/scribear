import { Type } from 'typebox';
import {
  type MockInstance,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import { ConnectionError, SchemaValidationError } from '#src/errors.js';
import { WebSocketClient } from '#src/websocket-client.js';

interface MockWsInstance {
  url: string;
  onopen: ((event: { type: string }) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number; reason: string }) => void) | null;
  onerror: ((event: { error: unknown; message: string }) => void) | null;
  send: MockInstance;
  close: MockInstance;
  bufferedAmount: number;
}

let mockWsInstances: MockWsInstance[];

vi.mock('isomorphic-ws', () => {
  class MockWebSocket {
    url: string;
    onopen: MockWsInstance['onopen'] = null;
    onmessage: MockWsInstance['onmessage'] = null;
    onclose: MockWsInstance['onclose'] = null;
    onerror: MockWsInstance['onerror'] = null;
    send = vi.fn();
    close = vi.fn();
    bufferedAmount = 0;

    constructor(url: string) {
      this.url = url;
      mockWsInstances.push(this as unknown as MockWsInstance);
    }
  }
  return { default: MockWebSocket };
});

enum ClientMsgType {
  PING = 'ping',
  AUTH = 'auth',
}

enum ServerMsgType {
  PONG = 'pong',
  AUTH_OK = 'auth-ok',
}

const TEST_SCHEMA = {
  description: 'Test WebSocket route',
  tags: [],
  allowClientBinaryMessage: false,
  clientMessage: Type.Union([
    Type.Object({ type: Type.Literal(ClientMsgType.PING) }),
    Type.Object({
      type: Type.Literal(ClientMsgType.AUTH),
      token: Type.String(),
    }),
  ]),
  allowServerBinaryMessage: true,
  serverMessage: Type.Union([
    Type.Object({
      type: Type.Literal(ServerMsgType.PONG),
      value: Type.Number(),
    }),
    Type.Object({ type: Type.Literal(ServerMsgType.AUTH_OK) }),
  ]),
  closeCodes: {
    1000: { description: 'Normal' },
    1006: { description: 'Abnormal' },
    4001: { description: 'Custom' },
  },
};

const TEST_ROUTE = {
  method: 'GET' as const,
  websocket: true,
  url: '/ws/:room',
};

const BASE_URL = 'http://localhost:3000';

/**
 * @returns The most-recently created mock socket.
 */
function currentSocket(): MockWsInstance {
  const sock = mockWsInstances[mockWsInstances.length - 1];
  if (sock === undefined) throw new Error('no socket created');
  return sock;
}

describe('WebSocketClient', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockWsInstances = [];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('transitions IDLE -> CONNECTING -> OPEN on successful open with no handshake', () => {
    // Arrange
    const client = new WebSocketClient({
      schema: TEST_SCHEMA,
      route: TEST_ROUTE,
      baseUrl: BASE_URL,
      params: { params: { room: 'r1' } },
    });
    const states: string[] = [];
    client.on('stateChange', (next) => states.push(next));

    // Act
    client.start();
    currentSocket().onopen!({ type: 'open' });

    // Assert
    expect(states).toEqual(['CONNECTING', 'HANDSHAKING', 'OPEN']);
    expect(client.state).toBe('OPEN');
  });

  it('runs onHandshake after open and only transitions to OPEN when it resolves', async () => {
    // Arrange
    let resolveHandshake!: () => void;
    const handshakePromise = new Promise<void>((resolve) => {
      resolveHandshake = resolve;
    });
    const client = new WebSocketClient({
      schema: TEST_SCHEMA,
      route: TEST_ROUTE,
      baseUrl: BASE_URL,
      params: { params: { room: 'r1' } },
      onHandshake: async ({ send }) => {
        send({ type: ClientMsgType.AUTH, token: 't' });
        await handshakePromise;
      },
    });
    const openHandler = vi.fn();
    client.on('open', openHandler);

    // Act
    client.start();
    currentSocket().onopen!({ type: 'open' });
    await vi.waitFor(() => {
      expect(currentSocket().send).toHaveBeenCalledWith(
        JSON.stringify({ type: 'auth', token: 't' }),
      );
    });

    // Assert - still handshaking
    expect(client.state).toBe('HANDSHAKING');
    expect(openHandler).not.toHaveBeenCalled();

    // Act - handshake resolves
    resolveHandshake();
    await vi.waitFor(() => {
      expect(client.state).toBe('OPEN');
    });

    // Assert
    expect(openHandler).toHaveBeenCalledOnce();
  });

  it('reconnects after abnormal close with exponential backoff', () => {
    // Arrange
    const client = new WebSocketClient({
      schema: TEST_SCHEMA,
      route: TEST_ROUTE,
      baseUrl: BASE_URL,
      params: { params: { room: 'r1' } },
      backoff: { initialMs: 100, maxMs: 1000, factor: 2, jitterPct: 0 },
    });

    // Act - open and immediately get abnormal close
    client.start();
    currentSocket().onopen!({ type: 'open' });
    expect(client.state).toBe('OPEN');
    currentSocket().onclose!({ code: 1006, reason: 'lost' });

    // Assert - moved to WAITING_RETRY
    expect(client.state).toBe('WAITING_RETRY');
    expect(client.attempt).toBe(1);

    // Act - advance past first backoff (100ms with 0 jitter)
    vi.advanceTimersByTime(100);

    // Assert - a new socket was created
    expect(mockWsInstances.length).toBe(2);
    expect(client.state).toBe('CONNECTING');
  });

  it('emits close with reconnectInMs=null on normal close code (1000) and does not reconnect', () => {
    // Arrange
    const client = new WebSocketClient({
      schema: TEST_SCHEMA,
      route: TEST_ROUTE,
      baseUrl: BASE_URL,
      params: { params: { room: 'r1' } },
    });

    // Act
    client.start();
    currentSocket().onopen!({ type: 'open' });
    const closeHandler = vi.fn();
    client.on('close', closeHandler);
    currentSocket().onclose!({ code: 1000, reason: 'bye' });

    // Assert
    expect(client.state).toBe('CLOSED');
    expect(closeHandler).toHaveBeenCalledWith(1000, 'bye', null);
  });

  it('emits close with reconnectInMs set when a reconnect is scheduled', () => {
    // Arrange - zero-jitter backoff so the delay is deterministic.
    const client = new WebSocketClient({
      schema: TEST_SCHEMA,
      route: TEST_ROUTE,
      baseUrl: BASE_URL,
      params: { params: { room: 'r1' } },
      backoff: { initialMs: 250, maxMs: 250, factor: 1, jitterPct: 0 },
    });

    // Act
    client.start();
    currentSocket().onopen!({ type: 'open' });
    const closeHandler = vi.fn();
    client.on('close', closeHandler);
    currentSocket().onclose!({ code: 1006, reason: 'lost' });

    // Assert
    expect(closeHandler).toHaveBeenCalledWith(1006, 'lost', 250);
  });

  it('buffers sends while not OPEN and flushes on open', () => {
    // Arrange
    const client = new WebSocketClient({
      schema: TEST_SCHEMA,
      route: TEST_ROUTE,
      baseUrl: BASE_URL,
      params: { params: { room: 'r1' } },
    });

    // Act - queue a message before opening
    client.start();
    client.send({ type: ClientMsgType.PING });

    // Assert - nothing sent yet
    expect(currentSocket().send).not.toHaveBeenCalled();

    // Act - open, which triggers flush
    currentSocket().onopen!({ type: 'open' });

    // Assert - flushed
    expect(currentSocket().send).toHaveBeenCalledWith(
      JSON.stringify({ type: 'ping' }),
    );
  });

  it('drops oldest when the send queue exceeds its limit under drop-oldest', () => {
    // Arrange
    const client = new WebSocketClient({
      schema: TEST_SCHEMA,
      route: TEST_ROUTE,
      baseUrl: BASE_URL,
      params: { params: { room: 'r1' } },
      sendQueueLimit: 2,
      sendQueueOverflow: 'drop-oldest',
    });

    // Act - enqueue 3 while not open
    client.start();
    client.send({ type: ClientMsgType.PING });
    client.send({ type: ClientMsgType.AUTH, token: 'A' });
    client.send({ type: ClientMsgType.AUTH, token: 'B' });
    currentSocket().onopen!({ type: 'open' });

    // Assert - the earliest PING was dropped, remaining two flushed in order
    expect(currentSocket().send).toHaveBeenCalledTimes(2);
    expect(currentSocket().send).toHaveBeenNthCalledWith(
      1,
      JSON.stringify({ type: 'auth', token: 'A' }),
    );
    expect(currentSocket().send).toHaveBeenNthCalledWith(
      2,
      JSON.stringify({ type: 'auth', token: 'B' }),
    );
  });

  it('stops reconnecting after terminate() and transitions to CLOSED', () => {
    // Arrange
    const client = new WebSocketClient({
      schema: TEST_SCHEMA,
      route: TEST_ROUTE,
      baseUrl: BASE_URL,
      params: { params: { room: 'r1' } },
      backoff: { initialMs: 100, maxMs: 1000, factor: 2, jitterPct: 0 },
    });
    client.start();
    currentSocket().onopen!({ type: 'open' });
    currentSocket().onclose!({ code: 1006, reason: 'lost' });
    expect(client.state).toBe('WAITING_RETRY');

    // Act - terminate before the retry fires
    client.terminate(1000);

    // Assert - no new sockets after timer advance
    vi.advanceTimersByTime(10_000);
    expect(mockWsInstances.length).toBe(1);
    expect(client.state).toBe('CLOSED');
  });

  it('sendBinary sends the payload immediately when OPEN', () => {
    // Arrange
    const client = new WebSocketClient({
      schema: TEST_SCHEMA,
      route: TEST_ROUTE,
      baseUrl: BASE_URL,
      params: { params: { room: 'r1' } },
    });
    client.start();
    currentSocket().onopen!({ type: 'open' });
    const data = new ArrayBuffer(4);

    // Act
    client.sendBinary(data);

    // Assert
    expect(currentSocket().send).toHaveBeenCalledWith(data);
  });

  it('buffers sendBinary while not OPEN and flushes on open', () => {
    // Arrange
    const client = new WebSocketClient({
      schema: TEST_SCHEMA,
      route: TEST_ROUTE,
      baseUrl: BASE_URL,
      params: { params: { room: 'r1' } },
    });
    client.start();
    const data = new ArrayBuffer(4);

    // Act
    client.sendBinary(data);

    // Assert - not sent yet
    expect(currentSocket().send).not.toHaveBeenCalled();

    // Act - open triggers flush
    currentSocket().onopen!({ type: 'open' });

    // Assert
    expect(currentSocket().send).toHaveBeenCalledWith(data);
  });

  it('drops the newest message silently when the queue is full under drop-newest policy', () => {
    // Arrange
    const client = new WebSocketClient({
      schema: TEST_SCHEMA,
      route: TEST_ROUTE,
      baseUrl: BASE_URL,
      params: { params: { room: 'r1' } },
      sendQueueLimit: 2,
      sendQueueOverflow: 'drop-newest',
    });
    client.start();

    // Act - enqueue 3 while not open; third should be dropped
    client.send({ type: ClientMsgType.AUTH, token: 'A' });
    client.send({ type: ClientMsgType.AUTH, token: 'B' });
    client.send({ type: ClientMsgType.AUTH, token: 'C' });
    currentSocket().onopen!({ type: 'open' });

    // Assert - A and B flushed, C was silently dropped
    expect(currentSocket().send).toHaveBeenCalledTimes(2);
    expect(currentSocket().send).toHaveBeenNthCalledWith(
      1,
      JSON.stringify({ type: 'auth', token: 'A' }),
    );
    expect(currentSocket().send).toHaveBeenNthCalledWith(
      2,
      JSON.stringify({ type: 'auth', token: 'B' }),
    );
  });

  it('emits error and drops the message when the queue is full under error overflow policy', () => {
    // Arrange
    const client = new WebSocketClient({
      schema: TEST_SCHEMA,
      route: TEST_ROUTE,
      baseUrl: BASE_URL,
      params: { params: { room: 'r1' } },
      sendQueueLimit: 1,
      sendQueueOverflow: 'error',
    });
    client.start();
    const errorHandler = vi.fn();
    client.on('error', errorHandler);

    // Act - fill queue then overflow
    client.send({ type: ClientMsgType.PING });
    client.send({ type: ClientMsgType.PING });

    // Assert
    expect(errorHandler).toHaveBeenCalledWith(expect.any(Error));
  });

  it('silently drops sends and does not error when sendQueueLimit is 0 without error policy', () => {
    // Arrange
    const client = new WebSocketClient({
      schema: TEST_SCHEMA,
      route: TEST_ROUTE,
      baseUrl: BASE_URL,
      params: { params: { room: 'r1' } },
      sendQueueLimit: 0,
      sendQueueOverflow: 'drop-oldest',
    });
    client.start();
    const errorHandler = vi.fn();
    client.on('error', errorHandler);

    // Act
    client.send({ type: ClientMsgType.PING });
    currentSocket().onopen!({ type: 'open' });

    // Assert - nothing sent, no error emitted
    expect(currentSocket().send).not.toHaveBeenCalled();
    expect(errorHandler).not.toHaveBeenCalled();
  });

  it('emits error on send when sendQueueLimit is 0 with error overflow policy', () => {
    // Arrange
    const client = new WebSocketClient({
      schema: TEST_SCHEMA,
      route: TEST_ROUTE,
      baseUrl: BASE_URL,
      params: { params: { room: 'r1' } },
      sendQueueLimit: 0,
      sendQueueOverflow: 'error',
    });
    client.start();
    const errorHandler = vi.fn();
    client.on('error', errorHandler);

    // Act
    client.send({ type: ClientMsgType.PING });

    // Assert
    expect(errorHandler).toHaveBeenCalledOnce();
  });

  it('silently drops send when OPEN and bufferedAmount exceeds the high-water mark', () => {
    // Arrange
    const client = new WebSocketClient({
      schema: TEST_SCHEMA,
      route: TEST_ROUTE,
      baseUrl: BASE_URL,
      params: { params: { room: 'r1' } },
      backpressureHighWaterMark: 1024,
      sendQueueOverflow: 'drop-oldest',
    });
    client.start();
    currentSocket().onopen!({ type: 'open' });
    currentSocket().bufferedAmount = 2048;

    // Act
    client.send({ type: ClientMsgType.PING });

    // Assert
    expect(currentSocket().send).not.toHaveBeenCalled();
  });

  it('emits error on send when OPEN and bufferedAmount exceeds the high-water mark with error policy', () => {
    // Arrange
    const client = new WebSocketClient({
      schema: TEST_SCHEMA,
      route: TEST_ROUTE,
      baseUrl: BASE_URL,
      params: { params: { room: 'r1' } },
      backpressureHighWaterMark: 1024,
      sendQueueOverflow: 'error',
    });
    client.start();
    currentSocket().onopen!({ type: 'open' });
    currentSocket().bufferedAmount = 2048;
    const errorHandler = vi.fn();
    client.on('error', errorHandler);

    // Act
    client.send({ type: ClientMsgType.PING });

    // Assert
    expect(errorHandler).toHaveBeenCalledWith(expect.any(Error));
    expect(currentSocket().send).not.toHaveBeenCalled();
  });

  it('emits ConnectionError and schedules a retry on a pre-open socket error', () => {
    // Arrange
    const client = new WebSocketClient({
      schema: TEST_SCHEMA,
      route: TEST_ROUTE,
      baseUrl: BASE_URL,
      params: { params: { room: 'r1' } },
      backoff: { initialMs: 100, maxMs: 1000, factor: 1, jitterPct: 0 },
    });
    const errorHandler = vi.fn();
    client.on('error', errorHandler);

    // Act
    client.start();
    currentSocket().onerror!({ error: new Error('ECONNREFUSED'), message: '' });

    // Assert
    expect(errorHandler).toHaveBeenCalledOnce();
    expect(errorHandler).toHaveBeenCalledWith(expect.any(ConnectionError));
    expect(client.state).toBe('WAITING_RETRY');

    // Assert - reconnects after backoff
    vi.advanceTimersByTime(100);
    expect(mockWsInstances.length).toBe(2);
  });

  it('emits the socket error after OPEN without changing state', () => {
    // Arrange
    const client = new WebSocketClient({
      schema: TEST_SCHEMA,
      route: TEST_ROUTE,
      baseUrl: BASE_URL,
      params: { params: { room: 'r1' } },
    });
    client.start();
    currentSocket().onopen!({ type: 'open' });
    const errorHandler = vi.fn();
    client.on('error', errorHandler);
    const socketError = new Error('socket write error');

    // Act
    currentSocket().onerror!({ error: socketError, message: '' });

    // Assert - error forwarded, state unchanged (close event handles reconnect)
    expect(errorHandler).toHaveBeenCalledWith(socketError);
    expect(client.state).toBe('OPEN');
  });

  it('emits binaryMessage for binary frames when allowServerBinaryMessage is true', () => {
    // Arrange
    const client = new WebSocketClient({
      schema: TEST_SCHEMA, // allowServerBinaryMessage: true
      route: TEST_ROUTE,
      baseUrl: BASE_URL,
      params: { params: { room: 'r1' } },
    });
    client.start();
    currentSocket().onopen!({ type: 'open' });
    const binaryHandler = vi.fn();
    client.on('binaryMessage', binaryHandler);
    const data = new ArrayBuffer(8);

    // Act
    currentSocket().onmessage!({ data });

    // Assert
    expect(binaryHandler).toHaveBeenCalledWith(data);
  });

  it('emits SchemaValidationError for binary frames when allowServerBinaryMessage is false', () => {
    // Arrange
    const noBinarySchema = { ...TEST_SCHEMA, allowServerBinaryMessage: false };
    const client = new WebSocketClient({
      schema: noBinarySchema,
      route: TEST_ROUTE,
      baseUrl: BASE_URL,
      params: { params: { room: 'r1' } },
    });
    client.start();
    currentSocket().onopen!({ type: 'open' });
    const errorHandler = vi.fn();
    client.on('error', errorHandler);

    // Act
    currentSocket().onmessage!({ data: new ArrayBuffer(8) });

    // Assert
    expect(errorHandler).toHaveBeenCalledOnce();
    expect(errorHandler).toHaveBeenCalledWith(
      expect.any(SchemaValidationError),
    );
  });

  it('emits SchemaValidationError when the server sends invalid JSON', () => {
    // Arrange
    const client = new WebSocketClient({
      schema: TEST_SCHEMA,
      route: TEST_ROUTE,
      baseUrl: BASE_URL,
      params: { params: { room: 'r1' } },
    });
    client.start();
    currentSocket().onopen!({ type: 'open' });
    const errorHandler = vi.fn();
    client.on('error', errorHandler);

    // Act
    currentSocket().onmessage!({ data: 'not-valid-json{' });

    // Assert
    expect(errorHandler).toHaveBeenCalledOnce();
    expect(errorHandler).toHaveBeenCalledWith(
      expect.any(SchemaValidationError),
    );
  });

  it('emits SchemaValidationError when the server message does not match the schema', () => {
    // Arrange
    const client = new WebSocketClient({
      schema: TEST_SCHEMA,
      route: TEST_ROUTE,
      baseUrl: BASE_URL,
      params: { params: { room: 'r1' } },
    });
    client.start();
    currentSocket().onopen!({ type: 'open' });
    const errorHandler = vi.fn();
    client.on('error', errorHandler);

    // Act
    currentSocket().onmessage!({
      data: JSON.stringify({ type: 'unknown-type' }),
    });

    // Assert
    expect(errorHandler).toHaveBeenCalledOnce();
    expect(errorHandler).toHaveBeenCalledWith(
      expect.any(SchemaValidationError),
    );
  });

  it('emits SchemaValidationError when the server closes with an undeclared close code', () => {
    // Arrange
    const client = new WebSocketClient({
      schema: TEST_SCHEMA,
      route: TEST_ROUTE,
      baseUrl: BASE_URL,
      params: { params: { room: 'r1' } },
    });
    client.start();
    currentSocket().onopen!({ type: 'open' });
    const errorHandler = vi.fn();
    client.on('error', errorHandler);

    // Act - TEST_SCHEMA.closeCodes has 1000, 1006, 4001; use 4999 which is not declared
    currentSocket().onclose!({ code: 4999, reason: 'unknown' });

    // Assert
    expect(errorHandler).toHaveBeenCalledOnce();
    expect(errorHandler).toHaveBeenCalledWith(
      expect.any(SchemaValidationError),
    );
  });

  it('treats onHandshake rejection as a connection failure and retries', async () => {
    // Arrange - long backoff so the retry timer doesn't fire during waitFor's
    // own timer advancement while polling for the error handler.
    const handshakeError = new Error('bad token');
    const client = new WebSocketClient({
      schema: TEST_SCHEMA,
      route: TEST_ROUTE,
      baseUrl: BASE_URL,
      params: { params: { room: 'r1' } },
      onHandshake: () => Promise.reject(handshakeError),
      backoff: {
        initialMs: 60_000,
        maxMs: 60_000,
        factor: 1,
        jitterPct: 0,
      },
    });
    const errorHandler = vi.fn();
    client.on('error', errorHandler);

    // Act
    client.start();
    currentSocket().onopen!({ type: 'open' });
    await vi.waitFor(() => {
      expect(errorHandler).toHaveBeenCalledWith(handshakeError);
    });

    // Assert - we scheduled a retry and haven't yet reconnected
    expect(client.state).toBe('WAITING_RETRY');
    expect(mockWsInstances.length).toBe(1);

    // Advance past the backoff and confirm a new socket is opened
    vi.advanceTimersByTime(60_000);
    expect(mockWsInstances.length).toBe(2);
  });

  it('delivers server messages to both the handshake router and the public message event', async () => {
    // Arrange
    const client = new WebSocketClient({
      schema: TEST_SCHEMA,
      route: TEST_ROUTE,
      baseUrl: BASE_URL,
      params: { params: { room: 'r1' } },
      onHandshake: (_, messages) =>
        new Promise<void>((resolve) => {
          messages.on('message', (msg) => {
            if (msg.type === ServerMsgType.AUTH_OK) resolve();
          });
        }),
    });
    const publicHandler = vi.fn();
    client.on('message', publicHandler);

    // Act
    client.start();
    currentSocket().onopen!({ type: 'open' });
    currentSocket().onmessage!({ data: JSON.stringify({ type: 'auth-ok' }) });

    await vi.waitFor(() => {
      expect(client.state).toBe('OPEN');
    });

    // Assert
    expect(publicHandler).toHaveBeenCalledWith({ type: 'auth-ok' });
  });
});
