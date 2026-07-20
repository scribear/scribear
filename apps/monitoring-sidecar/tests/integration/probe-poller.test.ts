import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect } from 'vitest';

import { MetricsRegistry } from '#src/server/shared/metrics/metrics-registry.service.js';
import { ProbePollerService } from '#src/server/shared/probes/probe-poller.service.js';

const logger = {
  warn: () => undefined,
  info: () => undefined,
  error: () => undefined,
} as never;

/** Controls what the fake service returns, so a dependency can be "killed". */
interface FakeService {
  port: number;
  close: () => Promise<void>;
  /** Set the readiness response. */
  setReadiness: (status: number, body: unknown) => void;
}

async function startFakeService(): Promise<FakeService> {
  let readinessStatus = 200;
  let readinessBody: unknown = { status: 'ok' };

  const server = http.createServer((req, res) => {
    if (req.url?.endsWith('/liveness') === true) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }
    res.writeHead(readinessStatus, { 'content-type': 'application/json' });
    res.end(JSON.stringify(readinessBody));
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  return {
    port: (server.address() as AddressInfo).port,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
    setReadiness: (status, body) => {
      readinessStatus = status;
      readinessBody = body;
    },
  };
}

describe('probe poller (A3)', () => {
  let service: FakeService;

  beforeEach(async () => {
    service = await startFakeService();
  });

  afterEach(async () => {
    await service.close();
  });

  function createPoller(port: number) {
    const metrics = new MetricsRegistry();
    const base = `http://127.0.0.1:${String(port)}`;
    const poller = new ProbePollerService(
      {
        intervalMs: 10_000,
        timeoutMs: 1_000,
        targets: [
          {
            service: 'fake-service',
            livenessUrl: `${base}/probes/liveness`,
            readinessUrl: `${base}/probes/readiness`,
          },
        ],
      },
      metrics,
      logger,
    );
    return { metrics, poller };
  }

  describe('healthy service', (it) => {
    it('records both probes as up', async () => {
      // Arrange
      const { metrics, poller } = createPoller(service.port);

      // Act
      await poller.pollOnce();

      // Assert
      expect(
        metrics.probeUp.get({ service: 'fake-service', probe: 'liveness' }),
      ).toBe(1);
      expect(
        metrics.probeUp.get({ service: 'fake-service', probe: 'readiness' }),
      ).toBe(1);
    });
  });

  describe('failing dependency', (it) => {
    it('flips readiness red within one poll and names the failing check', async () => {
      // Arrange — the §5 A3 gate: "kill session-manager DB, assert readiness
      // flips red < one poll interval". Here the DB check starts failing.
      const { metrics, poller } = createPoller(service.port);
      await poller.pollOnce();

      // Act
      service.setReadiness(503, {
        status: 'fail',
        checks: { database: 'fail' },
      });
      const statuses = await poller.pollOnce();

      // Assert
      expect(
        metrics.probeUp.get({ service: 'fake-service', probe: 'readiness' }),
      ).toBe(0);
      const readiness = statuses.find((s) => s.probe === 'readiness');
      expect(readiness?.checks).toStrictEqual({ database: 'fail' });
      // Liveness stays green: the process is up, its dependency is not.
      expect(
        metrics.probeUp.get({ service: 'fake-service', probe: 'liveness' }),
      ).toBe(1);
    });

    it('counts the down transition exactly once while it stays down', async () => {
      // Arrange — edges, not levels: a steady outage must not spam transitions
      const { metrics, poller } = createPoller(service.port);
      await poller.pollOnce();
      service.setReadiness(503, {
        status: 'fail',
        checks: { database: 'fail' },
      });

      // Act
      await poller.pollOnce();
      await poller.pollOnce();
      await poller.pollOnce();

      // Assert
      expect(
        metrics.probeTransitionsTotal.get({
          service: 'fake-service',
          probe: 'readiness',
          direction: 'down',
        }),
      ).toBe(1);
    });

    it('accumulates consecutive failures and clears them on recovery', async () => {
      // Arrange
      const { metrics, poller } = createPoller(service.port);
      service.setReadiness(503, {
        status: 'fail',
        checks: { database: 'fail' },
      });

      // Act
      await poller.pollOnce();
      await poller.pollOnce();
      const afterFailures = metrics.probeConsecutiveFailures.get({
        service: 'fake-service',
        probe: 'readiness',
      });
      service.setReadiness(200, { status: 'ok' });
      await poller.pollOnce();

      // Assert
      expect(afterFailures).toBe(2);
      expect(
        metrics.probeConsecutiveFailures.get({
          service: 'fake-service',
          probe: 'readiness',
        }),
      ).toBe(0);
    });
  });

  describe('unreachable service', (it) => {
    it('reports down without throwing when the service is gone', async () => {
      // Arrange — a monitoring component that crashes when its target dies is
      // useless precisely when it is needed.
      const { metrics, poller } = createPoller(service.port);
      await service.close();

      // Act
      const statuses = await poller.pollOnce();

      // Assert
      expect(
        metrics.probeUp.get({ service: 'fake-service', probe: 'liveness' }),
      ).toBe(0);
      expect(statuses.every((s) => !s.healthy)).toBe(true);
      expect(statuses[0]?.error).not.toBeNull();
    });
  });
});
