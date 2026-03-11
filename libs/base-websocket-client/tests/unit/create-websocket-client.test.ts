import { Type } from 'typebox';
import {
  type MockInstance,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import { createWebSocketClient } from '#src/create-websocket-client.js';
import { ConnectionError, SchemaValidationError } from '#src/errors.js';
import { WebSocketClient } from '#src/websocket-client.js';

interface MockWsInstance {
  url: string;
  options: unknown;
  onopen: ((event: { type: string }) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number; reason: string }) => void) | null;
  onerror: ((event: { error: unknown; message: string }) => void) | null;
  send: MockInstance;
  close: MockInstance;
}

let mockWsInstance: MockWsInstance;

vi.mock('isomorphic-ws', () => {
  class MockWebSocket {
    url: string;
    options: unknown;
    onopen: MockWsInstance['onopen'] = null;
    onmessage: MockWsInstance['onmessage'] = null;
    onclose: MockWsInstance['onclose'] = null;
    onerror: MockWsInstance['onerror'] = null;
    send = vi.fn();
    close = vi.fn();

    constructor(url: string, options: unknown) {
      this.url = url;
      this.options = options;
      mockWsInstance = this as unknown as MockWsInstance;
    }
  }
  return { default: MockWebSocket };
});

enum TestClientMessageType {
  PING = 'ping',
}

enum TestServerMessageType {
  PONG = 'pong',
}

const TEST_SCHEMA = {
  description: 'Test WebSocket route',
  tags: [],
  allowClientBinaryMessage: false,
  clientMessage: Type.Object({
    type: Type.Literal(TestClientMessageType.PING),
  }),
  allowServerBinaryMessage: true,
  serverMessage: Type.Object({
    type: Type.Literal(TestServerMessageType.PONG),
    value: Type.Number(),
  }),
  closeCodes: {
    1000: { description: 'Normal closure' },
    4001: { description: 'Custom close code' },
  },
};

const TEST_ROUTE = {
  method: 'GET' as const,
  websocket: true,
  url: '/ws/:roomId',
};

const BASE_URL = 'http://localhost:3000';

type ConnectFn = ReturnType<typeof createWebSocketClient<typeof TEST_SCHEMA>>;

/**
 * Creates the connect function and triggers onopen to simulate a successful connection.
 */
async function connectSuccessfully() {
  const connect = createWebSocketClient(TEST_SCHEMA, TEST_ROUTE, BASE_URL);
  const promise = connect({
    params: { roomId: 'abc' },
  } as Parameters<ConnectFn>[0]);
  mockWsInstance.onopen!({ type: 'open' });
  return promise;
}

describe('createWebSocketClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('connect()', () => {
    it('returns [client, null] when connection opens successfully', async () => {
      // Arrange
      const connect = createWebSocketClient(TEST_SCHEMA, TEST_ROUTE, BASE_URL);
      const promise = connect({
        params: { roomId: 'abc' },
      } as Parameters<ConnectFn>[0]);

      // Act
      mockWsInstance.onopen!({ type: 'open' });
      const [client, error] = await promise;

      // Assert
      expect(client).toBeInstanceOf(WebSocketClient);
      expect(error).toBeNull();
    });

    it('returns [null, ConnectionError] when connection fails before open', async () => {
      // Arrange
      const connect = createWebSocketClient(TEST_SCHEMA, TEST_ROUTE, BASE_URL);
      const promise = connect({
        params: { roomId: 'abc' },
      } as Parameters<ConnectFn>[0]);
      const cause = new Error('ECONNREFUSED');

      // Act
      mockWsInstance.onerror!({ error: cause, message: 'ECONNREFUSED' });
      const [client, error] = await promise;

      // Assert
      expect(client).toBeNull();
      expect(error).toBeInstanceOf(ConnectionError);
      expect(error?.cause).toBe(cause);
    });

    it('builds URL with path params substituted and http converted to ws', async () => {
      // Arrange
      const connect = createWebSocketClient(TEST_SCHEMA, TEST_ROUTE, BASE_URL);

      // Act
      const promise = connect({
        params: { roomId: 'room-1' },
      } as Parameters<ConnectFn>[0]);
      mockWsInstance.onopen!({ type: 'open' });
      await promise;

      // Assert
      expect(mockWsInstance.url).toBe('ws://localhost:3000/ws/room-1');
    });
  });

  describe('client.on("message")', () => {
    it('emits typed server message when received JSON matches schema', async () => {
      // Arrange
      const [client] = await connectSuccessfully();
      const handler = vi.fn();
      client!.on('message', handler);

      // Act
      mockWsInstance.onmessage!({
        data: JSON.stringify({ type: 'pong', value: 42 }),
      });

      // Assert
      expect(handler).toHaveBeenCalledWith({ type: 'pong', value: 42 });
    });

    it('emits SchemaValidationError when received JSON does not match schema', async () => {
      // Arrange
      const [client] = await connectSuccessfully();
      const errorHandler = vi.fn();
      client!.on('error', errorHandler);

      // Act
      mockWsInstance.onmessage!({
        data: JSON.stringify({ type: 'unexpected' }),
      });

      // Assert
      expect(errorHandler).toHaveBeenCalledWith(
        expect.any(SchemaValidationError),
      );
    });

    it('emits SchemaValidationError when received data is not valid JSON', async () => {
      // Arrange
      const [client] = await connectSuccessfully();
      const errorHandler = vi.fn();
      client!.on('error', errorHandler);

      // Act
      mockWsInstance.onmessage!({ data: 'not-json{{{' });

      // Assert
      expect(errorHandler).toHaveBeenCalledWith(
        expect.any(SchemaValidationError),
      );
    });
  });

  describe('client.on("binaryMessage")', () => {
    it('emits binaryMessage when a Buffer is received', async () => {
      // Arrange
      const [client] = await connectSuccessfully();
      const handler = vi.fn();
      client!.on('binaryMessage', handler);
      const buf = Buffer.from([1, 2, 3]);

      // Act
      mockWsInstance.onmessage!({ data: buf });

      // Assert
      expect(handler).toHaveBeenCalledWith(buf);
    });
  });

  describe('client.on("close")', () => {
    it('emits close with code and reason when close code is in the schema', async () => {
      // Arrange
      const [client] = await connectSuccessfully();
      const handler = vi.fn();
      client!.on('close', handler);

      // Act
      mockWsInstance.onclose!({ code: 1000, reason: 'Normal closure' });

      // Assert
      expect(handler).toHaveBeenCalledWith(1000, 'Normal closure');
    });

    it('emits close with a custom close code defined in the schema', async () => {
      // Arrange
      const [client] = await connectSuccessfully();
      const handler = vi.fn();
      client!.on('close', handler);

      // Act
      mockWsInstance.onclose!({ code: 4001, reason: 'Custom close' });

      // Assert
      expect(handler).toHaveBeenCalledWith(4001, 'Custom close');
    });

    it('emits SchemaValidationError when close code is not in the schema', async () => {
      // Arrange
      const [client] = await connectSuccessfully();
      const closeHandler = vi.fn();
      const errorHandler = vi.fn();
      client!.on('close', closeHandler);
      client!.on('error', errorHandler);

      // Act
      mockWsInstance.onclose!({ code: 9999, reason: 'Unknown' });

      // Assert
      expect(closeHandler).not.toHaveBeenCalled();
      expect(errorHandler).toHaveBeenCalledWith(
        expect.any(SchemaValidationError),
      );
    });
  });

  describe('client.on("error")', () => {
    it('emits Error when WebSocket fires onerror after connection', async () => {
      // Arrange
      const [client] = await connectSuccessfully();
      const handler = vi.fn();
      client!.on('error', handler);
      const wsError = new Error('Connection reset');

      // Act
      mockWsInstance.onerror!({ error: wsError, message: 'Connection reset' });

      // Assert
      expect(handler).toHaveBeenCalledWith(wsError);
    });
  });

  describe('client.send()', () => {
    it('sends JSON-serialized client message over the WebSocket', async () => {
      // Arrange
      const [client] = await connectSuccessfully();

      // Act
      client!.send({ type: TestClientMessageType.PING });

      // Assert
      expect(mockWsInstance.send).toHaveBeenCalledWith(
        JSON.stringify({ type: 'ping' }),
      );
    });
  });

  describe('client.sendBinary()', () => {
    it('sends raw binary data over the WebSocket', async () => {
      // Arrange
      const [client] = await connectSuccessfully();
      const buf = Buffer.from([0xde, 0xad]);

      // Act
      client!.sendBinary(buf);

      // Assert
      expect(mockWsInstance.send).toHaveBeenCalledWith(buf);
    });
  });

  describe('client.close()', () => {
    it('closes the underlying WebSocket', async () => {
      // Arrange
      const [client] = await connectSuccessfully();

      // Act
      client!.close();

      // Assert
      expect(mockWsInstance.close).toHaveBeenCalled();
    });
  });
});
