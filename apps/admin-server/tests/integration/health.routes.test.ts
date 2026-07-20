import { afterEach, beforeAll, beforeEach, describe, expect, vi } from 'vitest';

import type { HealthComponent } from '#src/server/features/health/health.service.js';
import {
  TEST_NODE_BASE_URL,
  TEST_SM_BASE_URL,
  TEST_TS_BASE_URL,
  login,
  useServer,
} from '#tests/utils/use-server.js';

const URL = '/api/admin/v1/health';

interface HealthBody {
  ok: boolean;
  data: {
    bff: string;
    components: HealthComponent[];
    checkedAt: string;
  };
}

/** Readiness answers keyed by base URL; anything unlisted is left to fail. */
type ProbeAnswers = Record<
  string,
  { status: number; body?: unknown } | 'network-error' | 'hang'
>;

describe('Health route', () => {
  const server = useServer();
  let answers: ProbeAnswers = {};
  // Logged in once: the login route is rate limited to 5 per minute, so a
  // login per test silently turns later cases into 401s.
  let cookie = '';

  beforeAll(async () => {
    cookie = (await login(server.fastify)).cookie;
  });

  beforeEach(() => {
    answers = {
      [TEST_SM_BASE_URL]: { status: 200, body: { status: 'ok' } },
      [TEST_NODE_BASE_URL]: { status: 200, body: { status: 'ok' } },
      [TEST_TS_BASE_URL]: { status: 200, body: { status: 'ok' } },
    };

    vi.stubGlobal(
      'fetch',
      // Typed as a string URL because that is the only form the service under
      // test calls fetch with; a Request/URL argument would be a change worth
      // failing on.
      async (url: string, init?: RequestInit) => {
        const match = Object.keys(answers).find((base) => url.startsWith(base));
        const answer = match === undefined ? undefined : answers[match];

        if (answer === undefined || answer === 'network-error') {
          throw new Error('connect ECONNREFUSED');
        }
        if (answer === 'hang') {
          // Models what real fetch does with an AbortSignal: settle only when
          // the caller aborts. If the service under test passed no signal this
          // never settles and the test times out - which is the regression
          // being guarded, not a flake.
          return new Promise<Response>((_resolve, reject) => {
            const signal = init?.signal;
            if (!signal) return;
            signal.addEventListener('abort', () => {
              reject(signal.reason as Error);
            });
          });
        }
        return new Response(JSON.stringify(answer.body ?? {}), {
          status: answer.status,
          headers: { 'content-type': 'application/json' },
        });
      },
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function fetchHealth() {
    const res = await server.fastify.inject({
      method: 'GET',
      url: URL,
      headers: { cookie },
    });
    return { res, body: res.json<HealthBody>() };
  }

  function componentNamed(body: HealthBody, name: string): HealthComponent {
    const found = body.data.components.find((c) => c.name === name);
    if (found === undefined) throw new Error(`no component named ${name}`);
    return found;
  }

  describe('auth', (it) => {
    it('requires a session, because it exposes infrastructure state', async () => {
      // Act
      const res = await server.fastify.inject({ method: 'GET', url: URL });

      // Assert
      expect(res.statusCode).toBe(401);
    });
  });

  describe('rollup', (it) => {
    it('reports every dependency, not just the database and session-manager', async () => {
      // Act
      const { res, body } = await fetchHealth();

      // Assert
      expect(res.statusCode).toBe(200);
      expect(body.data.bff).toBe('ok');
      expect(body.data.components.map((c) => c.name).sort()).toEqual([
        'database',
        'node-server',
        'session-manager',
        'transcription-service',
      ]);
      expect(body.data.components.every((c) => c.status === 'ok')).toBe(true);
    });

    it('stays 200 when a dependency is down', async () => {
      // Arrange — a non-200 would be indistinguishable from the BFF itself
      // being broken, which is the one thing this route can always speak for.
      answers[TEST_NODE_BASE_URL] = 'network-error';

      // Act
      const { res, body } = await fetchHealth();

      // Assert
      expect(res.statusCode).toBe(200);
      expect(body.ok).toBe(true);
      expect(componentNamed(body, 'node-server').status).toBe('unreachable');
    });
  });

  describe('status mapping', (it) => {
    it('calls a 503 readiness a failure, not unreachable', async () => {
      // Arrange — the service answered. It is up and telling us what is wrong,
      // which is a different operator problem from not answering at all.
      answers[TEST_TS_BASE_URL] = {
        status: 503,
        body: {
          status: 'fail',
          checks: { workers: '1 of 2 worker processes have exited' },
        },
      };

      // Act
      const { body } = await fetchHealth();

      // Assert
      const component = componentNamed(body, 'transcription-service');
      expect(component.status).toBe('fail');
      expect(component.detail).toContain('worker processes have exited');
    });

    it('surfaces a degraded readiness as degraded', async () => {
      // Arrange — B1.3 made transcription-service answer this way when every
      // worker is saturated: a 200, but not a healthy one.
      answers[TEST_TS_BASE_URL] = {
        status: 200,
        body: {
          status: 'degraded',
          checks: { workers: 'all 2 workers saturated' },
        },
      };

      // Act
      const { body } = await fetchHealth();

      // Assert
      const component = componentNamed(body, 'transcription-service');
      expect(component.status).toBe('degraded');
      expect(component.detail).toContain('saturated');
    });

    it('treats an unrecognized status as unreachable rather than healthy', async () => {
      // Arrange — a 200 carrying something we cannot interpret must not be
      // read as good news; that is how a wrong-service-on-this-port
      // misconfiguration hides.
      answers[TEST_NODE_BASE_URL] = { status: 200, body: { hello: 'world' } };

      // Act
      const { body } = await fetchHealth();

      // Assert
      expect(componentNamed(body, 'node-server').status).toBe('unreachable');
    });

    it('reports a non-JSON body as unreachable', async () => {
      // Arrange — an nginx error page is the realistic case.
      vi.stubGlobal('fetch', () =>
        Promise.resolve(new Response('<html>502</html>', { status: 502 })),
      );

      // Act
      const { body } = await fetchHealth();

      // Assert
      expect(componentNamed(body, 'node-server').status).toBe('unreachable');
      expect(componentNamed(body, 'node-server').detail).toContain('HTTP 502');
    });
  });

  describe('timeouts', (it) => {
    it('gives up on a hung dependency instead of hanging with it', async () => {
      // Arrange — before B1.5 the session-manager check had no AbortSignal at
      // all, so this request would have stalled for the OS TCP timeout with an
      // admin waiting on it.
      answers[TEST_SM_BASE_URL] = 'hang';

      // Act
      const { res, body } = await fetchHealth();

      // Assert
      expect(res.statusCode).toBe(200);
      const component = componentNamed(body, 'session-manager');
      expect(component.status).toBe('unreachable');
      expect(component.detail).toContain('no response within');
    });

    it('does not let one hung dependency hide the healthy ones', async () => {
      // Arrange — the checks run concurrently, so a hang must cost the rollup
      // one timeout in total rather than delaying or masking its peers.
      answers[TEST_SM_BASE_URL] = 'hang';

      // Act
      const { body } = await fetchHealth();

      // Assert
      expect(componentNamed(body, 'node-server').status).toBe('ok');
      expect(componentNamed(body, 'transcription-service').status).toBe('ok');
      expect(componentNamed(body, 'database').status).toBe('ok');
    });
  });
});
