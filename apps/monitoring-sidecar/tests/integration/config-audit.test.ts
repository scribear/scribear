import { asValue } from 'awilix';
import { afterEach, beforeEach, describe, expect } from 'vitest';

import type { BaseFastifyInstance } from '@scribear/base-fastify-server';

import { AppConfig } from '#src/app-config/app-config.js';
import createServer from '#src/server/create-server.js';
import type { AppDependencies } from '#src/server/dependency-injection/app-dependencies.js';
import type { StatusPollResult } from '#src/server/shared/status-poll/absolute-status-poller.js';

const ROUTE = '/api/monitoring/v1/config-audit';

/**
 * Boots the real server with collectors disabled — the poller's own polling
 * behaviour is covered by `node-status-poller.test.ts`; this suite is about
 * the HTTP surface `ConfigAuditController` builds from whatever state the
 * poller reports, so tests swap in a minimal fake rather than driving a real
 * poll.
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

/** A stand-in for `NodeStatusPollerService`, narrowed to what the controller reads. */
interface FakePoller {
  enabled: boolean;
  lastResult: StatusPollResult | null;
  secretPlaceholders: AppDependencies['nodeStatusPollerService']['secretPlaceholders'];
}

function stubPoller(fastify: BaseFastifyInstance, fake: FakePoller) {
  fastify.diContainer.register({
    nodeStatusPollerService: asValue(
      fake as unknown as AppDependencies['nodeStatusPollerService'],
    ),
  });
}

describe('config audit (PLAN-ConfigCheck-Coverage Phase 2)', () => {
  let fastify: BaseFastifyInstance;

  beforeEach(async () => {
    fastify = await boot();
  });

  afterEach(async () => {
    await fastify.close();
  });

  describe('GET /config-audit', (it) => {
    it('reports disabled when this sidecar holds no service key', async () => {
      // Arrange - the default test boot sets no NODE_SERVER_SERVICE_API_KEY,
      // so the real poller registered by DI is already disabled; nothing to
      // stub.

      // Act
      const res = await fastify.inject({ method: 'GET', url: ROUTE });

      // Assert
      expect(res.statusCode).toBe(200);
      expect(res.json()).toStrictEqual({
        nodeServer: { status: 'unavailable', reason: 'disabled' },
      });
    });

    it('reports not-yet-polled when enabled but no poll has completed', async () => {
      // Arrange
      stubPoller(fastify, {
        enabled: true,
        lastResult: null,
        secretPlaceholders: null,
      });

      // Act
      const res = await fastify.inject({ method: 'GET', url: ROUTE });

      // Assert
      expect(res.json()).toStrictEqual({
        nodeServer: { status: 'unavailable', reason: 'not-yet-polled' },
      });
    });

    it("relays the most recent poll's failure reason", async () => {
      // Arrange - node-server rejecting the sidecar's key must not read as a
      // clean bill of health for secrets it can no longer be asked about.
      stubPoller(fastify, {
        enabled: true,
        lastResult: {
          ok: false,
          reason: 'unauthorized',
          processUid: null,
          restarted: false,
        },
        secretPlaceholders: null,
      });

      // Act
      const res = await fastify.inject({ method: 'GET', url: ROUTE });

      // Assert
      expect(res.json()).toStrictEqual({
        nodeServer: { status: 'unavailable', reason: 'unauthorized' },
      });
    });

    it('reports the classification unchanged once the last poll succeeded', async () => {
      // Arrange
      stubPoller(fastify, {
        enabled: true,
        lastResult: {
          ok: true,
          reason: null,
          processUid: '11111111-1111-4111-8111-111111111111',
          restarted: false,
        },
        secretPlaceholders: {
          sessionTokenSigningKeyIsPlaceholder: false,
          sessionManagerServiceApiKeyIsPlaceholder: false,
          nodeServerServiceApiKeyIsPlaceholder: false,
          transcriptionServiceApiKeyIsPlaceholder: true,
        },
      });

      // Act
      const res = await fastify.inject({ method: 'GET', url: ROUTE });

      // Assert
      expect(res.json()).toStrictEqual({
        nodeServer: {
          status: 'ok',
          secretPlaceholders: {
            sessionTokenSigningKeyIsPlaceholder: false,
            sessionManagerServiceApiKeyIsPlaceholder: false,
            nodeServerServiceApiKeyIsPlaceholder: false,
            transcriptionServiceApiKeyIsPlaceholder: true,
          },
        },
      });
    });

    it('stays unavailable if the last poll failed even with a stale classification cached', async () => {
      // Arrange - a consumer must be able to tell "node-server says X" from
      // "cannot currently ask node-server"; a stale-but-present classification
      // must not read as current.
      stubPoller(fastify, {
        enabled: true,
        lastResult: {
          ok: false,
          reason: 'unreachable',
          processUid: null,
          restarted: false,
        },
        secretPlaceholders: {
          sessionTokenSigningKeyIsPlaceholder: false,
          sessionManagerServiceApiKeyIsPlaceholder: false,
          nodeServerServiceApiKeyIsPlaceholder: false,
          transcriptionServiceApiKeyIsPlaceholder: false,
        },
      });

      // Act
      const res = await fastify.inject({ method: 'GET', url: ROUTE });

      // Assert
      expect(res.json()).toStrictEqual({
        nodeServer: { status: 'unavailable', reason: 'unreachable' },
      });
    });
  });
});
