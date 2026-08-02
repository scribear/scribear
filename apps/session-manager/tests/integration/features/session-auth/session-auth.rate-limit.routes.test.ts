import { Value } from 'typebox/value';
import { describe, expect } from 'vitest';

import {
  EXCHANGE_JOIN_CODE_SCHEMA,
  REFRESH_SESSION_TOKEN_SCHEMA,
} from '@scribear/session-manager-schema';

import { useServer } from '#tests/utils/use-server.js';

const SESSION_AUTH_BASE = '/api/session-manager/v1/session-auth';

/**
 * Mirrors `config.rateLimit.max` on both credential-exchange routes in
 * `session-auth.router.ts`. Not imported from there: the router hard-codes it,
 * and the point of these tests is that the *declared contract* matches what
 * the limiter actually emits, so duplicating the number keeps the assertion
 * honest if someone changes one and not the other.
 */
const RATE_LIMIT_MAX = 100;

/**
 * These tests deliberately burn a whole rate-limit window, which leaves both
 * routes limited for the remainder of the 60 s window. They therefore live in
 * their own file with their own `useServer()` - `@fastify/rate-limit`'s
 * default store is in-memory and per-instance, so a fresh server is a fresh
 * budget, and the main `session-auth.routes.test.ts` suite is unaffected.
 */
describe('Session Auth rate limiting', () => {
  const server = useServer();

  function post(url: string, body: Record<string, unknown>) {
    return server.fastify.inject({ method: 'POST', url, body });
  }

  /**
   * Spend the whole window on `url`, asserting along the way that nothing 429s
   * early (which would mean a previous test leaked into this one).
   */
  async function exhaustWindow(url: string, body: Record<string, unknown>) {
    for (let i = 0; i < RATE_LIMIT_MAX; i++) {
      const res = await post(url, body);
      expect(res.statusCode).not.toBe(429);
    }
  }

  describe('POST /exchange-join-code', (it) => {
    it('answers a rate-limited join with a 429 the route declares', async () => {
      // Arrange - an unknown join code 404s, which still counts against the
      // limit. The limiter runs before the handler, so no fixtures are needed.
      const url = `${SESSION_AUTH_BASE}/exchange-join-code`;
      await exhaustWindow(url, { joinCode: 'NOPE0000' });

      // Act
      const res = await post(url, { joinCode: 'NOPE0000' });

      // Assert - the body is the canonical ErrorReply shape, and it validates
      // against the schema the route declares for 429. That check is exactly
      // what `createEndpointClient` performs: pass it and the browser gets a
      // typed `{ status: 429 }` response; fail it (or leave 429 undeclared, as
      // it was) and the same reply collapses into `UnexpectedResponseError`
      // and, downstream, "Unable to join session. Please try again."
      expect(res.statusCode).toBe(429);
      expect(res.json<{ code: string }>().code).toBe('RATE_LIMITED');
      expect(
        Value.Check(EXCHANGE_JOIN_CODE_SCHEMA.response[429], res.json()),
      ).toBe(true);
    });

    it('sets retry-after on the 429, in seconds', async () => {
      // Arrange - the window from the previous test is still spent.
      const res = await post(`${SESSION_AUTH_BASE}/exchange-join-code`, {
        joinCode: 'NOPE0000',
      });

      // Assert - the header is real (so a future client that can read headers
      // has something to use), but it is never larger than the window, and
      // `createEndpointClient` discards headers entirely today. Nothing in the
      // UI may promise a countdown until that changes.
      expect(res.statusCode).toBe(429);
      const retryAfter = Number(res.headers['retry-after']);
      expect(Number.isNaN(retryAfter)).toBe(false);
      expect(retryAfter).toBeGreaterThan(0);
      expect(retryAfter).toBeLessThanOrEqual(60);
    });

    it('does not limit routes that never opted in', async () => {
      // The plugin is registered with `global: false`, so exhausting this
      // route must not touch any other. This is the whole justification for
      // declaring 429 per route instead of adding it to STANDARD_ERROR_REPLIES:
      // if a limit could fire anywhere, a global declaration would be right.
      const res = await server.fastify.inject({
        method: 'POST',
        url: `${SESSION_AUTH_BASE}/fetch-join-code`,
        body: { sessionUid: '00000000-0000-4000-8000-000000000000' },
      });

      // 401 (no device token), emphatically not 429.
      expect(res.statusCode).toBe(401);
    });
  });

  describe('POST /refresh-session-token', (it) => {
    it('answers a rate-limited refresh with a 429 the route declares', async () => {
      // Arrange - a malformed refresh token 401s without touching the DB,
      // which is the cheapest way to spend the window on this route. Its
      // budget is independent of exchange-join-code's: `@fastify/rate-limit`
      // gives every route with its own `config.rateLimit` its own store.
      const url = `${SESSION_AUTH_BASE}/refresh-session-token`;
      await exhaustWindow(url, { sessionRefreshToken: 'not-a-real-token' });

      // Act
      const res = await post(url, { sessionRefreshToken: 'not-a-real-token' });

      // Assert
      expect(res.statusCode).toBe(429);
      expect(res.json<{ code: string }>().code).toBe('RATE_LIMITED');
      expect(
        Value.Check(REFRESH_SESSION_TOKEN_SCHEMA.response[429], res.json()),
      ).toBe(true);
    });
  });
});
