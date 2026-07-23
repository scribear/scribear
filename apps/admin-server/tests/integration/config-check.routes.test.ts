import { afterEach, beforeAll, beforeEach, describe, expect, vi } from 'vitest';

import type { ConfigCheckReport } from '#src/server/features/config-check/config-check.service.js';
import {
  TEST_NODE_BASE_URL,
  TEST_SM_BASE_URL,
  TEST_TS_BASE_URL,
  login,
  useServer,
} from '#tests/utils/use-server.js';

const URL = '/api/admin/v1/config-check';

interface ConfigCheckBody {
  ok: boolean;
  data: ConfigCheckReport;
}

describe('Config check route', () => {
  // `redisUrl` is empty so the backplane check short-circuits without opening a
  // connection; the reachability branch is covered by the unit tests, and a
  // real Redis here would only be testing ioredis.
  const server = useServer({ configCheckConfig: { redisUrl: '' } });
  // Logged in once: the login route is rate limited to 5 per minute.
  let cookie = '';

  beforeAll(async () => {
    cookie = (await login(server.fastify)).cookie;
  });

  beforeEach(() => {
    // Every probed service answers healthy, so `services-unreachable` stays
    // quiet unless a test wants it.
    vi.stubGlobal('fetch', (url: string) => {
      const known = [TEST_SM_BASE_URL, TEST_NODE_BASE_URL, TEST_TS_BASE_URL];
      if (!known.some((base) => url.startsWith(base))) {
        return Promise.reject(new Error('connect ECONNREFUSED'));
      }
      return Promise.resolve(
        new Response(JSON.stringify({ status: 'ok' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('authentication', (it) => {
    it('rejects an unauthenticated caller', async () => {
      const res = await server.fastify.inject({ method: 'GET', url: URL });

      expect(res.statusCode).toBe(401);
    });
  });

  describe('a healthy production deployment', (it) => {
    it('answers 200 with an explicit environment', async () => {
      const res = await server.fastify.inject({
        method: 'GET',
        url: URL,
        headers: { cookie },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json<ConfigCheckBody>();
      expect(body.ok).toBe(true);
      expect(body.data.environment).toBe('production');
      expect(body.data.environmentSource).toBe('explicit');
    });

    it('reports only the telemetry advisory, which is switched off here', async () => {
      const res = await server.fastify.inject({
        method: 'GET',
        url: URL,
        headers: { cookie },
      });

      expect(
        res.json<ConfigCheckBody>().data.findings.map((f) => f.id),
      ).toEqual(['fleet-telemetry-disabled']);
    });
  });

  describe('a deployment with a placeholder secret', (it) => {
    const spoiled = useServer({
      configCheckConfig: { redisUrl: '', dbPassword: 'CHANGEME' },
    });
    let spoiledCookie = '';

    beforeAll(async () => {
      spoiledCookie = (await login(spoiled.fastify)).cookie;
    });

    it('is reported as critical, and counted as production-blocking', async () => {
      const res = await spoiled.fastify.inject({
        method: 'GET',
        url: URL,
        headers: { cookie: spoiledCookie },
      });

      const { data } = res.json<ConfigCheckBody>();
      const found = data.findings.find(
        (f) => f.id === 'db-password-placeholder',
      );
      expect(found?.severity).toBe('critical');
      expect(data.blockingForProduction).toBeGreaterThanOrEqual(1);
    });

    // The whole point of the endpoint is that it can be read by a human
    // without handing them the credentials it is reporting on.
    it('does not disclose the secret it is complaining about', async () => {
      const res = await spoiled.fastify.inject({
        method: 'GET',
        url: URL,
        headers: { cookie: spoiledCookie },
      });

      expect(res.body).not.toContain('test-db-password');
    });
  });
});
