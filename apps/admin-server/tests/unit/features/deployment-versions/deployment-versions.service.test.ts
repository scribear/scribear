import { afterEach, beforeEach, describe, expect, vi } from 'vitest';

import type { BuildInfo } from '@scribear/base-fastify-server';

import type { DeploymentVersionsConfig } from '#src/server/features/deployment-versions/deployment-versions.service.js';
import { DeploymentVersionsService } from '#src/server/features/deployment-versions/deployment-versions.service.js';

const COMMIT = 'def6e68f0b3c4a1d9e2f5a7b8c0d1e2f3a4b5c6d';
const OLDER = '17db8150a2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7';

/** A build document as a container would serve it. */
function build(overrides: Partial<BuildInfo> = {}): BuildInfo {
  return {
    service: 'session-manager',
    version: '1.4.2',
    commit: COMMIT,
    ref: 'staging',
    builtAt: '2026-07-24T12:03:11Z',
    imageTags: ['staging', 'staging-def6e68'],
    pullRequest: null,
    origin: 'ci',
    dirty: false,
    ...overrides,
  };
}

function config(
  overrides: Partial<DeploymentVersionsConfig> = {},
): DeploymentVersionsConfig {
  return {
    timeoutMs: 3_000,
    targets: [
      { name: 'session-manager', url: 'http://session-manager:80/build-info' },
      { name: 'node-server', url: 'http://node-server:80/build-info' },
    ],
    nonReporting: [{ name: 'scribear-db', detail: 'no HTTP surface' }],
    ...overrides,
  };
}

/**
 * Answers each target URL from a map, so a test names what each container said
 * rather than the order they happen to be probed in.
 */
function respondWith(
  responses: Record<string, Response | Error>,
): ReturnType<typeof vi.fn> {
  return vi.fn((url: string) => {
    const response = responses[url];
    if (response === undefined) throw new Error(`unexpected fetch: ${url}`);
    if (response instanceof Error) return Promise.reject(response);
    return Promise.resolve(response);
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('DeploymentVersionsService', (it) => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // admin-server's own row is read in-process, not fetched, so its build is
    // set here rather than stubbed as a response.
    process.env['SCRIBEAR_BUILD_SERVICE'] = 'admin-server';
    process.env['SCRIBEAR_BUILD_VERSION'] = '1.4.2';
    process.env['SCRIBEAR_BUILD_COMMIT'] = COMMIT;
    process.env['SCRIBEAR_BUILD_REF'] = 'staging';
    process.env['SCRIBEAR_BUILD_TIME'] = '2026-07-24T12:03:11Z';
    process.env['SCRIBEAR_BUILD_TAGS'] = 'staging';
    process.env['SCRIBEAR_BUILD_ORIGIN'] = 'ci';
    delete process.env['SCRIBEAR_BUILD_PR'];
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.unstubAllGlobals();
  });

  it('reports every container, including the ones that cannot answer', async () => {
    // Arrange
    vi.stubGlobal(
      'fetch',
      respondWith({
        'http://session-manager:80/build-info': jsonResponse(build()),
        'http://node-server:80/build-info': jsonResponse(
          build({ service: 'node-server' }),
        ),
      }),
    );

    // Act
    const report = await new DeploymentVersionsService(config()).report();

    // Assert
    expect(report.containers.map((c) => c.service)).toEqual([
      'admin-server',
      'session-manager',
      'node-server',
      'scribear-db',
    ]);
    expect(report.containers.map((c) => c.status)).toEqual([
      'ok',
      'ok',
      'ok',
      'not-reported',
    ]);
    expect(report.expectedCommit).toBe(COMMIT);
    expect(report.mismatched).toEqual([]);
    expect(report.unstamped).toBe(false);
  });

  // The whole point of the page: one image was not pulled, and nothing else in
  // the console can see it, because a stale container is a healthy container.
  it('names the container the majority disagrees with', async () => {
    // Arrange
    vi.stubGlobal(
      'fetch',
      respondWith({
        'http://session-manager:80/build-info': jsonResponse(build()),
        'http://node-server:80/build-info': jsonResponse(
          build({ service: 'node-server', commit: OLDER }),
        ),
      }),
    );

    // Act
    const report = await new DeploymentVersionsService(config()).report();

    // Assert
    expect(report.expectedCommit).toBe(COMMIT);
    expect(report.mismatched).toEqual(['node-server']);
  });

  // Anchoring on admin-server's own commit would report every other container
  // as wrong when it is the console that was left behind. The majority is the
  // intended version whichever container is the straggler.
  it('takes the majority commit even when admin-server is the odd one out', async () => {
    // Arrange
    process.env['SCRIBEAR_BUILD_COMMIT'] = OLDER;
    vi.stubGlobal(
      'fetch',
      respondWith({
        'http://session-manager:80/build-info': jsonResponse(build()),
        'http://node-server:80/build-info': jsonResponse(
          build({ service: 'node-server' }),
        ),
      }),
    );

    // Act
    const report = await new DeploymentVersionsService(config()).report();

    // Assert
    expect(report.expectedCommit).toBe(COMMIT);
    expect(report.mismatched).toEqual(['admin-server']);
  });

  // A 404 means the container answered and has no such route: it is running an
  // image from before build reporting, which is itself the answer. Reporting it
  // as unreachable would send an operator to look for a container that is down.
  it('distinguishes an image that predates build reporting from one that is down', async () => {
    // Arrange
    vi.stubGlobal(
      'fetch',
      respondWith({
        'http://session-manager:80/build-info': jsonResponse(
          { error: 'ROUTE_NOT_FOUND' },
          404,
        ),
        'http://node-server:80/build-info': new Error('ECONNREFUSED'),
      }),
    );

    // Act
    const report = await new DeploymentVersionsService(config()).report();

    // Assert
    const byName = new Map(report.containers.map((c) => [c.service, c]));
    expect(byName.get('session-manager')?.status).toBe('unsupported');
    expect(byName.get('node-server')?.status).toBe('unreachable');
    expect(byName.get('node-server')?.detail).toBe('connection failed');
  });

  // Four of these documents are produced outside this codebase's type system -
  // one by a Python service, three by a shell script in an nginx image - so
  // "it deserialized" is not evidence it has the shape the console renders.
  it('rejects a body that is not a build document', async () => {
    // Arrange
    vi.stubGlobal(
      'fetch',
      respondWith({
        'http://session-manager:80/build-info': jsonResponse({
          ...build(),
          imageTags: 'staging',
        }),
        'http://node-server:80/build-info': jsonResponse(
          build({ service: 'node-server' }),
        ),
      }),
    );

    // Act
    const report = await new DeploymentVersionsService(config()).report();

    // Assert
    const sessionManager = report.containers.find(
      (c) => c.service === 'session-manager',
    );
    expect(sessionManager?.status).toBe('unreachable');
    expect(sessionManager?.detail).toBe(
      'answered with something that is not a build document',
    );
  });

  // The `npm run dev` case: containers answer, and not one of them knows what
  // it was built from, because nothing built them.
  it('reports an unstamped stack rather than a table of blanks', async () => {
    // Arrange
    process.env = { ...originalEnv };
    vi.stubGlobal(
      'fetch',
      respondWith({
        'http://session-manager:80/build-info': jsonResponse(
          build({ commit: 'unknown', origin: 'unknown', imageTags: [] }),
        ),
        'http://node-server:80/build-info': jsonResponse(
          build({
            service: 'node-server',
            commit: 'unknown',
            origin: 'unknown',
            imageTags: [],
          }),
        ),
      }),
    );

    // Act
    const report = await new DeploymentVersionsService(config()).report();

    // Assert
    expect(report.unstamped).toBe(true);
    expect(report.expectedCommit).toBeNull();
    expect(report.mismatched).toEqual([]);
  });

  it('flags containers built locally and from a modified working tree', async () => {
    // Arrange
    vi.stubGlobal(
      'fetch',
      respondWith({
        'http://session-manager:80/build-info': jsonResponse(
          build({ origin: 'local', dirty: true }),
        ),
        'http://node-server:80/build-info': jsonResponse(
          build({ service: 'node-server', origin: 'local' }),
        ),
      }),
    );

    // Act
    const report = await new DeploymentVersionsService(config()).report();

    // Assert
    expect(report.locallyBuilt).toEqual(['session-manager', 'node-server']);
    expect(report.dirty).toEqual(['session-manager']);
  });

  it('carries the pull request a PR-built image came from', async () => {
    // Arrange
    vi.stubGlobal(
      'fetch',
      respondWith({
        'http://session-manager:80/build-info': jsonResponse(
          build({ pullRequest: 157, imageTags: ['PR-157'] }),
        ),
        'http://node-server:80/build-info': jsonResponse(
          build({ service: 'node-server' }),
        ),
      }),
    );

    // Act
    const report = await new DeploymentVersionsService(config()).report();

    // Assert
    const sessionManager = report.containers.find(
      (c) => c.service === 'session-manager',
    );
    expect(sessionManager?.build?.pullRequest).toBe(157);
    expect(sessionManager?.build?.imageTags).toEqual(['PR-157']);
  });

  // One hung container must not be able to hold the page open, so every probe
  // carries a hard timeout rather than waiting on the OS TCP timeout.
  it('bounds every probe with the configured timeout', async () => {
    // Arrange
    const fetchMock = respondWith({
      'http://session-manager:80/build-info': jsonResponse(build()),
      'http://node-server:80/build-info': jsonResponse(
        build({ service: 'node-server' }),
      ),
    });
    vi.stubGlobal('fetch', fetchMock);

    // Act
    await new DeploymentVersionsService(config({ timeoutMs: 1_500 })).report();

    // Assert
    for (const call of fetchMock.mock.calls) {
      expect((call[1] as RequestInit).signal).toBeInstanceOf(AbortSignal);
    }
  });
});
