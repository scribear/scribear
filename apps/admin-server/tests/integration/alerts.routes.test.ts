import { afterEach, beforeAll, describe, expect, vi } from 'vitest';

import type { MonitoringAlert } from '#src/server/features/alerts/alerts.service.js';
import {
  TEST_MONITORING_SIDECAR_BASE_URL,
  login,
  useServer,
} from '#tests/utils/use-server.js';

const ALERTS_URL = `${TEST_MONITORING_SIDECAR_BASE_URL}/api/monitoring/v1/alerts`;
const URL = '/api/admin/v1/alerts';

interface AlertsBody {
  ok: boolean;
  data?: { alerts: MonitoringAlert[]; generatedAt: string };
  error?: { code: string; message: string };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function fakeAlert(overrides: Partial<MonitoringAlert> = {}): MonitoringAlert {
  return {
    id: 'asr-worker-dead',
    failureModes: ['T9'],
    severity: 'critical',
    summary: '1 transcription worker process(es) have exited (worker 0).',
    likelyCause:
      'A worker died after startup — most often a model-load crash, a GPU fault or an OOM kill.',
    stage: 'transcription',
    value: 1,
    threshold: 0,
    ...overrides,
  };
}

describe('Alerts route', () => {
  const server = useServer();
  let cookie = '';

  beforeAll(async () => {
    cookie = (await login(server.fastify)).cookie;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('auth', (it) => {
    it('requires a session', async () => {
      const res = await server.fastify.inject({ method: 'GET', url: URL });

      expect(res.statusCode).toBe(401);
    });
  });

  describe('sidecar reachable', (it) => {
    it('answers 200 with an empty list when nothing is firing — not the same as unavailable', async () => {
      vi.stubGlobal('fetch', (url: string) => {
        expect(url).toBe(ALERTS_URL);
        return Promise.resolve(jsonResponse({ alerts: [] }));
      });

      const res = await server.fastify.inject({
        method: 'GET',
        url: URL,
        headers: { cookie },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json<AlertsBody>();
      expect(body.ok).toBe(true);
      expect(body.data?.alerts).toEqual([]);
      expect(typeof body.data?.generatedAt).toBe('string');
    });

    it('answers 200 with the firing alerts, worst-first order preserved from the sidecar', async () => {
      const alerts = [
        fakeAlert({ id: 'asr-worker-dead', severity: 'critical' }),
        fakeAlert({
          id: 'asr-falling-behind:whisper',
          severity: 'warning',
          stage: 'transcription',
        }),
      ];
      vi.stubGlobal('fetch', () => Promise.resolve(jsonResponse({ alerts })));

      const res = await server.fastify.inject({
        method: 'GET',
        url: URL,
        headers: { cookie },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json<AlertsBody>();
      expect(body.data?.alerts).toEqual(alerts);
    });
  });

  describe('sidecar unavailable — every failure is 503 ALERTS_UNAVAILABLE, never an empty 200', (it) => {
    it('reports 503 when the sidecar does not answer at all', async () => {
      vi.stubGlobal('fetch', () =>
        Promise.reject(new Error('connect ECONNREFUSED')),
      );

      const res = await server.fastify.inject({
        method: 'GET',
        url: URL,
        headers: { cookie },
      });

      expect(res.statusCode).toBe(503);
      expect(res.json<AlertsBody>().error?.code).toBe('ALERTS_UNAVAILABLE');
    });

    it('reports 503 when the sidecar answers a non-2xx status', async () => {
      vi.stubGlobal('fetch', () =>
        Promise.resolve(jsonResponse({ error: 'boom' }, 500)),
      );

      const res = await server.fastify.inject({
        method: 'GET',
        url: URL,
        headers: { cookie },
      });

      expect(res.statusCode).toBe(503);
      expect(res.json<AlertsBody>().error?.code).toBe('ALERTS_UNAVAILABLE');
    });

    it('reports 503 when the sidecar answers unparseable JSON', async () => {
      vi.stubGlobal('fetch', () =>
        Promise.resolve(
          new Response('not json', {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        ),
      );

      const res = await server.fastify.inject({
        method: 'GET',
        url: URL,
        headers: { cookie },
      });

      expect(res.statusCode).toBe(503);
      expect(res.json<AlertsBody>().error?.code).toBe('ALERTS_UNAVAILABLE');
    });

    it('reports 503 when the sidecar answers a body this build does not recognize', async () => {
      // A field renamed, or an older/newer sidecar with a different shape —
      // never trusted as a clean report of "no alerts".
      vi.stubGlobal('fetch', () =>
        Promise.resolve(jsonResponse({ notAlerts: [] })),
      );

      const res = await server.fastify.inject({
        method: 'GET',
        url: URL,
        headers: { cookie },
      });

      expect(res.statusCode).toBe(503);
      expect(res.json<AlertsBody>().error?.code).toBe('ALERTS_UNAVAILABLE');
    });

    it('reports 503 when one alert in an otherwise-valid array is malformed', async () => {
      vi.stubGlobal('fetch', () =>
        Promise.resolve(
          jsonResponse({
            alerts: [
              fakeAlert(),
              { id: 'incomplete', severity: 'critical' }, // missing required fields
            ],
          }),
        ),
      );

      const res = await server.fastify.inject({
        method: 'GET',
        url: URL,
        headers: { cookie },
      });

      expect(res.statusCode).toBe(503);
      expect(res.json<AlertsBody>().error?.code).toBe('ALERTS_UNAVAILABLE');
    });
  });
});
