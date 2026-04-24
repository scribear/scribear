import { Type } from 'typebox';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { BaseLongPollRouteSchema, BaseRouteDefinition } from '@scribear/base-schema';
import { NetworkError, UnexpectedResponseError } from '@scribear/base-api-client';

import { LongPollClient } from '#src/long-poll-client.js';

const mockEndpointFn = vi.hoisted(() => vi.fn());

vi.mock('@scribear/base-api-client', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('@scribear/base-api-client')>();
  return { ...original, createEndpointClient: () => mockEndpointFn };
});

const SCHEMA = {
  description: 'Test long-poll endpoint',
  tags: [],
  querystring: Type.Object({ sinceVersion: Type.Integer() }),
  response: {
    200: Type.Object({ versionKey: Type.Integer(), payload: Type.String() }),
    204: Type.Null(),
  },
} satisfies BaseLongPollRouteSchema;

const ROUTE: BaseRouteDefinition = {
  method: 'GET',
  url: '/api/test/poll',
};

const BASE_URL = 'http://localhost:3000';

// eslint-disable-next-line @typescript-eslint/no-empty-function
const HANG = new Promise<never>(() => {});

function makeClient(
  overrides?: Partial<ConstructorParameters<typeof LongPollClient<typeof SCHEMA>>[0]>,
) {
  return new LongPollClient({
    schema: SCHEMA,
    route: ROUTE,
    baseUrl: BASE_URL,
    params: {},
    versionParam: 'sinceVersion',
    versionResponseKey: 'versionKey',
    ...overrides,
  });
}

describe('LongPollClient', () => {
  let client: LongPollClient<typeof SCHEMA>;

  beforeEach(() => {
    mockEndpointFn.mockReset();
    client = makeClient();
  });

  afterEach(() => {
    client.close();
  });

  // ---------------------------------------------------------------------------
  // start()
  // ---------------------------------------------------------------------------

  describe('start()', () => {
    it('transitions from IDLE to POLLING immediately', () => {
      // Arrange
      mockEndpointFn.mockReturnValue(HANG);

      // Act
      client.start();

      // Assert
      expect(client.state).toBe('POLLING');
    });

    it('is a no-op when already POLLING', () => {
      // Arrange
      mockEndpointFn.mockReturnValue(HANG);
      const stateChangeSpy = vi.fn();
      client.on('stateChange', stateChangeSpy);
      client.start();

      // Act
      client.start();

      // Assert
      expect(stateChangeSpy).toHaveBeenCalledTimes(1);
    });

    it('resets version cursor to initialVersion on each start', async () => {
      // Arrange
      mockEndpointFn
        .mockResolvedValueOnce([{ status: 200, data: { versionKey: 7, payload: 'x' } }, null])
        .mockReturnValue(HANG);
      client.start();
      await vi.waitFor(() => { expect(mockEndpointFn).toHaveBeenCalledTimes(2); });
      client.close();

      // Act – restart after close
      mockEndpointFn.mockReset();
      mockEndpointFn.mockReturnValue(HANG);
      client.start();

      // Assert – cursor back to 0
      expect(mockEndpointFn).toHaveBeenCalledWith(
        expect.objectContaining({ querystring: { sinceVersion: 0 } }),
        expect.anything(),
      );
    });

    it('uses custom initialVersion as starting cursor', () => {
      // Arrange
      mockEndpointFn.mockReturnValue(HANG);
      const customClient = makeClient({ initialVersion: 42 });

      // Act
      customClient.start();

      // Assert
      expect(mockEndpointFn).toHaveBeenCalledWith(
        expect.objectContaining({ querystring: { sinceVersion: 42 } }),
        expect.anything(),
      );

      customClient.close();
    });
  });

  // ---------------------------------------------------------------------------
  // Polling loop — 200 responses
  // ---------------------------------------------------------------------------

  describe('200 responses', () => {
    it('fires data event with the response payload', async () => {
      // Arrange
      const payload = { versionKey: 1, payload: 'hello' };
      mockEndpointFn
        .mockResolvedValueOnce([{ status: 200, data: payload }, null])
        .mockReturnValue(HANG);
      const dataSpy = vi.fn();
      client.on('data', dataSpy);

      // Act
      client.start();
      await vi.waitFor(() => { expect(dataSpy).toHaveBeenCalled(); });

      // Assert
      expect(dataSpy).toHaveBeenCalledWith(payload);
    });

    it('advances version cursor from versionResponseKey', async () => {
      // Arrange
      mockEndpointFn
        .mockResolvedValueOnce([{ status: 200, data: { versionKey: 9, payload: 'a' } }, null])
        .mockReturnValue(HANG);

      // Act
      client.start();
      await vi.waitFor(() => { expect(mockEndpointFn).toHaveBeenCalledTimes(2); });

      // Assert – second call uses the new cursor
      expect(mockEndpointFn).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ querystring: { sinceVersion: 9 } }),
        expect.anything(),
      );
    });

    it('re-polls immediately after 200', async () => {
      // Arrange
      mockEndpointFn
        .mockResolvedValueOnce([{ status: 200, data: { versionKey: 1, payload: 'a' } }, null])
        .mockReturnValue(HANG);

      // Act
      client.start();
      await vi.waitFor(() => { expect(mockEndpointFn).toHaveBeenCalledTimes(2); });

      // Assert
      expect(client.state).toBe('POLLING');
    });
  });

  // ---------------------------------------------------------------------------
  // Polling loop — 204 responses
  // ---------------------------------------------------------------------------

  describe('204 responses', () => {
    it('does not fire data event on 204', async () => {
      // Arrange
      mockEndpointFn
        .mockResolvedValueOnce([{ status: 204, data: null }, null])
        .mockReturnValue(HANG);
      const dataSpy = vi.fn();
      client.on('data', dataSpy);

      // Act
      client.start();
      await vi.waitFor(() => { expect(mockEndpointFn).toHaveBeenCalledTimes(2); });

      // Assert
      expect(dataSpy).not.toHaveBeenCalled();
    });

    it('does not advance cursor on 204', async () => {
      // Arrange
      mockEndpointFn
        .mockResolvedValueOnce([{ status: 204, data: null }, null])
        .mockReturnValue(HANG);

      // Act
      client.start();
      await vi.waitFor(() => { expect(mockEndpointFn).toHaveBeenCalledTimes(2); });

      // Assert – second call still uses initial cursor 0
      expect(mockEndpointFn).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ querystring: { sinceVersion: 0 } }),
        expect.anything(),
      );
    });

    it('re-polls immediately after 204', async () => {
      // Arrange
      mockEndpointFn
        .mockResolvedValueOnce([{ status: 204, data: null }, null])
        .mockReturnValue(HANG);

      // Act
      client.start();
      await vi.waitFor(() => { expect(mockEndpointFn).toHaveBeenCalledTimes(2); });

      // Assert
      expect(client.state).toBe('POLLING');
    });
  });

  // ---------------------------------------------------------------------------
  // Request parameters
  // ---------------------------------------------------------------------------

  describe('request parameters', () => {
    it('sends version cursor as querystring param on every poll', () => {
      // Arrange
      mockEndpointFn.mockReturnValue(HANG);

      // Act
      client.start();

      // Assert
      expect(mockEndpointFn).toHaveBeenCalledWith(
        expect.objectContaining({ querystring: { sinceVersion: 0 } }),
        expect.anything(),
      );
    });

    it('includes path params when schema declares them', () => {
      // Arrange
      const schemaWithParams = {
        description: 'Test endpoint with path params',
        tags: [],
        params: Type.Object({ sessionUid: Type.String() }),
        querystring: Type.Object({ sinceVersion: Type.Integer() }),
        response: {
          200: Type.Object({ versionKey: Type.Integer() }),
          204: Type.Null(),
        },
      } satisfies BaseLongPollRouteSchema;

      mockEndpointFn.mockReturnValue(HANG);
      const paramClient = new LongPollClient({
        schema: schemaWithParams,
        route: ROUTE,
        baseUrl: BASE_URL,
        params: { params: { sessionUid: 'abc-123' } },
        versionParam: 'sinceVersion',
        versionResponseKey: 'versionKey',
      });

      // Act
      paramClient.start();

      // Assert
      expect(mockEndpointFn).toHaveBeenCalledWith(
        expect.objectContaining({ params: { sessionUid: 'abc-123' } }),
        expect.anything(),
      );

      paramClient.close();
    });

    it('merges custom headers into every request', () => {
      // Arrange
      mockEndpointFn.mockReturnValue(HANG);
      const headerClient = makeClient({ headers: { Authorization: 'Bearer tok' } });

      // Act
      headerClient.start();

      // Assert
      expect(mockEndpointFn).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ headers: { Authorization: 'Bearer tok' } }),
      );

      headerClient.close();
    });
  });

  // ---------------------------------------------------------------------------
  // Error handling
  // ---------------------------------------------------------------------------

  describe('error handling', () => {
    it('fires error event with NetworkError on fetch failure', async () => {
      // Arrange
      const networkErr = new NetworkError(new TypeError('Failed to fetch'));
      mockEndpointFn
        .mockResolvedValueOnce([null, networkErr])
        .mockReturnValue(HANG);
      const errorSpy = vi.fn();
      client.on('error', errorSpy);

      // Act
      client.start();
      await vi.waitFor(() => { expect(errorSpy).toHaveBeenCalled(); });

      // Assert
      expect(errorSpy).toHaveBeenCalledWith(networkErr);
    });

    it('fires error event with UnexpectedResponseError on undeclared status', async () => {
      // Arrange
      const unexpectedErr = new UnexpectedResponseError(503);
      mockEndpointFn
        .mockResolvedValueOnce([null, unexpectedErr])
        .mockReturnValue(HANG);
      const errorSpy = vi.fn();
      client.on('error', errorSpy);

      // Act
      client.start();
      await vi.waitFor(() => { expect(errorSpy).toHaveBeenCalled(); });

      // Assert
      expect(errorSpy).toHaveBeenCalledWith(unexpectedErr);
    });

    it('does not fire error event when close() aborts the in-flight request', async () => {
      // Arrange
      let resolveAbort!: (v: [null, NetworkError]) => void;
      mockEndpointFn.mockReturnValue(new Promise((resolve) => { resolveAbort = resolve; }));
      const errorSpy = vi.fn();
      client.on('error', errorSpy);

      client.start();
      client.close();

      // Simulate what createEndpointClient emits when the AbortController fires
      const abortError = Object.assign(new Error('The operation was aborted'), {
        name: 'AbortError',
      });
      resolveAbort([null, new NetworkError(abortError)]);
      await Promise.resolve();

      // Assert
      expect(errorSpy).not.toHaveBeenCalled();
      expect(client.state).toBe('CLOSED');
    });
  });

  // ---------------------------------------------------------------------------
  // Backoff and retry (fake timers)
  // ---------------------------------------------------------------------------

  describe('backoff and retry', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('transitions to WAITING_RETRY after an error', async () => {
      // Arrange
      mockEndpointFn
        .mockResolvedValueOnce([null, new NetworkError(new TypeError())])
        .mockReturnValue(HANG);

      // Act
      client.start();
      await Promise.resolve(); // flush endpointFn resolution

      // Assert
      expect(client.state).toBe('WAITING_RETRY');
    });

    it('fires close event with numeric delay on error-triggered retry', async () => {
      // Arrange
      mockEndpointFn
        .mockResolvedValueOnce([null, new NetworkError(new TypeError())])
        .mockReturnValue(HANG);
      const closeSpy = vi.fn();
      client.on('close', closeSpy);

      // Act
      client.start();
      await Promise.resolve();

      // Assert
      expect(closeSpy).toHaveBeenCalledTimes(1);
      expect(closeSpy).toHaveBeenCalledWith(expect.any(Number));
    });

    it('transitions back to POLLING once the retry timer fires', async () => {
      // Arrange
      mockEndpointFn
        .mockResolvedValueOnce([null, new NetworkError(new TypeError())])
        .mockReturnValue(HANG);

      // Act
      client.start();
      await Promise.resolve(); // → WAITING_RETRY
      vi.runAllTimers(); // fire retry timer → POLLING

      // Assert
      expect(client.state).toBe('POLLING');
    });

    it('increments attempt counter on consecutive failures', async () => {
      // Arrange
      mockEndpointFn.mockResolvedValue([null, new NetworkError(new TypeError())]);

      // Act
      client.start();
      await Promise.resolve(); // first failure
      vi.runAllTimers(); // retry
      await Promise.resolve(); // second failure

      // Assert
      expect(client.attempt).toBe(2);
    });

    it('resets attempt counter to 0 after a successful response', async () => {
      // Arrange
      mockEndpointFn
        .mockResolvedValueOnce([null, new NetworkError(new TypeError())]) // fail
        .mockResolvedValueOnce([{ status: 200, data: { versionKey: 1, payload: 'ok' } }, null]) // success
        .mockReturnValue(HANG);

      // Act
      client.start();
      await Promise.resolve(); // first failure → attempt = 1
      vi.runAllTimers(); // fire retry → POLLING
      await Promise.resolve(); // 200 → attempt reset

      // Assert
      expect(client.attempt).toBe(0);
    });

    it('cancels pending retry timer when close() is called during WAITING_RETRY', async () => {
      // Arrange
      mockEndpointFn
        .mockResolvedValueOnce([null, new NetworkError(new TypeError())])
        .mockReturnValue(HANG);

      client.start();
      await Promise.resolve(); // → WAITING_RETRY
      expect(client.state).toBe('WAITING_RETRY');

      // Act
      client.close();
      vi.runAllTimers(); // would have triggered retry, but was cancelled

      // Assert
      expect(client.state).toBe('CLOSED');
    });
  });

  // ---------------------------------------------------------------------------
  // close()
  // ---------------------------------------------------------------------------

  describe('close()', () => {
    it('transitions to CLOSED', () => {
      // Arrange
      mockEndpointFn.mockReturnValue(HANG);
      client.start();

      // Act
      client.close();

      // Assert
      expect(client.state).toBe('CLOSED');
    });

    it('fires close event with null on explicit close during polling', () => {
      // Arrange
      mockEndpointFn.mockReturnValue(HANG);
      const closeSpy = vi.fn();
      client.on('close', closeSpy);
      client.start();

      // Act
      client.close();

      // Assert
      expect(closeSpy).toHaveBeenCalledWith(null);
    });

    it('does not fire close event when closing from IDLE', () => {
      // Arrange
      const closeSpy = vi.fn();
      client.on('close', closeSpy);

      // Act
      client.close();

      // Assert
      expect(closeSpy).not.toHaveBeenCalled();
    });

    it('allows start() to resume polling after close()', () => {
      // Arrange
      mockEndpointFn.mockReturnValue(HANG);
      client.start();
      client.close();

      // Act
      mockEndpointFn.mockReset();
      mockEndpointFn.mockReturnValue(HANG);
      client.start();

      // Assert
      expect(client.state).toBe('POLLING');
    });
  });

  // ---------------------------------------------------------------------------
  // stateChange events
  // ---------------------------------------------------------------------------

  describe('stateChange events', () => {
    it('fires stateChange with (to, from) on each transition', () => {
      // Arrange
      mockEndpointFn.mockReturnValue(HANG);
      const stateChangeSpy = vi.fn();
      client.on('stateChange', stateChangeSpy);

      // Act
      client.start(); // IDLE → POLLING
      client.close(); // POLLING → CLOSED

      // Assert
      expect(stateChangeSpy).toHaveBeenNthCalledWith(1, 'POLLING', 'IDLE');
      expect(stateChangeSpy).toHaveBeenNthCalledWith(2, 'CLOSED', 'POLLING');
    });
  });
});
