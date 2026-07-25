import { afterEach, beforeEach, describe, expect, vi } from 'vitest';

import { AdminApiClient, FLEET_STREAM_URL } from '#src/lib/admin-api';
import { ApiError, isApiErrorCode } from '#src/lib/api-error';

const BASE = '/api/admin/v1';

/** Minimal stand-in for `Response` — `_request` only ever touches `.ok`,
 *  `.status`, and `.json()`. */
function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

/** A `Response` whose body can't be parsed as JSON (e.g. an empty 204, or an
 *  upstream proxy error page). */
function unparseableResponse(status: number): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.reject(new Error('Unexpected end of JSON input')),
  } as unknown as Response;
}

describe('AdminApiClient', () => {
  let client: AdminApiClient;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    client = new AdminApiClient();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('request construction', (it) => {
    it('sends a GET request with no content-type or csrf header', async () => {
      // Arrange
      fetchMock.mockResolvedValue(
        jsonResponse(200, { ok: true, data: { local: true, sso: false } }),
      );

      // Act
      await client.getAuthConfig();

      // Assert
      expect(fetchMock).toHaveBeenCalledWith(`${BASE}/auth/config`, {
        method: 'GET',
        credentials: 'include',
        headers: {},
      });
    });

    it('attaches the csrf token header on a mutating POST request', async () => {
      // Arrange
      client.setCsrfToken('tok-123');
      fetchMock.mockResolvedValue(jsonResponse(200, { ok: true, data: null }));

      // Act
      await client.logout();

      // Assert
      expect(fetchMock).toHaveBeenCalledWith(`${BASE}/auth/logout`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'x-csrf-token': 'tok-123' },
      });
    });

    it('sends an empty csrf header (never omits it) when no token has been set', async () => {
      // Arrange
      fetchMock.mockResolvedValue(jsonResponse(200, { ok: true, data: null }));

      // Act
      await client.logout();

      // Assert
      expect(fetchMock).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ headers: { 'x-csrf-token': '' } }),
      );
    });

    it('reads the csrf token at call time, not at construction time', async () => {
      // Arrange
      fetchMock.mockResolvedValue(jsonResponse(200, { ok: true, data: null }));

      // Act
      client.setCsrfToken('first');
      await client.logout();
      client.setCsrfToken('second');
      await client.logout();

      // Assert
      expect(fetchMock).toHaveBeenNthCalledWith(
        1,
        expect.any(String),
        expect.objectContaining({ headers: { 'x-csrf-token': 'first' } }),
      );
      expect(fetchMock).toHaveBeenNthCalledWith(
        2,
        expect.any(String),
        expect.objectContaining({ headers: { 'x-csrf-token': 'second' } }),
      );
    });

    it('adds a content-type header and a JSON-serialized body for a mutation with a body', async () => {
      // Arrange
      client.setCsrfToken('tok');
      fetchMock.mockResolvedValue(
        jsonResponse(200, {
          ok: true,
          data: {
            identity: {
              subject: 'alice',
              displayName: 'Alice',
              provider: 'local',
              roles: [],
            },
            csrfToken: 'new-tok',
          },
        }),
      );

      // Act
      await client.login('alice', 'hunter2');

      // Assert
      expect(fetchMock).toHaveBeenCalledWith(`${BASE}/auth/login`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json', 'x-csrf-token': 'tok' },
        body: JSON.stringify({ username: 'alice', password: 'hunter2' }),
      });
    });

    it('omits the body field entirely for a bodyless mutation (not `body: undefined`)', async () => {
      // Arrange
      fetchMock.mockResolvedValue(jsonResponse(200, { ok: true, data: null }));

      // Act
      await client.logout();

      // Assert
      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(init).not.toHaveProperty('body');
      expect(init).not.toHaveProperty('content-type');
    });

    it('always sends credentials: include, on GET and on mutations alike', async () => {
      // Arrange
      fetchMock.mockResolvedValue(jsonResponse(200, { ok: true, data: null }));

      // Act
      await client.health();
      await client.deleteRoom('room-1');

      // Assert
      for (const call of fetchMock.mock.calls) {
        const init = call[1] as RequestInit;
        expect(init.credentials).toBe('include');
      }
    });
  });

  describe('query string construction', (it) => {
    it('builds listRooms with no query string when called with no filters', async () => {
      // Arrange
      fetchMock.mockResolvedValue(
        jsonResponse(200, { ok: true, data: { items: [], nextCursor: null } }),
      );

      // Act
      await client.listRooms();

      // Assert
      expect(fetchMock.mock.calls[0]?.[0]).toBe(`${BASE}/rooms/list`);
    });

    it('serializes search/cursor/limit for listRooms', async () => {
      // Arrange
      fetchMock.mockResolvedValue(
        jsonResponse(200, { ok: true, data: { items: [], nextCursor: null } }),
      );

      // Act
      await client.listRooms({ search: 'foo', cursor: 'c1', limit: 10 });

      // Assert
      expect(fetchMock.mock.calls[0]?.[0]).toBe(
        `${BASE}/rooms/list?search=foo&cursor=c1&limit=10`,
      );
    });

    it('omits an empty-string search rather than sending search=', async () => {
      // Arrange: an empty string is what a cleared MUI text field sends, and
      // the client treats it the same as "no filter" rather than searching
      // for the literal empty string.
      fetchMock.mockResolvedValue(
        jsonResponse(200, { ok: true, data: { items: [], nextCursor: null } }),
      );

      // Act
      await client.listRooms({ search: '' });

      // Assert
      expect(fetchMock.mock.calls[0]?.[0]).toBe(`${BASE}/rooms/list`);
    });

    it('serializes a boolean active=false for listDevices rather than omitting it', async () => {
      // Arrange: `false` is a meaningful filter value, distinct from
      // "unset" — only `undefined`/`null`/`''` are dropped by toQueryString.
      fetchMock.mockResolvedValue(
        jsonResponse(200, { ok: true, data: { items: [], nextCursor: null } }),
      );

      // Act
      await client.listDevices({ active: false });

      // Assert
      expect(fetchMock.mock.calls[0]?.[0]).toBe(
        `${BASE}/devices/list?active=false`,
      );
    });

    it('serializes roomUid/from/to for a schedules TimeRangeQuery', async () => {
      // Arrange
      fetchMock.mockResolvedValue(
        jsonResponse(200, { ok: true, data: { items: [] } }),
      );

      // Act
      await client.listSchedules({
        roomUid: 'room-1',
        from: '2026-01-01',
        to: '2026-01-31',
      });

      // Assert
      expect(fetchMock.mock.calls[0]?.[0]).toBe(
        `${BASE}/schedules/list?roomUid=room-1&from=2026-01-01&to=2026-01-31`,
      );
    });

    it('omits from/to on listAutoWindows when not given, keeping roomUid', async () => {
      // Arrange
      fetchMock.mockResolvedValue(
        jsonResponse(200, { ok: true, data: { items: [] } }),
      );

      // Act
      await client.listAutoWindows({ roomUid: 'room-1' });

      // Assert
      expect(fetchMock.mock.calls[0]?.[0]).toBe(
        `${BASE}/auto-windows/list?roomUid=room-1`,
      );
    });

    it('defaults listAudit to limit=50 when called with no argument', async () => {
      // Arrange
      fetchMock.mockResolvedValue(
        jsonResponse(200, { ok: true, data: { items: [] } }),
      );

      // Act
      await client.listAudit();

      // Assert
      expect(fetchMock.mock.calls[0]?.[0]).toBe(`${BASE}/audit?limit=50`);
    });

    it('serializes an explicit listAudit limit', async () => {
      // Arrange
      fetchMock.mockResolvedValue(
        jsonResponse(200, { ok: true, data: { items: [] } }),
      );

      // Act
      await client.listAudit(5);

      // Assert
      expect(fetchMock.mock.calls[0]?.[0]).toBe(`${BASE}/audit?limit=5`);
    });

    it('URL-encodes a path segment id (get-by-id routes, not query params)', async () => {
      // Arrange
      fetchMock.mockResolvedValue(
        jsonResponse(200, { ok: true, data: { roomUid: 'room a/b' } }),
      );

      // Act
      await client.getRoom('room a/b');

      // Assert
      expect(fetchMock.mock.calls[0]?.[0]).toBe(
        `${BASE}/rooms/get/room%20a%2Fb`,
      );
    });
  });

  describe('error mapping', (it) => {
    it('resolves with the unwrapped data on an ok envelope', async () => {
      // Arrange
      fetchMock.mockResolvedValue(
        jsonResponse(200, {
          ok: true,
          data: { bff: 'ok', components: [], checkedAt: 'now' },
        }),
      );

      // Act
      const result = await client.health();

      // Assert
      expect(result).toEqual({ bff: 'ok', components: [], checkedAt: 'now' });
    });

    it('throws an ApiError carrying the server code/message/status/requestId on a declared 404', async () => {
      // Arrange
      fetchMock.mockResolvedValue(
        jsonResponse(404, {
          ok: false,
          error: {
            code: 'ROOM_NOT_FOUND',
            message: 'No such room.',
            requestId: 'req-1',
          },
        }),
      );

      // Act
      const promise = client.getRoom('missing');

      // Assert
      await expect(promise).rejects.toMatchObject({
        code: 'ROOM_NOT_FOUND',
        message: 'No such room.',
        status: 404,
        requestId: 'req-1',
      });
      await expect(promise).rejects.toBeInstanceOf(ApiError);
    });

    it('passes through a 502 BACKEND_MISCONFIGURATION envelope error unchanged', async () => {
      // Arrange: the client applies no special-casing for this code — it's
      // just another declared envelope error. The interesting mapping (a
      // rejected admin key becoming 502 BACKEND_MISCONFIGURATION) happens
      // server-side in admin-server; see
      // session-manager-gateway.service.test.ts for that half.
      fetchMock.mockResolvedValue(
        jsonResponse(502, {
          ok: false,
          error: {
            code: 'BACKEND_MISCONFIGURATION',
            message: 'The admin API key was rejected upstream.',
          },
        }),
      );

      // Act
      const promise = client.fleet();

      // Assert
      await expect(promise).rejects.toMatchObject({
        code: 'BACKEND_MISCONFIGURATION',
        status: 502,
      });
    });

    it('invokes onUnauthorized and still throws on a 401', async () => {
      // Arrange
      const onUnauthorized = vi.fn();
      client.setOnUnauthorized(onUnauthorized);
      fetchMock.mockResolvedValue(
        jsonResponse(401, {
          ok: false,
          error: { code: 'UNAUTHENTICATED', message: 'Not logged in.' },
        }),
      );

      // Act
      const promise = client.me();

      // Assert
      await expect(promise).rejects.toMatchObject({
        code: 'UNAUTHENTICATED',
        status: 401,
      });
      expect(onUnauthorized).toHaveBeenCalledTimes(1);
    });

    it('does not throw from the 401 handling itself when no onUnauthorized callback was registered', async () => {
      // Arrange
      fetchMock.mockResolvedValue(
        jsonResponse(401, {
          ok: false,
          error: { code: 'UNAUTHENTICATED', message: 'Not logged in.' },
        }),
      );

      // Act / Assert
      await expect(client.me()).rejects.toMatchObject({ status: 401 });
    });

    it('maps a rejected fetch (offline / DNS failure) to a NETWORK ApiError with status 0', async () => {
      // Arrange
      fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));

      // Act
      const promise = client.health();

      // Assert
      await expect(promise).rejects.toMatchObject({
        code: 'NETWORK',
        status: 0,
      });
      await expect(promise).rejects.toBeInstanceOf(ApiError);
    });

    it('maps a non-ok response with an unparseable body to an UNKNOWN ApiError', async () => {
      // Arrange
      fetchMock.mockResolvedValue(unparseableResponse(500));

      // Act
      const promise = client.health();

      // Assert
      await expect(promise).rejects.toMatchObject({
        code: 'UNKNOWN',
        message: 'The request failed.',
        status: 500,
      });
    });

    it('maps a 200 response with an unparseable body to a distinct INVALID_RESPONSE ApiError', async () => {
      // Arrange: `_request` treats `res.ok && json?.ok` as the only success
      // path. A 200 whose body fails to parse as JSON falls through to the
      // error branch, but gets its own INVALID_RESPONSE code (rather than the
      // generic UNKNOWN used for a declared backend error) so callers can
      // tell "the server sent 2xx but garbage" apart from a real error.
      fetchMock.mockResolvedValue(unparseableResponse(200));

      // Act
      const promise = client.health();

      // Assert
      await expect(promise).rejects.toMatchObject({
        code: 'INVALID_RESPONSE',
        status: 200,
      });
    });

    it('maps a 200 response with an ok:false envelope to INVALID_RESPONSE rather than passing the envelope error through', async () => {
      // Arrange: a 2xx status paired with a declared `ok: false` envelope
      // never happens in the real BFF contract, but if it did, it should read
      // as an unexpected-response bug, not a trustworthy declared error.
      fetchMock.mockResolvedValue(
        jsonResponse(200, {
          ok: false,
          error: { code: 'ROOM_NOT_FOUND', message: 'No such room.' },
        }),
      );

      // Act
      const promise = client.health();

      // Assert
      await expect(promise).rejects.toMatchObject({
        code: 'INVALID_RESPONSE',
        status: 200,
      });
    });
  });

  describe('FLEET_STREAM_URL', (it) => {
    it('builds the fleet SSE endpoint under the admin API base path', () => {
      // Assert: EventSource can't reuse `_request` (no cookie header — it
      // relies on `withCredentials`), so this is a plain exported constant
      // rather than a method on the client.
      expect(FLEET_STREAM_URL).toBe(`${BASE}/fleet/stream`);
    });
  });
});

describe('isApiErrorCode', (it) => {
  it('returns true when the error is an ApiError with the matching code', () => {
    // Arrange
    const err = new ApiError('ROOM_NOT_FOUND', 'nope', 404);

    // Act / Assert
    expect(isApiErrorCode(err, 'ROOM_NOT_FOUND')).toBe(true);
  });

  it('returns false when the error is an ApiError with a different code', () => {
    // Arrange
    const err = new ApiError('ROOM_NOT_FOUND', 'nope', 404);

    // Act / Assert
    expect(isApiErrorCode(err, 'BACKEND_MISCONFIGURATION')).toBe(false);
  });

  it('returns false for a plain Error that is not an ApiError', () => {
    // Arrange
    const err = new Error('boom');

    // Act / Assert
    expect(isApiErrorCode(err, 'ROOM_NOT_FOUND')).toBe(false);
  });

  it('returns false for non-error values such as null or a string', () => {
    // Act / Assert
    expect(isApiErrorCode(null, 'ROOM_NOT_FOUND')).toBe(false);
    expect(isApiErrorCode('ROOM_NOT_FOUND', 'ROOM_NOT_FOUND')).toBe(false);
  });
});
