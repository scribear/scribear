import { Type } from 'typebox';
import { Value } from 'typebox/value';
import { describe, expect } from 'vitest';

import { TEST_USERNAME, useServer } from '#tests/utils/use-server.js';

const BASE = '/api/admin/v1';

/**
 * What the admin console actually parses out of a 429.
 *
 * Deliberately NOT `RATE_LIMITED_REPLY_SCHEMA` from `@scribear/base-schema`:
 * admin-server is a BFF and overrides the base error handler so every failure
 * is the `{ ok: false, error: { … } }` envelope the SPA expects, rather than a
 * bare `ErrorReply`. Nothing in admin-server declares a `response` map for its
 * error statuses, so this schema is the only executable statement of the
 * contract — `AdminApiClient._request` and `ApiError` in admin-webapp read
 * exactly these fields, and `rateLimitMessage` reads `details.retryAfter`.
 *
 * `Value.Check` here is the same check `createEndpointClient` runs against a
 * declared response schema in the services that use one.
 */
const RATE_LIMITED_ENVELOPE_SCHEMA = Type.Object(
  {
    ok: Type.Literal(false),
    error: Type.Object({
      code: Type.Literal('RATE_LIMITED'),
      message: Type.String({ minLength: 1 }),
      requestId: Type.String({ minLength: 1 }),
      details: Type.Object({
        // Display copy from `@fastify/rate-limit` ("1 minute", "45 seconds"),
        // not a number of seconds. The console renders it verbatim.
        retryAfter: Type.String({ minLength: 1 }),
      }),
    }),
  },
  { additionalProperties: false },
);

describe('Global rate limiting', () => {
  // `global: true` in rate-limit.plugin.ts, so a route that declares no
  // `config.rateLimit` of its own is still limited. Two requests, then 429.
  const server = useServer({
    rateLimitConfig: { globalMax: 2, globalWindowMs: 60_000 },
  });

  describe('a route with no rate limit of its own', (it) => {
    it('is limited anyway, because the limiter is registered globally', async () => {
      // Act — /auth/config carries no `config.rateLimit`; only the global one
      // can throttle it.
      const codes: number[] = [];
      for (let i = 0; i < 3; i++) {
        const res = await server.fastify.inject({
          method: 'GET',
          url: `${BASE}/auth/config`,
        });
        codes.push(res.statusCode);
      }

      // Assert
      expect(codes).toEqual([200, 200, 429]);
    });
  });
});

describe('Rate-limited response body', () => {
  const server = useServer({
    rateLimitConfig: { globalMax: 1, globalWindowMs: 60_000 },
  });

  describe('the 429 an admin route emits', (it) => {
    it('is the canonical admin error envelope, with a retryAfter the console can render', async () => {
      // Arrange — burn the single allowed request.
      await server.fastify.inject({
        method: 'GET',
        url: `${BASE}/auth/config`,
      });

      // Act
      const res = await server.fastify.inject({
        method: 'GET',
        url: `${BASE}/auth/config`,
      });

      // Assert — the shape admin-webapp parses, checked the way
      // `createEndpointClient` checks a declared schema.
      expect(res.statusCode).toBe(429);
      const body: unknown = res.json();
      expect(Value.Check(RATE_LIMITED_ENVELOPE_SCHEMA, body)).toBe(true);
      expect(body).toMatchObject({
        ok: false,
        error: {
          code: 'RATE_LIMITED',
          details: { retryAfter: '1 minute' },
        },
      });
      // The header is set too, but no client in this repo can read it — which
      // is why the value is duplicated into `details.retryAfter`.
      expect(res.headers['retry-after']).toBeDefined();
    });
  });
});

describe('Probe routes opt out of rate limiting', () => {
  const server = useServer({
    rateLimitConfig: { globalMax: 1, globalWindowMs: 60_000 },
  });

  describe('GET /probes/liveness', (it) => {
    it('still answers 200 after the global window is exhausted', async () => {
      // Arrange — exhaust the global bucket on a route that is limited.
      await server.fastify.inject({
        method: 'GET',
        url: `${BASE}/auth/config`,
      });
      const limited = await server.fastify.inject({
        method: 'GET',
        url: `${BASE}/auth/config`,
      });
      expect(limited.statusCode).toBe(429);

      // Act — `config: { rateLimit: false }` on the probe router.
      const codes: number[] = [];
      for (let i = 0; i < 3; i++) {
        const res = await server.fastify.inject({
          method: 'GET',
          url: `${BASE}/probes/liveness`,
        });
        codes.push(res.statusCode);
      }

      // Assert
      expect(codes).toEqual([200, 200, 200]);
    });
  });
});

describe('Login rate limiting body', () => {
  // The tighter per-route limit — the realistic trigger, since an operator
  // mistyping a password reaches it in seconds.
  const server = useServer({
    rateLimitConfig: { loginMax: 1, loginWindowMs: 60_000 },
  });

  describe('POST /auth/login', (it) => {
    it('answers RATE_LIMITED, not INVALID_CREDENTIALS, once the login limit is spent', async () => {
      // Arrange — one allowed (failing) attempt.
      const first = await server.fastify.inject({
        method: 'POST',
        url: `${BASE}/auth/login`,
        payload: { username: TEST_USERNAME, password: 'wrong' },
      });
      expect(first.statusCode).toBe(401);
      expect(first.json<{ error: { code: string } }>().error.code).toBe(
        'INVALID_CREDENTIALS',
      );

      // Act
      const res = await server.fastify.inject({
        method: 'POST',
        url: `${BASE}/auth/login`,
        payload: { username: TEST_USERNAME, password: 'wrong' },
      });

      // Assert — the console distinguishes these two by `status`, so the 429
      // must not arrive wearing the credential error's code.
      expect(res.statusCode).toBe(429);
      expect(Value.Check(RATE_LIMITED_ENVELOPE_SCHEMA, res.json())).toBe(true);
      expect(res.json<{ error: { code: string } }>().error.code).toBe(
        'RATE_LIMITED',
      );
    });
  });
});
