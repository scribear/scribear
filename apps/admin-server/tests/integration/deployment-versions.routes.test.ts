import { afterEach, beforeAll, beforeEach, describe, expect, vi } from 'vitest';

import type { BuildInfo } from '@scribear/base-fastify-server';

import type { DeploymentVersionsReport } from '#src/server/features/deployment-versions/deployment-versions.service.js';
import {
  TEST_CLIENT_WEBAPP_BASE_URL,
  TEST_NODE_BASE_URL,
  TEST_SM_BASE_URL,
  login,
  useServer,
} from '#tests/utils/use-server.js';

const URL = '/api/admin/v1/deployment-versions';

const COMMIT = 'def6e68f0b3c4a1d9e2f5a7b8c0d1e2f3a4b5c6d';
const OLDER = '17db8150a2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7';

interface DeploymentVersionsBody {
  ok: boolean;
  data: DeploymentVersionsReport;
}

function build(overrides: Partial<BuildInfo> = {}): BuildInfo {
  return {
    service: 'session-manager',
    version: '1.4.2',
    commit: COMMIT,
    ref: 'staging',
    builtAt: '2026-07-24T12:03:11Z',
    imageTags: ['staging'],
    pullRequest: null,
    origin: 'ci',
    dirty: false,
    ...overrides,
  };
}

describe('Deployment versions route', () => {
  const server = useServer();
  // Logged in once: the login route is rate limited to 5 per minute.
  let cookie = '';

  beforeAll(async () => {
    cookie = (await login(server.fastify)).cookie;
  });

  /** Every probed container answers with the same build. */
  function stubAllOnOneCommit() {
    vi.stubGlobal('fetch', (url: string) => {
      const service = url.startsWith(TEST_SM_BASE_URL)
        ? 'session-manager'
        : url.startsWith(TEST_NODE_BASE_URL)
          ? 'node-server'
          : url.startsWith(TEST_CLIENT_WEBAPP_BASE_URL)
            ? 'client-webapp'
            : null;

      if (service === null) {
        return Promise.reject(new Error('connect ECONNREFUSED'));
      }

      return Promise.resolve(
        new Response(JSON.stringify(build({ service })), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    });
  }

  beforeEach(() => {
    stubAllOnOneCommit();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('authentication', (it) => {
    // The individual /build-info surfaces are unauthenticated because nothing
    // outside the compose network can reach them. This route is the one place
    // all of them are readable from a browser, so it is session-gated.
    it('rejects an unauthenticated caller', async () => {
      const res = await server.fastify.inject({ method: 'GET', url: URL });

      expect(res.statusCode).toBe(401);
    });
  });

  describe('a stack on one commit', (it) => {
    it('reports every container, the ones that cannot answer included', async () => {
      // Act
      const res = await server.fastify.inject({
        method: 'GET',
        url: URL,
        headers: { cookie },
      });

      // Assert
      expect(res.statusCode).toBe(200);
      const { data } = res.json<DeploymentVersionsBody>();

      expect(data.containers.map((c) => c.service)).toEqual([
        'admin-server',
        'session-manager',
        'node-server',
        'client-webapp',
        'scribear-db',
      ]);
      expect(data.mismatched).toEqual([]);
      expect(data.expectedCommit).toBe(COMMIT);
    });
  });

  describe('a half-finished upgrade', (it) => {
    // The failure this page exists for, and the only place in the console that
    // can see it: a stale container is a perfectly healthy container, so the
    // health rollup stays green throughout.
    it('names the container the rest of the stack disagrees with', async () => {
      // Arrange
      vi.stubGlobal('fetch', (url: string) =>
        url.startsWith(TEST_NODE_BASE_URL)
          ? Promise.resolve(
              new Response(
                JSON.stringify(
                  build({ service: 'node-server', commit: OLDER }),
                ),
                {
                  status: 200,
                  headers: { 'content-type': 'application/json' },
                },
              ),
            )
          : Promise.resolve(
              new Response(JSON.stringify(build()), {
                status: 200,
                headers: { 'content-type': 'application/json' },
              }),
            ),
      );

      // Act
      const res = await server.fastify.inject({
        method: 'GET',
        url: URL,
        headers: { cookie },
      });

      // Assert
      const { data } = res.json<DeploymentVersionsBody>();
      expect(data.expectedCommit).toBe(COMMIT);
      expect(data.mismatched).toEqual(['node-server']);
    });
  });

  describe('containers that do not answer', (it) => {
    // Always 200: a container that did not answer is a row with a status, not a
    // failed request. A non-200 would hide every container that did answer
    // behind the one that did not.
    it('still answers 200 when every probe fails', async () => {
      // Arrange
      vi.stubGlobal('fetch', () =>
        Promise.reject(new Error('connect ECONNREFUSED')),
      );

      // Act
      const res = await server.fastify.inject({
        method: 'GET',
        url: URL,
        headers: { cookie },
      });

      // Assert
      expect(res.statusCode).toBe(200);
      const { data } = res.json<DeploymentVersionsBody>();

      // admin-server reads its own build in-process, so it reports even when
      // it can reach nothing at all.
      const self = data.containers.find((c) => c.service === 'admin-server');
      expect(self?.status).toBe('ok');
      expect(
        data.containers
          .filter((c) => c.service !== 'admin-server' && c.build !== null)
          .map((c) => c.service),
      ).toEqual([]);
    });
  });
});
