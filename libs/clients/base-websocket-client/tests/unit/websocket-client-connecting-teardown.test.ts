import net from 'node:net';
import { Type } from 'typebox';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { WebSocketClient } from '#src/websocket-client.js';

/**
 * Deliberately **not** mocking `isomorphic-ws`, unlike the sibling suite.
 *
 * The behaviour under test belongs to `ws` itself: `close()` on a socket that
 * is still `CONNECTING` does not close anything and does not throw - it calls
 * `abortHandshake`, which schedules `process.nextTick(emitErrorAndClose, ...)`
 * (`ws/lib/websocket.js`). A mock socket whose `close` is a spy cannot express
 * that, and a mock written to express it would only be asserting what its
 * author already believed. So this suite drives the real library against a
 * real socket.
 */

const TEST_SCHEMA = {
  description: 'Test WebSocket route',
  tags: [],
  allowClientBinaryMessage: false,
  clientMessage: Type.Object({ type: Type.Literal('ping') }),
  allowServerBinaryMessage: false,
  serverMessage: Type.Object({ type: Type.Literal('pong') }),
  closeCodes: { 1000: { description: 'Normal' } },
};

const TEST_ROUTE = { method: 'GET' as const, websocket: true, url: '/ws' };

/**
 * A server that completes the TCP connect and then says nothing at all, so a
 * client parked on it stays in `CONNECTING` for as long as the test needs.
 * A closed port would not do: that fails the connection outright and takes a
 * different path.
 */
function silentServer(): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve) => {
    const sockets: net.Socket[] = [];
    const server = net.createServer((socket) => sockets.push(socket));
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        throw new Error('server did not bind a TCP port');
      }
      resolve({
        port: address.port,
        close: () => {
          for (const socket of sockets) socket.destroy();
          server.close();
        },
      });
    });
  });
}

/** Resolves after `process.nextTick` and a macrotask have both drained. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 20));
}

describe('WebSocketClient teardown while still CONNECTING', () => {
  let server: { port: number; close: () => void };
  let uncaught: Error[];
  const capture = (error: Error) => uncaught.push(error);

  beforeEach(async () => {
    server = await silentServer();
    uncaught = [];
    // `prependOnceListener` is not enough: the emit has to find *a* listener
    // for the whole tick, and vitest installs its own after ours.
    process.on('uncaughtException', capture);
  });

  afterEach(() => {
    process.off('uncaughtException', capture);
    server.close();
  });

  it('does not raise an unhandled error when terminate() aborts the handshake', async () => {
    // Arrange - parked mid-handshake, which is the ordinary case for a source
    // that disconnects while its upstream is still connecting.
    const client = new WebSocketClient({
      schema: TEST_SCHEMA,
      route: TEST_ROUTE,
      baseUrl: `http://127.0.0.1:${String(server.port)}`,
      params: {},
    });
    client.on('error', () => {
      /* the client's own error channel is not what this asserts on */
    });
    client.start();
    expect(client.state).toBe('CONNECTING');

    // Act
    client.terminate(1000, 'no-more-sources');
    await settle();

    // Assert - the detached `onerror` used to leave the socket with no
    // 'error' listener at all, so `abortHandshake`'s emit reached an
    // EventEmitter that had none and threw on a later tick. The `try/catch`
    // around `close()` cannot catch that: it returned ticks earlier.
    expect(uncaught.map((error) => error.message)).toEqual([]);
  });
});
