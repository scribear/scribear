import { Type } from 'typebox';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  NetworkError,
  UnexpectedResponseError,
} from '@scribear/base-api-client';
import type {
  BaseLongPollRouteSchema,
  BaseRouteDefinition,
} from '@scribear/base-schema';

import { LongPollResponseError } from '#src/errors.js';
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
    // Declared error statuses, mirroring the real routes: `my-schedule`
    // declares 401 INVALID_DEVICE_TOKEN, 404 DEVICE_NOT_IN_ROOM and
    // STANDARD_ERROR_REPLIES (which includes 500). Declared statuses are the
    // dangerous ones - `createEndpointClient` returns them in the *response*
    // slot with a null error, so they reach the poll loop looking exactly like
    // a payload.
    401: Type.Object({ code: Type.String(), message: Type.String() }),
    404: Type.Object({ code: Type.String(), message: Type.String() }),
    500: Type.Object({ code: Type.String(), message: Type.String() }),
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
  overrides?: Partial<
    ConstructorParameters<typeof LongPollClient<typeof SCHEMA>>[0]
  >,
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
        .mockResolvedValueOnce([
          { status: 200, data: { versionKey: 7, payload: 'x' } },
          null,
        ])
        .mockReturnValue(HANG);
      client.start();
      await vi.waitFor(() => {
        expect(mockEndpointFn).toHaveBeenCalledTimes(2);
      });
      client.close();

      // Act - restart after close
      mockEndpointFn.mockReset();
      mockEndpointFn.mockReturnValue(HANG);
      client.start();

      // Assert - cursor back to 0
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
      await vi.waitFor(() => {
        expect(dataSpy).toHaveBeenCalled();
      });

      // Assert
      expect(dataSpy).toHaveBeenCalledWith(payload);
    });

    it('advances version cursor from versionResponseKey', async () => {
      // Arrange
      mockEndpointFn
        .mockResolvedValueOnce([
          { status: 200, data: { versionKey: 9, payload: 'a' } },
          null,
        ])
        .mockReturnValue(HANG);

      // Act
      client.start();
      await vi.waitFor(() => {
        expect(mockEndpointFn).toHaveBeenCalledTimes(2);
      });

      // Assert - second call uses the new cursor
      expect(mockEndpointFn).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ querystring: { sinceVersion: 9 } }),
        expect.anything(),
      );
    });

    it('re-polls immediately after 200', async () => {
      // Arrange
      mockEndpointFn
        .mockResolvedValueOnce([
          { status: 200, data: { versionKey: 1, payload: 'a' } },
          null,
        ])
        .mockReturnValue(HANG);

      // Act
      client.start();
      await vi.waitFor(() => {
        expect(mockEndpointFn).toHaveBeenCalledTimes(2);
      });

      // Assert
      expect(client.state).toBe('POLLING');
    });
  });

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
      await vi.waitFor(() => {
        expect(mockEndpointFn).toHaveBeenCalledTimes(2);
      });

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
      await vi.waitFor(() => {
        expect(mockEndpointFn).toHaveBeenCalledTimes(2);
      });

      // Assert - second call still uses initial cursor 0
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
      await vi.waitFor(() => {
        expect(mockEndpointFn).toHaveBeenCalledTimes(2);
      });

      // Assert
      expect(client.state).toBe('POLLING');
    });
  });

  describe('declared non-200/204 responses', () => {
    /**
     * The regression test for the `invalid-request` laundering chain.
     *
     * A declared 401 comes back in the *response* slot (`err === null`), so
     * the loop's old `status === 204 ? continue : emit data` shape published
     * the error body as if it were the payload. node-server then read
     * `transcriptionProviderId` off `{ code, message }`, got `undefined`, and
     * dialed `.../transcription_stream/undefined`, which the transcription
     * service refused - so a `NODE_SERVER_KEY` mismatch was shown to the
     * operator as `invalid-request`, pointing at a provider misconfiguration
     * that did not exist.
     */
    it('does not emit a declared 401 error body as data', async () => {
      // Arrange
      mockEndpointFn
        .mockResolvedValueOnce([
          {
            status: 401,
            data: { code: 'INVALID_DEVICE_TOKEN', message: 'nope' },
          },
          null,
        ])
        .mockReturnValue(HANG);
      const dataSpy = vi.fn();
      const errorSpy = vi.fn();
      client.on('data', dataSpy);
      client.on('error', errorSpy);

      // Act
      client.start();
      await vi.waitFor(() => {
        expect(errorSpy).toHaveBeenCalled();
      });

      // Assert
      expect(dataSpy).not.toHaveBeenCalled();
    });

    it('reports a declared 401 as a LongPollResponseError carrying status, code and body', async () => {
      // Arrange
      const body = { code: 'INVALID_DEVICE_TOKEN', message: 'token revoked' };
      mockEndpointFn
        .mockResolvedValueOnce([{ status: 401, data: body }, null])
        .mockReturnValue(HANG);
      const errorSpy = vi.fn();
      client.on('error', errorSpy);

      // Act
      client.start();
      await vi.waitFor(() => {
        expect(errorSpy).toHaveBeenCalled();
      });

      // Assert - the cause has to be legible to a consumer that reports faults
      // to a human, so status/code/body all survive the trip.
      const err = errorSpy.mock.calls[0]?.[0] as LongPollResponseError;
      expect(err).toBeInstanceOf(LongPollResponseError);
      expect(err.status).toBe(401);
      expect(err.code).toBe('INVALID_DEVICE_TOKEN');
      expect(err.body).toEqual(body);
      expect(err.message).toContain('401');
      expect(err.message).toContain('INVALID_DEVICE_TOKEN');
      expect(err.message).toContain('token revoked');
    });

    it('is an UnexpectedResponseError, so existing consumer branches still match', async () => {
      // Arrange
      mockEndpointFn
        .mockResolvedValueOnce([
          { status: 401, data: { code: 'INVALID_DEVICE_TOKEN', message: 'x' } },
          null,
        ])
        .mockReturnValue(HANG);
      const errorSpy = vi.fn();
      client.on('error', errorSpy);

      // Act
      client.start();
      await vi.waitFor(() => {
        expect(errorSpy).toHaveBeenCalled();
      });

      // Assert
      expect(errorSpy.mock.calls[0]?.[0]).toBeInstanceOf(
        UnexpectedResponseError,
      );
    });

    it('does not emit a declared 404 error body as data', async () => {
      // Arrange
      mockEndpointFn
        .mockResolvedValueOnce([
          {
            status: 404,
            data: { code: 'DEVICE_NOT_IN_ROOM', message: 'unassigned' },
          },
          null,
        ])
        .mockReturnValue(HANG);
      const dataSpy = vi.fn();
      const errorSpy = vi.fn();
      client.on('data', dataSpy);
      client.on('error', errorSpy);

      // Act
      client.start();
      await vi.waitFor(() => {
        expect(errorSpy).toHaveBeenCalled();
      });

      // Assert
      expect(dataSpy).not.toHaveBeenCalled();
      expect((errorSpy.mock.calls[0]?.[0] as LongPollResponseError).code).toBe(
        'DEVICE_NOT_IN_ROOM',
      );
    });

    it('does not emit a declared 500 error body as data', async () => {
      // Arrange
      mockEndpointFn
        .mockResolvedValueOnce([
          { status: 500, data: { code: 'INTERNAL_ERROR', message: 'boom' } },
          null,
        ])
        .mockReturnValue(HANG);
      const dataSpy = vi.fn();
      const errorSpy = vi.fn();
      client.on('data', dataSpy);
      client.on('error', errorSpy);

      // Act
      client.start();
      await vi.waitFor(() => {
        expect(errorSpy).toHaveBeenCalled();
      });

      // Assert
      expect(dataSpy).not.toHaveBeenCalled();
      expect(
        (errorSpy.mock.calls[0]?.[0] as LongPollResponseError).status,
      ).toBe(500);
    });

    it('does not advance the version cursor on a declared error status', async () => {
      // Arrange
      mockEndpointFn
        .mockResolvedValueOnce([
          {
            status: 401,
            // A `versionKey` on an error body must not move the cursor: the
            // cursor is only meaningful for payloads we actually delivered.
            data: {
              code: 'INVALID_DEVICE_TOKEN',
              message: 'x',
              versionKey: 99,
            },
          },
          null,
        ])
        .mockReturnValue(HANG);
      const errorSpy = vi.fn();
      client.on('error', errorSpy);

      // Act
      client.start();
      await vi.waitFor(() => {
        expect(errorSpy).toHaveBeenCalled();
      });
      client.close();
      mockEndpointFn.mockClear();
      mockEndpointFn.mockReturnValue(HANG);
      client.start();

      // Assert
      expect(mockEndpointFn).toHaveBeenCalledWith(
        expect.objectContaining({ querystring: { sinceVersion: 0 } }),
        expect.anything(),
      );
    });

    it('retries a declared error status with backoff rather than stopping', async () => {
      // Arrange
      mockEndpointFn
        .mockResolvedValueOnce([
          { status: 401, data: { code: 'INVALID_DEVICE_TOKEN', message: 'x' } },
          null,
        ])
        .mockReturnValue(HANG);
      const closeSpy = vi.fn();
      client.on('close', closeSpy);

      // Act - a revoked token is fixed by a human re-activating the device
      // while this client is still running, so the poll must still be alive to
      // notice.
      client.start();
      await vi.waitFor(() => {
        expect(client.state).toBe('WAITING_RETRY');
      });

      // Assert
      expect(closeSpy).toHaveBeenCalledWith(expect.any(Number));
    });

    it('grows backoff across consecutive declared error statuses', async () => {
      // Arrange - a wrong service key answers 401 forever. Resetting `attempt`
      // before the status check pinned the delay at `initialMs`, hammering a
      // hopeless request once a second indefinitely.
      vi.useFakeTimers();
      mockEndpointFn.mockResolvedValue([
        { status: 401, data: { code: 'INVALID_SERVICE_KEY', message: 'x' } },
        null,
      ]);

      // Act
      client.start();
      await Promise.resolve(); // first 401
      vi.runAllTimers(); // retry
      await Promise.resolve(); // second 401

      // Assert
      expect(client.attempt).toBe(2);
      vi.useRealTimers();
    });
  });

  describe('cursor integrity', () => {
    it('fails rather than emitting a 200 whose body has no numeric version key', async () => {
      // Arrange - `versionResponseKey` naming a field the 200 schema does not
      // have. Emitting anyway would leave the cursor at 0, and the server
      // answers 200 to that same cursor immediately: a hot loop with no delay.
      mockEndpointFn.mockResolvedValue([
        { status: 200, data: { payload: 'a' } },
        null,
      ]);
      const dataSpy = vi.fn();
      const errorSpy = vi.fn();
      client.on('data', dataSpy);
      client.on('error', errorSpy);

      // Act
      client.start();
      await vi.waitFor(() => {
        expect(errorSpy).toHaveBeenCalled();
      });

      // Assert
      expect(dataSpy).not.toHaveBeenCalled();
      expect(errorSpy.mock.calls[0]?.[0]).toBeInstanceOf(
        UnexpectedResponseError,
      );
      expect((errorSpy.mock.calls[0]?.[0] as Error).message).toContain(
        'versionKey',
      );
      expect(client.state).toBe('WAITING_RETRY');
    });
  });

  describe('data listener failures', () => {
    it('keeps polling and reports when a data listener throws', async () => {
      // Arrange - a throwing listener used to escape the `void`-ed async poll
      // loop, leaving the client in POLLING with no request in flight and no
      // retry armed: permanently silent while `state` still read healthy.
      mockEndpointFn
        .mockResolvedValueOnce([
          { status: 200, data: { versionKey: 1, payload: 'a' } },
          null,
        ])
        .mockReturnValue(HANG);
      const boom = new Error('listener blew up');
      client.on('data', () => {
        throw boom;
      });
      const errorSpy = vi.fn();
      client.on('error', errorSpy);

      // Act
      client.start();
      await vi.waitFor(() => {
        expect(mockEndpointFn).toHaveBeenCalledTimes(2);
      });

      // Assert
      expect(errorSpy).toHaveBeenCalledWith(boom);
      expect(client.state).toBe('POLLING');
    });
  });

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
      const headerClient = makeClient({
        headers: { Authorization: 'Bearer tok' },
      });

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
      await vi.waitFor(() => {
        expect(errorSpy).toHaveBeenCalled();
      });

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
      await vi.waitFor(() => {
        expect(errorSpy).toHaveBeenCalled();
      });

      // Assert
      expect(errorSpy).toHaveBeenCalledWith(unexpectedErr);
    });

    it('does not fire error event when close() aborts the in-flight request', async () => {
      // Arrange
      let resolveAbort!: (v: [null, NetworkError]) => void;
      mockEndpointFn.mockReturnValue(
        new Promise((resolve) => {
          resolveAbort = resolve;
        }),
      );
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
      await Promise.resolve(); // -> WAITING_RETRY
      vi.runAllTimers(); // fire retry timer -> POLLING

      // Assert
      expect(client.state).toBe('POLLING');
    });

    it('increments attempt counter on consecutive failures', async () => {
      // Arrange
      mockEndpointFn.mockResolvedValue([
        null,
        new NetworkError(new TypeError()),
      ]);

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
        .mockResolvedValueOnce([
          { status: 200, data: { versionKey: 1, payload: 'ok' } },
          null,
        ]) // success
        .mockReturnValue(HANG);

      // Act
      client.start();
      await Promise.resolve(); // first failure -> attempt = 1
      vi.runAllTimers(); // fire retry -> POLLING
      await Promise.resolve(); // 200 -> attempt reset

      // Assert
      expect(client.attempt).toBe(0);
    });

    it('cancels pending retry timer when close() is called during WAITING_RETRY', async () => {
      // Arrange
      mockEndpointFn
        .mockResolvedValueOnce([null, new NetworkError(new TypeError())])
        .mockReturnValue(HANG);

      client.start();
      await Promise.resolve(); // -> WAITING_RETRY
      expect(client.state).toBe('WAITING_RETRY');

      // Act
      client.close();
      vi.runAllTimers(); // would have triggered retry, but was cancelled

      // Assert
      expect(client.state).toBe('CLOSED');
    });
  });

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

  describe('stateChange events', () => {
    it('fires stateChange with (to, from) on each transition', () => {
      // Arrange
      mockEndpointFn.mockReturnValue(HANG);
      const stateChangeSpy = vi.fn();
      client.on('stateChange', stateChangeSpy);

      // Act
      client.start(); // IDLE -> POLLING
      client.close(); // POLLING -> CLOSED

      // Assert
      expect(stateChangeSpy).toHaveBeenNthCalledWith(1, 'POLLING', 'IDLE');
      expect(stateChangeSpy).toHaveBeenNthCalledWith(2, 'CLOSED', 'POLLING');
    });
  });
});
