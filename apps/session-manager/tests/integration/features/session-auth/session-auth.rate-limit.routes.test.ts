import { Value } from 'typebox/value';
import { describe, expect } from 'vitest';

import {
  EXCHANGE_JOIN_CODE_SCHEMA,
  REFRESH_SESSION_TOKEN_SCHEMA,
} from '@scribear/session-manager-schema';

import { useDb } from '#tests/utils/use-db.js';
import { ADMIN_HEADER, useServer } from '#tests/utils/use-server.js';

const DEVICE_BASE = '/api/session-manager/v1/device-management';
const ROOM_BASE = '/api/session-manager/v1/room-management';
const SCHEDULE_BASE = '/api/session-manager/v1/schedule-management';
const SESSION_AUTH_BASE = '/api/session-manager/v1/session-auth';

/**
 * Small enough to reach in a handful of requests. Before the limits moved into
 * `AppConfig` these tests had to send 100 real requests per route to reach a
 * hard-coded ceiling, and then left both routes limited for the remainder of a
 * real 60-second window - which is why they lived in a file of their own with
 * a warning attached. They still get their own `useServer` per scenario,
 * because `@fastify/rate-limit`'s default store is in-memory and per-instance,
 * so a fresh server is a fresh budget; but nothing here spends real time now.
 *
 * `useServer`'s defaults leave every limit effectively unlimited, so each
 * `describe` below tightens exactly the one limit it is about and proves the
 * others did not fire.
 */
const TINY_MAX = 3;

/** Long enough that no test can accidentally roll over into a fresh window. */
const WINDOW_MS = 60_000;

type Server = ReturnType<typeof useServer>;

function post(server: Server, url: string, body: Record<string, unknown>) {
  return server.fastify.inject({ method: 'POST', url, body });
}

/**
 * Spend `count` requests on `url`, asserting along the way that nothing 429s
 * early (which would mean a previous test leaked into this one).
 */
async function spend(
  server: Server,
  url: string,
  body: Record<string, unknown>,
  count: number,
) {
  for (let i = 0; i < count; i++) {
    const res = await post(server, url, body);
    expect(res.statusCode).not.toBe(429);
  }
}

describe('Session Auth rate limiting', () => {
  describe('POST /exchange-join-code - volumetric cap', (it) => {
    const server = useServer({
      sessionAuthRateLimitConfig: {
        exchangeJoinCodeMax: TINY_MAX,
        exchangeJoinCodeWindowMs: WINDOW_MS,
      },
    });
    const url = `${SESSION_AUTH_BASE}/exchange-join-code`;

    it('answers a rate-limited join with a 429 the route declares', async () => {
      // Arrange - an unknown join code 404s, which still counts against the
      // volumetric limit. The limiter runs before the handler, so no fixtures
      // are needed. (The *failed*-exchange cap is left unlimited by
      // `useServer`'s defaults, so the 429 below can only be the volumetric
      // one.)
      await spend(server, url, { joinCode: 'NOPE0000' }, TINY_MAX);

      // Act
      const res = await post(server, url, { joinCode: 'NOPE0000' });

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
      const res = await post(server, url, { joinCode: 'NOPE0000' });

      // Assert - the header is real (so a future client that can read headers
      // has something to use), but it is never larger than the window, and
      // `createEndpointClient` discards headers entirely today. Nothing in the
      // UI may promise a countdown until that changes.
      expect(res.statusCode).toBe(429);
      const retryAfter = Number(res.headers['retry-after']);
      expect(Number.isNaN(retryAfter)).toBe(false);
      expect(retryAfter).toBeGreaterThan(0);
      expect(retryAfter).toBeLessThanOrEqual(WINDOW_MS / 1000);
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

  describe('POST /refresh-session-token - volumetric cap', (it) => {
    const server = useServer({
      sessionAuthRateLimitConfig: {
        refreshSessionTokenMax: TINY_MAX,
        refreshSessionTokenWindowMs: WINDOW_MS,
      },
    });
    const url = `${SESSION_AUTH_BASE}/refresh-session-token`;

    it('answers a rate-limited refresh with a 429 the route declares', async () => {
      // Arrange - a malformed refresh token 401s without touching the DB,
      // which is the cheapest way to spend the window on this route.
      await spend(server, url, { sessionRefreshToken: 'not-a-real-token' }, 3);

      // Act
      const res = await post(server, url, {
        sessionRefreshToken: 'not-a-real-token',
      });

      // Assert
      expect(res.statusCode).toBe(429);
      expect(res.json<{ code: string }>().code).toBe('RATE_LIMITED');
      expect(
        Value.Check(REFRESH_SESSION_TOKEN_SCHEMA.response[429], res.json()),
      ).toBe(true);
    });

    it('keeps a separate budget from exchange-join-code', async () => {
      // Arrange - refresh is still exhausted from the previous test. Every
      // route with its own `config.rateLimit` gets its own store, and the two
      // limits are now separate config values as well; a shared bucket would
      // mean tuning one silently retuned the other.
      const res = await post(
        server,
        `${SESSION_AUTH_BASE}/exchange-join-code`,
        {
          joinCode: 'NOPE0000',
        },
      );

      // 404 (no such code), emphatically not 429.
      expect(res.statusCode).toBe(404);
    });
  });

  describe('POST /exchange-join-code - failed-attempt cap', (it) => {
    const server = useServer({
      sessionAuthRateLimitConfig: {
        failedExchangeJoinCodeMax: TINY_MAX,
        failedExchangeJoinCodeWindowMs: WINDOW_MS,
      },
    });
    const url = `${SESSION_AUTH_BASE}/exchange-join-code`;

    it('blocks after the configured number of 404s, with the declared 429', async () => {
      // Arrange - the volumetric cap is left unlimited by `useServer`'s
      // defaults, so this 429 can only be the failed-attempt cap.
      await spend(server, url, { joinCode: 'AAAA0000' }, TINY_MAX);

      // Act
      const res = await post(server, url, { joinCode: 'AAAA0000' });

      // Assert
      expect(res.statusCode).toBe(429);
      expect(res.json<{ code: string }>().code).toBe('RATE_LIMITED');
      expect(
        Value.Check(EXCHANGE_JOIN_CODE_SCHEMA.response[429], res.json()),
      ).toBe(true);
      expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
    });
  });

  describe('POST /exchange-join-code - failed-attempt cap keying', (it) => {
    const server = useServer({
      sessionAuthRateLimitConfig: {
        failedExchangeJoinCodeMax: TINY_MAX,
        failedExchangeJoinCodeWindowMs: WINDOW_MS,
      },
    });
    const url = `${SESSION_AUTH_BASE}/exchange-join-code`;

    it('counts guesses of DIFFERENT codes into the same per-IP bucket', async () => {
      // This is the trap the design note in the router warns about: keying the
      // limiter on the submitted join code would hand a guesser a fresh bucket
      // per guess, making the control strictly worse than nothing. A guesser
      // never repeats a code, so a per-code bucket would never fire - which is
      // exactly what this asserts is not happening.
      await spend(server, url, { joinCode: 'AAAA0001' }, 1);
      await spend(server, url, { joinCode: 'BBBB0002' }, 1);
      await spend(server, url, { joinCode: 'CCCC0003' }, 1);

      const res = await post(server, url, { joinCode: 'DDDD0004' });

      expect(res.statusCode).toBe(429);
    });
  });

  describe('POST /exchange-join-code - what the failed-attempt cap ignores', (it) => {
    const server = useServer({
      sessionAuthRateLimitConfig: {
        failedExchangeJoinCodeMax: TINY_MAX,
        failedExchangeJoinCodeWindowMs: WINDOW_MS,
      },
    });
    const dbContext = useDb([
      'session_join_codes',
      'session_refresh_tokens',
      'sessions',
      'rooms',
      'devices',
    ]);
    const url = `${SESSION_AUTH_BASE}/exchange-join-code`;

    /**
     * A registered source device, a room, and a live on-demand session. The
     * device is never activated: only the device-token routes need that, and
     * nothing here calls one.
     */
    async function setupLiveSession(): Promise<string> {
      const device = await server.fastify
        .inject({
          method: 'POST',
          url: `${DEVICE_BASE}/register-device`,
          headers: { authorization: ADMIN_HEADER },
          body: { name: 'Rate Limit Source' },
        })
        .then((res) => res.json<{ deviceUid: string }>());

      const roomUid = await server.fastify
        .inject({
          method: 'POST',
          url: `${ROOM_BASE}/create-room`,
          headers: { authorization: ADMIN_HEADER },
          body: {
            name: 'Rate Limit Room',
            timezone: 'America/New_York',
            autoSessionEnabled: false,
            sourceDeviceUids: [device.deviceUid],
          },
        })
        .then((res) => res.json<{ uid: string }>().uid);

      const res = await server.fastify.inject({
        method: 'POST',
        url: `${SCHEDULE_BASE}/create-on-demand-session`,
        headers: { authorization: ADMIN_HEADER },
        body: {
          roomUid,
          name: 'Rate Limit Session',
          joinCodeScopes: ['RECEIVE_TRANSCRIPTIONS'],
          transcriptionProviderId: 'whisper',
          transcriptionStreamConfig: {},
        },
      });
      // Asserted, not assumed: a fixture that quietly 400s would leave every
      // test below exchanging against a session that does not exist, and they
      // would all pass while proving nothing.
      expect(res.statusCode).toBe(201);
      return res.json<{ uid: string }>().uid;
    }

    async function mintJoinCode(sessionUid: string): Promise<string> {
      const res = await server.fastify.inject({
        method: 'POST',
        url: `${SESSION_AUTH_BASE}/admin-fetch-join-code`,
        headers: { authorization: ADMIN_HEADER },
        body: { sessionUid },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json<{ status: string; joinCode: string | null }>();
      expect(body.status).toBe('ok');
      return body.joinCode!;
    }

    it('does not spend the budget on successful exchanges', async () => {
      // Arrange - a real, live join code. A code is exchangeable any number of
      // times within its window (each exchange mints a fresh clientId), so a
      // lecture hall is a stream of 200s from one IP.
      const sessionUid = await setupLiveSession();
      const joinCode = await mintJoinCode(sessionUid);

      // Act - more successful exchanges than the failed-attempt cap allows.
      for (let i = 0; i < TINY_MAX + 2; i++) {
        const res = await post(server, url, { joinCode });

        // Assert - if 200s were charged, this would 429 partway through, and
        // a full hall would lock itself out by joining normally.
        expect(res.statusCode).toBe(200);
      }
    });

    it('does not spend the budget on an expired code (410)', async () => {
      // Arrange - a code whose window has already closed, which is what an
      // entire room gets when a stale code is left on the projector. Charging
      // that would lock the room out of joining even after the display is
      // fixed, so 410 is deliberately excluded from the count.
      const sessionUid = await setupLiveSession();
      await dbContext.db
        .insertInto('session_join_codes')
        .values({
          join_code: 'EXPIRED1',
          session_uid: sessionUid,
          valid_start: new Date(Date.now() - 10 * 60 * 1000),
          valid_end: new Date(Date.now() - 5 * 60 * 1000),
        })
        .execute();

      // Act / Assert - more expired exchanges than the cap allows, all 410.
      for (let i = 0; i < TINY_MAX + 2; i++) {
        const res = await post(server, url, { joinCode: 'EXPIRED1' });
        expect(res.statusCode).toBe(410);
      }
    });
  });
});
