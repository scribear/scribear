import { afterEach, beforeEach, describe, expect } from 'vitest';

import { SessionManagerMock } from '#tests/utils/mock-session-manager.js';
import {
  TEST_PASSWORD,
  TEST_USERNAME,
  login,
  useServer,
} from '#tests/utils/use-server.js';

const BASE = '/api/admin/v1';

describe('Auth routes', () => {
  const server = useServer();
  let sm: SessionManagerMock;
  beforeEach(() => {
    sm = new SessionManagerMock();
  });
  afterEach(() => {
    sm.restore();
  });

  describe('GET /auth/config', (it) => {
    it('reports local enabled, sso disabled', async () => {
      // Act
      const res = await server.fastify.inject({
        method: 'GET',
        url: `${BASE}/auth/config`,
      });

      // Assert
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        ok: true,
        data: { local: true, sso: false, grafana: false },
      });
    });
  });

  describe('POST /auth/login', (it) => {
    it('succeeds with valid credentials and sets an HttpOnly session cookie', async () => {
      // Act
      const res = await server.fastify.inject({
        method: 'POST',
        url: `${BASE}/auth/login`,
        payload: { username: TEST_USERNAME, password: TEST_PASSWORD },
      });

      // Assert
      expect(res.statusCode).toBe(200);
      const setCookie = String(res.headers['set-cookie']);
      expect(setCookie).toContain('admin_session=');
      expect(setCookie.toLowerCase()).toContain('httponly');
      expect(setCookie.toLowerCase()).toContain('samesite=strict');
      const body = res.json<{
        ok: boolean;
        data: {
          identity: { subject: string; roles: string[] };
          csrfToken: string;
        };
      }>();
      expect(body.ok).toBe(true);
      expect(body.data.identity.subject).toBe(TEST_USERNAME);
      expect(body.data.identity.roles).toContain('read-write');
      expect(typeof body.data.csrfToken).toBe('string');
      expect(body.data.csrfToken.length).toBeGreaterThan(0);
    });

    it('rejects an invalid password with a generic 401', async () => {
      // Act
      const res = await server.fastify.inject({
        method: 'POST',
        url: `${BASE}/auth/login`,
        payload: { username: TEST_USERNAME, password: 'wrong' },
      });

      // Assert
      expect(res.statusCode).toBe(401);
      expect(res.json<{ error: { code: string } }>().error.code).toBe(
        'INVALID_CREDENTIALS',
      );
      // No session cookie issued on failure.
      expect(res.headers['set-cookie']).toBeUndefined();
    });

    it('never contacts Session Manager during login', async () => {
      // Act
      await server.fastify.inject({
        method: 'POST',
        url: `${BASE}/auth/login`,
        payload: { username: TEST_USERNAME, password: TEST_PASSWORD },
      });

      // Assert
      expect(sm.requests.length).toBe(0);
    });
  });

  describe('GET /auth/me and POST /auth/logout', (it) => {
    it('returns the identity + csrf token when authenticated, and clears on logout', async () => {
      // Arrange
      const { cookie, csrfToken } = await login(server.fastify);

      // Act — /auth/me
      const meRes = await server.fastify.inject({
        method: 'GET',
        url: `${BASE}/auth/me`,
        headers: { cookie },
      });

      // Assert
      expect(meRes.statusCode).toBe(200);
      const me = meRes.json<{
        data: { identity: { subject: string }; csrfToken: string };
      }>();
      expect(me.data.identity.subject).toBe(TEST_USERNAME);
      expect(me.data.csrfToken).toBe(csrfToken);

      // Act — logout (requires CSRF)
      const logoutRes = await server.fastify.inject({
        method: 'POST',
        url: `${BASE}/auth/logout`,
        headers: { cookie, 'x-csrf-token': csrfToken },
      });
      expect(logoutRes.statusCode).toBe(200);

      // Assert — session is revoked: /auth/me now 401
      const afterLogout = await server.fastify.inject({
        method: 'GET',
        url: `${BASE}/auth/me`,
        headers: { cookie },
      });
      expect(afterLogout.statusCode).toBe(401);
    });

    it('rejects /auth/me without a session cookie (401)', async () => {
      const res = await server.fastify.inject({
        method: 'GET',
        url: `${BASE}/auth/me`,
      });
      expect(res.statusCode).toBe(401);
      expect(res.json<{ error: { code: string } }>().error.code).toBe(
        'UNAUTHENTICATED',
      );
    });
  });
});

describe('Auth login rate limiting', () => {
  // Fresh server => fresh in-memory limiter, isolated from the suite above.
  const server = useServer({ rateLimitConfig: { loginMax: 3 } });

  describe('POST /auth/login', (it) => {
    it('locks out with 429 after exceeding the login limit', async () => {
      // Act — 3 allowed failed attempts, then the 4th is limited.
      const codes: number[] = [];
      for (let i = 0; i < 4; i++) {
        const res = await server.fastify.inject({
          method: 'POST',
          url: `${BASE}/auth/login`,
          payload: { username: TEST_USERNAME, password: 'wrong' },
        });
        codes.push(res.statusCode);
      }

      // Assert
      expect(codes.slice(0, 3)).toEqual([401, 401, 401]);
      expect(codes[3]).toBe(429);
    });
  });
});

describe('Auth with local login disabled', () => {
  const server = useServer({ localAuthConfig: { credentials: '' } });

  describe('config + login', (it) => {
    it('reports local disabled and rejects login with 404', async () => {
      const configRes = await server.fastify.inject({
        method: 'GET',
        url: `${BASE}/auth/config`,
      });
      expect(configRes.json()).toEqual({
        ok: true,
        data: { local: false, sso: false, grafana: false },
      });

      const loginRes = await server.fastify.inject({
        method: 'POST',
        url: `${BASE}/auth/login`,
        payload: { username: TEST_USERNAME, password: TEST_PASSWORD },
      });
      expect(loginRes.statusCode).toBe(404);
      expect(loginRes.json<{ error: { code: string } }>().error.code).toBe(
        'LOCAL_LOGIN_DISABLED',
      );
    });
  });
});
