import { afterEach, beforeEach, describe, expect } from 'vitest';

import type { BaseFastifyInstance } from '@scribear/base-fastify-server';

import { AppConfig } from '#src/app-config/app-config.js';
import createServer from '#src/server/create-server.js';
import type { AppDependencies } from '#src/server/dependency-injection/app-dependencies.js';
import { pythonDecodeDrop } from '#tests/fixtures/log-lines.js';

/**
 * Boots the real server with collectors disabled, then drives the ingest
 * directly. Attaching to a live Docker socket would make these tests depend on
 * the machine they run on; the collectors themselves are covered separately.
 */
async function boot() {
  process.env['LOG_LEVEL'] = 'silent';
  process.env['PORT'] = '0';
  process.env['HOST'] = '127.0.0.1';

  const config = new AppConfig();
  const { fastify } = await createServer(config, { startCollectors: false });
  await fastify.ready();
  return fastify;
}

describe('server endpoints', () => {
  let fastify: BaseFastifyInstance;

  beforeEach(async () => {
    fastify = await boot();
  });

  afterEach(async () => {
    await fastify.close();
  });

  function ingestService() {
    return fastify.diContainer.resolve<AppDependencies['logIngestService']>(
      'logIngestService',
    );
  }

  describe('liveness', (it) => {
    it('returns ok', async () => {
      // Act
      const res = await fastify.inject({
        method: 'GET',
        url: '/api/monitoring/v1/probes/liveness',
      });

      // Assert
      expect(res.statusCode).toBe(200);
      expect(res.json()).toStrictEqual({ status: 'ok' });
    });
  });

  describe('readiness', (it) => {
    it('reports not-ready before any log line has been seen', async () => {
      // Arrange — catches the common misconfiguration where the Docker socket
      // is not mounted, which would otherwise look perfectly healthy.

      // Act
      const res = await fastify.inject({
        method: 'GET',
        url: '/api/monitoring/v1/probes/readiness',
      });

      // Assert
      expect(res.statusCode).toBe(503);
    });

    it('reports ready once the ingest has seen traffic', async () => {
      // Arrange
      ingestService().ingest(pythonDecodeDrop());

      // Act
      const res = await fastify.inject({
        method: 'GET',
        url: '/api/monitoring/v1/probes/readiness',
      });

      // Assert
      expect(res.statusCode).toBe(200);
    });
  });

  describe('snapshot', (it) => {
    it('returns counters, alerts and ingest health as JSON', async () => {
      // Arrange — written straight to the registry. The decode-drop parser
      // that used to seed this was retired in B1.2 PR 5; this test is about the
      // snapshot's HTTP shape, not about where the counter came from.
      const metrics =
        fastify.diContainer.resolve<AppDependencies['metricsRegistry']>(
          'metricsRegistry',
        );
      metrics.safpDecodeDropsTotal.inc({
        service: 'transcription-service',
        side: 'transcription',
      });

      // Act
      const res = await fastify.inject({
        method: 'GET',
        url: '/api/monitoring/v1/snapshot',
      });

      // Assert
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toHaveProperty('alerts');
      expect(body).toHaveProperty('probes');
      expect(body).toHaveProperty('ingest');
      expect(body.counters.scribear_safp_decode_drops_total).toHaveLength(1);
    });

    it('surfaces a firing alert through the HTTP surface', async () => {
      // Arrange — enough churn to cross the default threshold. Written
      // straight to the registry rather than through the status poller: this
      // test is about the HTTP surface, and the poller has its own suite.
      const metrics =
        fastify.diContainer.resolve<AppDependencies['metricsRegistry']>(
          'metricsRegistry',
        );
      for (let i = 0; i < 5; i++) {
        metrics.upstreamChurnTotal.inc({ service: 'node-server' });
      }

      // Act
      const res = await fastify.inject({
        method: 'GET',
        url: '/api/monitoring/v1/alerts',
      });

      // Assert
      expect(res.statusCode).toBe(200);
      const alerts = res.json().alerts as { failureModes: string[] }[];
      expect(alerts.some((a) => a.failureModes.includes('N1'))).toBe(true);
    });
  });

  describe('prometheus', (it) => {
    it('serves the text exposition format with the correct content type', async () => {
      // Arrange
      ingestService().ingest(pythonDecodeDrop());

      // Act
      const res = await fastify.inject({ method: 'GET', url: '/metrics' });

      // Assert
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/plain');
      expect(res.body).toContain('scribear_safp_decode_drops_total');
    });
  });

  describe('audio meter page', (it) => {
    it('serves the self-contained meter as UTF-8 HTML', async () => {
      // Act
      const res = await fastify.inject({
        method: 'GET',
        url: '/api/monitoring/v1/audio-meter',
      });

      // Assert
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/html');
      expect(res.headers['content-type']).toContain('utf-8');
      expect(res.body).toContain('<title>ScribeAR audio meter</title>');
    });

    it('serves a page that loads nothing from the network', async () => {
      // Arrange — an engineer opens this on the source machine, often from a
      // file or an offline laptop; any external reference would break it there
      // and would also leak that the page was opened.
      const res = await fastify.inject({
        method: 'GET',
        url: '/api/monitoring/v1/audio-meter',
      });

      // Assert
      expect(res.body).not.toMatch(/<(script|link|img)[^>]+(src|href)=/i);
      expect(res.body).not.toMatch(/https?:\/\//i);
    });
  });
});
