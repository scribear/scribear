import { afterEach, beforeAll, beforeEach, describe, expect, vi } from 'vitest';

import type { ConfigCheckReport } from '#src/server/features/config-check/config-check.service.js';
import {
  TEST_AUDIO_BASE_URL,
  TEST_MONITORING_SIDECAR_BASE_URL,
  TEST_NODE_BASE_URL,
  TEST_SM_BASE_URL,
  TEST_TS_BASE_URL,
  login,
  useServer,
} from '#tests/utils/use-server.js';

const CONFIG_AUDIT_URL = `${TEST_MONITORING_SIDECAR_BASE_URL}/api/monitoring/v1/config-audit`;

/** node-server reports every secret fine - the default unless a test spoils it. */
const CONFIG_AUDIT_CLEAN = {
  nodeServer: {
    status: 'ok',
    secretPlaceholders: {
      sessionTokenSigningKeyIsPlaceholder: false,
      sessionManagerServiceApiKeyIsPlaceholder: false,
      nodeServerServiceApiKeyIsPlaceholder: false,
      transcriptionServiceApiKeyIsPlaceholder: false,
    },
  },
};

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
    // quiet unless a test wants it. The sidecar's `/config-audit` gets its
    // own body - `_checkSecretPlaceholders` is unconditional (the sidecar has
    // no compose profile to be "off" behind), so every test in this file
    // needs an answer for it, not just the ones that care about Phase 2.
    vi.stubGlobal('fetch', (url: string) => {
      if (url.startsWith(CONFIG_AUDIT_URL)) {
        return Promise.resolve(
          new Response(JSON.stringify(CONFIG_AUDIT_CLEAN), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
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

    // Five findings, and all are properties of this fixture rather than of
    // the configuration: telemetry is switched off above, the monitoring
    // profile's base URLs are unset by default (`buildTestAppConfig`), the
    // test database is a plain Postgres carrying only admin-server's own audit
    // tables — the shared schema `infra/scribear-db` owns has deliberately
    // never been migrated here, since applying it would mean building that
    // image (pg_cron, pg_trgm) to test a route that has nothing to do with it
    // — and no db-backup runs in this test environment either, so its bind
    // mount points nowhere (`buildTestAppConfig`) and neither backup finding
    // has anything real to read.
    it('reports the telemetry, monitoring and backup advisories and the unmigrated shared schema', async () => {
      const res = await server.fastify.inject({
        method: 'GET',
        url: URL,
        // `light-my-request` defaults the Host header to `localhost` when
        // none is given — exactly the address `public-origin-not-
        // externally-resolvable` (config-check.service.test.ts) exists to
        // flag, and unrelated to what this test is asserting. A normal-
        // looking public host keeps this list to the five findings the test
        // name promises.
        headers: { cookie, host: 'admin.example.edu' },
      });

      expect(
        res.json<ConfigCheckBody>().data.findings.map((f) => f.id),
      ).toEqual([
        'fleet-telemetry-disabled',
        'schema-never-migrated',
        'monitoring-not-configured',
        'backup-offsite-not-configured',
        'backup-none-found',
      ]);
    });

    it('states the schema finding with a fix and a wiki link', async () => {
      const res = await server.fastify.inject({
        method: 'GET',
        url: URL,
        headers: { cookie },
      });

      const found = res
        .json<ConfigCheckBody>()
        .data.findings.find((f) => f.id === 'schema-never-migrated');
      expect(found?.severity).toBe('critical');
      expect(found?.remediation).toContain('docker compose up -d');
      expect(found?.docUrl).toContain('github.com/scribear/scribear/wiki');
    });

    // The version comparison needs an answer from session-manager, and the stub
    // above answers every URL with a readiness body. A body that does not match
    // the schema route's contract must read as "could not be asked", not as a
    // version mismatch.
    it('does not invent a version skew from an unparseable answer', async () => {
      const res = await server.fastify.inject({
        method: 'GET',
        url: URL,
        headers: { cookie },
      });

      expect(
        res.json<ConfigCheckBody>().data.findings.map((f) => f.id),
      ).not.toContain('schema-version-skew');
    });
  });

  // End-to-end coverage for the `req.hostname` wiring itself
  // (`config-check.controller.ts`) - `evaluatePublicOriginCheck`'s own logic
  // is exhaustively unit-tested; this only proves the Host header a real
  // request carries actually reaches it.
  describe('the public origin', (it) => {
    it('flags the address reached when no Host header looks public (light-my-request defaults to "localhost")', async () => {
      const res = await server.fastify.inject({
        method: 'GET',
        url: URL,
        headers: { cookie },
      });

      expect(
        res.json<ConfigCheckBody>().data.findings.map((f) => f.id),
      ).toContain('public-origin-not-externally-resolvable');
    });

    it('reports nothing when reached on a normal-looking public host', async () => {
      const res = await server.fastify.inject({
        method: 'GET',
        url: URL,
        headers: { cookie, host: 'scribear.example.edu' },
      });

      expect(
        res.json<ConfigCheckBody>().data.findings.map((f) => f.id),
      ).not.toContain('public-origin-not-externally-resolvable');
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

  describe('a secret only node-server can see (PLAN-ConfigCheck-Coverage Phase 2)', (it) => {
    it('is reported as critical when node-server flags it via the sidecar', async () => {
      vi.stubGlobal('fetch', (url: string) => {
        if (url.startsWith(CONFIG_AUDIT_URL)) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                nodeServer: {
                  status: 'ok',
                  secretPlaceholders: {
                    sessionTokenSigningKeyIsPlaceholder: true,
                    sessionManagerServiceApiKeyIsPlaceholder: false,
                    nodeServerServiceApiKeyIsPlaceholder: false,
                    transcriptionServiceApiKeyIsPlaceholder: false,
                  },
                },
              }),
              { status: 200, headers: { 'content-type': 'application/json' } },
            ),
          );
        }
        return Promise.resolve(
          new Response(JSON.stringify({ status: 'ok' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      });

      const res = await server.fastify.inject({
        method: 'GET',
        url: URL,
        headers: { cookie },
      });

      const { data } = res.json<ConfigCheckBody>();
      const found = data.findings.find(
        (f) => f.id === 'jwt-secret-placeholder',
      );
      expect(found?.severity).toBe('critical');
      expect(data.blockingForProduction).toBeGreaterThanOrEqual(1);
    });

    it('names the sidecar, not node-server, when the sidecar cannot answer', async () => {
      vi.stubGlobal('fetch', (url: string) => {
        if (url.startsWith(CONFIG_AUDIT_URL)) {
          return Promise.reject(new Error('connect ECONNREFUSED'));
        }
        return Promise.resolve(
          new Response(JSON.stringify({ status: 'ok' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      });

      const res = await server.fastify.inject({
        method: 'GET',
        url: URL,
        headers: { cookie },
      });

      const ids = res.json<ConfigCheckBody>().data.findings.map((f) => f.id);
      expect(ids).toContain('monitoring-sidecar-unreachable');
      // Never silence, and never a clean bill of health for the secrets it
      // could not read.
      expect(ids.some((id) => id.endsWith('-placeholder'))).toBe(false);
    });
  });
});

// A separate server, not a describe block inside the one above: this is the
// only fixture in the file with `testAudioConfig.baseUrl` set at all (every
// other test's is the default `''`, i.e. the feature turned off), so the
// live probe exists to be end-to-end tested. `TestAudioGatewayService`
// itself is unit-tested directly; this only proves the DI wiring — the new
// constructor parameter and the `Promise.all` member in `check()` — actually
// runs it.
describe('Config check route - the test audio service key probe', (it) => {
  const TEST_AUDIO_DEVICES_URL = `${TEST_AUDIO_BASE_URL}/api/test-audio/v1/devices`;

  const server = useServer({
    configCheckConfig: { redisUrl: '' },
    testAudioConfig: { baseUrl: TEST_AUDIO_BASE_URL },
  });
  let cookie = '';

  beforeAll(async () => {
    cookie = (await login(server.fastify)).cookie;
  });

  beforeEach(() => {
    vi.stubGlobal('fetch', (url: string) => {
      if (
        url.startsWith(
          `${TEST_MONITORING_SIDECAR_BASE_URL}/api/monitoring/v1/config-audit`,
        )
      ) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              nodeServer: {
                status: 'ok',
                secretPlaceholders: {
                  sessionTokenSigningKeyIsPlaceholder: false,
                  sessionManagerServiceApiKeyIsPlaceholder: false,
                  nodeServerServiceApiKeyIsPlaceholder: false,
                  transcriptionServiceApiKeyIsPlaceholder: false,
                },
              },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
        );
      }
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

  it('reports nothing when the generator accepts the key', async () => {
    vi.stubGlobal('fetch', (url: string) => {
      if (url.startsWith(TEST_AUDIO_DEVICES_URL)) {
        return Promise.resolve(
          new Response(JSON.stringify({ devices: [] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify({ status: 'ok' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    });

    const res = await server.fastify.inject({
      method: 'GET',
      url: URL,
      headers: { cookie, host: 'scribear.example.edu' },
    });

    expect(
      res.json<ConfigCheckBody>().data.findings.map((f) => f.id),
    ).not.toContain('test-audio-service-key-mismatch');
  });

  it('flags a rejected key as a mismatch, not a silent pass', async () => {
    vi.stubGlobal('fetch', (url: string) => {
      if (url.startsWith(TEST_AUDIO_DEVICES_URL)) {
        return Promise.resolve(
          new Response(JSON.stringify({ code: 'UNAUTHORIZED' }), {
            status: 401,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify({ status: 'ok' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    });

    const res = await server.fastify.inject({
      method: 'GET',
      url: URL,
      headers: { cookie, host: 'scribear.example.edu' },
    });

    const { data } = res.json<ConfigCheckBody>();
    const found = data.findings.find(
      (f) => f.id === 'test-audio-service-key-mismatch',
    );
    expect(found?.severity).toBe('critical');
    expect(data.blockingForProduction).toBeGreaterThanOrEqual(1);
  });

  it('reports "could not verify", not a pass, when the generator does not answer', async () => {
    vi.stubGlobal('fetch', (url: string) => {
      if (url.startsWith(TEST_AUDIO_DEVICES_URL)) {
        return Promise.reject(new Error('connect ECONNREFUSED'));
      }
      return Promise.resolve(
        new Response(JSON.stringify({ status: 'ok' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    });

    const res = await server.fastify.inject({
      method: 'GET',
      url: URL,
      headers: { cookie, host: 'scribear.example.edu' },
    });

    const findings = res.json<ConfigCheckBody>().data.findings;
    expect(findings.map((f) => f.id)).toContain(
      'test-audio-service-key-probe-unavailable',
    );
    expect(findings.map((f) => f.id)).not.toContain(
      'test-audio-service-key-mismatch',
    );
  });
});
