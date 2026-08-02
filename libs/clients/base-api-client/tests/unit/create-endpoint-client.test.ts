import { Type } from 'typebox';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  BaseRouteDefinition,
  BaseRouteSchema,
} from '@scribear/base-schema';

import {
  InvalidResponseBodyError,
  NetworkError,
  UnexpectedResponseError,
  createEndpointClient,
} from '#src/index.js';

const ROUTE: BaseRouteDefinition = {
  method: 'POST',
  url: '/api/v1/items/:itemId/action',
};

const SCHEMA = {
  description: 'Test endpoint with all input fields',
  tags: [],
  body: Type.Object({ name: Type.String() }),
  params: Type.Object({ itemId: Type.String() }),
  querystring: Type.Object({ filter: Type.String() }),
  headers: Type.Object({ authorization: Type.String() }),
  response: {
    200: Type.Object({ ok: Type.Boolean(), id: Type.String() }),
    422: Type.Object({ message: Type.String() }),
    // Mirrors STANDARD_ERROR_REPLIES, which every real route spreads in - so
    // 400 and 500 are *declared* statuses and reach the body parse.
    400: Type.Object({ code: Type.String(), message: Type.String() }),
    500: Type.Object({ code: Type.String(), message: Type.String() }),
  },
} satisfies BaseRouteSchema;

const NO_CONTENT_SCHEMA = {
  description: 'Test endpoint returning 204 No Content',
  tags: [],
  response: {
    204: Type.Null(),
    500: Type.Object({ code: Type.String(), message: Type.String() }),
  },
} satisfies BaseRouteSchema;

const NO_CONTENT_ROUTE: BaseRouteDefinition = {
  method: 'DELETE',
  url: '/api/v1/simple',
};

const MINIMAL_SCHEMA = {
  description: 'Test endpoint with no input fields',
  tags: [],
  response: {
    200: Type.Object({ value: Type.Number() }),
  },
} satisfies BaseRouteSchema;

const MINIMAL_ROUTE: BaseRouteDefinition = {
  method: 'GET',
  url: '/api/v1/simple',
};

const BASE_URL = 'http://localhost:3000';

const DEFAULT_PARAMS = {
  body: { name: 'test' },
  params: { itemId: 'item-1' },
  querystring: { filter: 'active' },
  headers: { authorization: 'Bearer token' },
} as const;

describe('createEndpointClient', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ ok: true, id: 'abc' }), {
          status: 200,
        }),
      ),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('successful responses', () => {
    it('returns typed 200 response in result slot', async () => {
      // Arrange
      const responseBody = { ok: true, id: 'abc123' };
      vi.stubGlobal(
        'fetch',
        vi
          .fn()
          .mockResolvedValue(
            new Response(JSON.stringify(responseBody), { status: 200 }),
          ),
      );
      const client = createEndpointClient(SCHEMA, ROUTE, BASE_URL);

      // Act
      const [response, error] = await client(DEFAULT_PARAMS);

      // Assert
      expect(error).toBeNull();
      expect(response).toStrictEqual({ status: 200, data: responseBody });
    });

    it('returns typed non-2xx response in result slot', async () => {
      // Arrange
      const errorBody = { message: 'Validation failed' };
      vi.stubGlobal(
        'fetch',
        vi
          .fn()
          .mockResolvedValue(
            new Response(JSON.stringify(errorBody), { status: 422 }),
          ),
      );
      const client = createEndpointClient(SCHEMA, ROUTE, BASE_URL);

      // Act
      const [response, error] = await client(DEFAULT_PARAMS);

      // Assert
      expect(error).toBeNull();
      expect(response).toStrictEqual({ status: 422, data: errorBody });
    });

    it('accepts empty params object when schema has no input fields', async () => {
      // Arrange
      const responseBody = { value: 42 };
      vi.stubGlobal(
        'fetch',
        vi
          .fn()
          .mockResolvedValue(
            new Response(JSON.stringify(responseBody), { status: 200 }),
          ),
      );
      const client = createEndpointClient(
        MINIMAL_SCHEMA,
        MINIMAL_ROUTE,
        BASE_URL,
      );

      // Act
      const [response, error] = await client({});

      // Assert
      expect(error).toBeNull();
      expect(response).toStrictEqual({ status: 200, data: responseBody });
    });
  });

  describe('URL building', () => {
    it('substitutes :param tokens in the URL', async () => {
      // Arrange
      const fetchSpy = vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ ok: true, id: '1' }), { status: 200 }),
        );
      vi.stubGlobal('fetch', fetchSpy);
      const client = createEndpointClient(SCHEMA, ROUTE, BASE_URL);

      // Act
      await client(DEFAULT_PARAMS);

      // Assert
      const calledUrl = (fetchSpy.mock.calls[0] as [string])[0];
      expect(calledUrl).toContain('/api/v1/items/item-1/action');
    });

    it('appends querystring fields as URL search params', async () => {
      // Arrange
      const fetchSpy = vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ ok: true, id: '1' }), { status: 200 }),
        );
      vi.stubGlobal('fetch', fetchSpy);
      const client = createEndpointClient(SCHEMA, ROUTE, BASE_URL);

      // Act
      await client(DEFAULT_PARAMS);

      // Assert
      const calledUrl = (fetchSpy.mock.calls[0] as [string])[0];
      expect(calledUrl).toContain('filter=active');
    });
  });

  describe('error cases', () => {
    it('returns NetworkError when fetch() throws', async () => {
      // Arrange
      vi.stubGlobal(
        'fetch',
        vi.fn().mockRejectedValue(new TypeError('Failed to fetch')),
      );
      const client = createEndpointClient(SCHEMA, ROUTE, BASE_URL);

      // Act
      const [response, error] = await client(DEFAULT_PARAMS);

      // Assert
      expect(response).toBeNull();
      expect(error).toBeInstanceOf(NetworkError);
    });

    it('NetworkError preserves the original cause', async () => {
      // Arrange
      const originalError = new TypeError('Failed to fetch');
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(originalError));
      const client = createEndpointClient(SCHEMA, ROUTE, BASE_URL);

      // Act
      const [, error] = await client(DEFAULT_PARAMS);

      // Assert
      expect((error as NetworkError).cause).toBe(originalError);
    });

    it('returns UnexpectedResponseError when response status has no schema defined', async () => {
      // Arrange
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          new Response(JSON.stringify({ message: 'Forbidden' }), {
            status: 403,
          }),
        ),
      );
      const client = createEndpointClient(SCHEMA, ROUTE, BASE_URL);

      // Act
      const [response, error] = await client(DEFAULT_PARAMS);

      // Assert
      expect(response).toBeNull();
      expect(error).toBeInstanceOf(UnexpectedResponseError);
      expect((error as UnexpectedResponseError).status).toBe(403);
    });

    it('returns UnexpectedResponseError when 200 body does not match schema', async () => {
      // Arrange
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          new Response(JSON.stringify({ unexpected: 'field' }), {
            status: 200,
          }),
        ),
      );
      const client = createEndpointClient(SCHEMA, ROUTE, BASE_URL);

      // Act
      const [response, error] = await client(DEFAULT_PARAMS);

      // Assert
      expect(response).toBeNull();
      expect(error).toBeInstanceOf(UnexpectedResponseError);
      expect((error as UnexpectedResponseError).status).toBe(200);
    });

    it('returns UnexpectedResponseError when 422 body does not match schema', async () => {
      // Arrange
      vi.stubGlobal(
        'fetch',
        vi
          .fn()
          .mockResolvedValue(
            new Response(JSON.stringify({ wrong: true }), { status: 422 }),
          ),
      );
      const client = createEndpointClient(SCHEMA, ROUTE, BASE_URL);

      // Act
      const [response, error] = await client(DEFAULT_PARAMS);

      // Assert
      expect(response).toBeNull();
      expect(error).toBeInstanceOf(UnexpectedResponseError);
      expect((error as UnexpectedResponseError).status).toBe(422);
    });

    it('returns a plain UnexpectedResponseError - not InvalidResponseBodyError - on schema mismatch', async () => {
      // Arrange
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          new Response(JSON.stringify({ unexpected: 'field' }), {
            status: 200,
          }),
        ),
      );
      const client = createEndpointClient(SCHEMA, ROUTE, BASE_URL);

      // Act
      const [, error] = await client(DEFAULT_PARAMS);

      // Assert
      expect(error).toBeInstanceOf(UnexpectedResponseError);
      expect(error).not.toBeInstanceOf(InvalidResponseBodyError);
    });
  });

  describe('unparseable response bodies on declared statuses', () => {
    it('returns InvalidResponseBodyError for an HTML error page on a declared 500', async () => {
      // Arrange
      vi.stubGlobal(
        'fetch',
        vi
          .fn()
          .mockResolvedValue(
            new Response(
              '<html><head><title>500 Internal Server Error</title></head><body><center><h1>500 Internal Server Error</h1></center><hr><center>nginx</center></body></html>',
              { status: 500, headers: { 'Content-Type': 'text/html' } },
            ),
          ),
      );
      const client = createEndpointClient(SCHEMA, ROUTE, BASE_URL);

      // Act
      const [response, error] = await client(DEFAULT_PARAMS);

      // Assert
      expect(response).toBeNull();
      expect(error).toBeInstanceOf(InvalidResponseBodyError);
      expect((error as InvalidResponseBodyError).status).toBe(500);
    });

    it('returns InvalidResponseBodyError for an empty body on a declared 400', async () => {
      // Arrange
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(new Response('', { status: 400 })),
      );
      const client = createEndpointClient(SCHEMA, ROUTE, BASE_URL);

      // Act
      const [response, error] = await client(DEFAULT_PARAMS);

      // Assert
      expect(response).toBeNull();
      expect(error).toBeInstanceOf(InvalidResponseBodyError);
      expect((error as InvalidResponseBodyError).status).toBe(400);
    });

    it('returns InvalidResponseBodyError for a null body on a declared 400', async () => {
      // Arrange
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(new Response(null, { status: 400 })),
      );
      const client = createEndpointClient(SCHEMA, ROUTE, BASE_URL);

      // Act
      const [response, error] = await client(DEFAULT_PARAMS);

      // Assert
      expect(response).toBeNull();
      expect(error).toBeInstanceOf(InvalidResponseBodyError);
      expect((error as InvalidResponseBodyError).status).toBe(400);
    });

    it('returns InvalidResponseBodyError for truncated JSON on a declared 200', async () => {
      // Arrange
      vi.stubGlobal(
        'fetch',
        vi
          .fn()
          .mockResolvedValue(
            new Response('{"ok":true,"id":"ab', { status: 200 }),
          ),
      );
      const client = createEndpointClient(SCHEMA, ROUTE, BASE_URL);

      // Act
      const [response, error] = await client(DEFAULT_PARAMS);

      // Assert
      expect(response).toBeNull();
      expect(error).toBeInstanceOf(InvalidResponseBodyError);
      expect((error as InvalidResponseBodyError).status).toBe(200);
    });

    it('returns InvalidResponseBodyError when the body stream fails mid-read', async () => {
      // Arrange
      const streamFailure = new TypeError('terminated');
      const brokenResponse = {
        status: 500,
        json: (): Promise<unknown> => Promise.reject(streamFailure),
      } as unknown as Response;
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(brokenResponse));
      const client = createEndpointClient(SCHEMA, ROUTE, BASE_URL);

      // Act
      const [response, error] = await client(DEFAULT_PARAMS);

      // Assert
      expect(response).toBeNull();
      expect(error).toBeInstanceOf(InvalidResponseBodyError);
      expect((error as InvalidResponseBodyError).cause).toBe(streamFailure);
    });

    it('resolves rather than rejecting, honouring the tuple contract', async () => {
      // Arrange
      vi.stubGlobal(
        'fetch',
        vi
          .fn()
          .mockResolvedValue(
            new Response('<html>502 Bad Gateway</html>', { status: 500 }),
          ),
      );
      const client = createEndpointClient(SCHEMA, ROUTE, BASE_URL);

      // Act & Assert
      await expect(client(DEFAULT_PARAMS)).resolves.toBeInstanceOf(Array);
    });

    it('preserves the underlying parse failure as the error cause', async () => {
      // Arrange
      vi.stubGlobal(
        'fetch',
        vi
          .fn()
          .mockResolvedValue(new Response('not json at all', { status: 500 })),
      );
      const client = createEndpointClient(SCHEMA, ROUTE, BASE_URL);

      // Act
      const [, error] = await client(DEFAULT_PARAMS);

      // Assert
      expect((error as InvalidResponseBodyError).cause).toBeInstanceOf(
        SyntaxError,
      );
    });

    it('InvalidResponseBodyError is an UnexpectedResponseError so existing branches still match', async () => {
      // Arrange
      vi.stubGlobal(
        'fetch',
        vi
          .fn()
          .mockResolvedValue(
            new Response('<html>oops</html>', { status: 500 }),
          ),
      );
      const client = createEndpointClient(SCHEMA, ROUTE, BASE_URL);

      // Act
      const [, error] = await client(DEFAULT_PARAMS);

      // Assert
      expect(error).toBeInstanceOf(UnexpectedResponseError);
      expect(error).not.toBeInstanceOf(NetworkError);
      expect((error as Error).name).toBe('InvalidResponseBodyError');
    });

    it('still short-circuits an empty 204 before parsing', async () => {
      // Arrange
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(new Response(null, { status: 204 })),
      );
      const client = createEndpointClient(
        NO_CONTENT_SCHEMA,
        NO_CONTENT_ROUTE,
        BASE_URL,
      );

      // Act
      const [response, error] = await client({});

      // Assert
      expect(error).toBeNull();
      expect(response).toStrictEqual({ status: 204, data: null });
    });

    it('leaves the undeclared-status path returning UnexpectedResponseError before any parse', async () => {
      // Arrange
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          new Response('<html>502 Bad Gateway</html>', {
            status: 502,
            headers: { 'Content-Type': 'text/html' },
          }),
        ),
      );
      const client = createEndpointClient(SCHEMA, ROUTE, BASE_URL);

      // Act
      const [response, error] = await client(DEFAULT_PARAMS);

      // Assert
      expect(response).toBeNull();
      expect(error).toBeInstanceOf(UnexpectedResponseError);
      expect(error).not.toBeInstanceOf(InvalidResponseBodyError);
      expect((error as UnexpectedResponseError).status).toBe(502);
    });
  });
});
