import { afterEach, beforeEach, describe, expect } from 'vitest';

import { BUILD_INFO_PATH, LogLevel } from '#src/index.js';
import createBaseServer from '#src/server/create-base-server.js';
import type { BaseFastifyInstance } from '#src/server/types/base-fastify-types.js';

/**
 * Every Node service inherits this route from `createBaseServer`, so these
 * tests stand in for four services rather than one.
 */
describe('Integration Tests - Build Info Route', (it) => {
  const originalEnv = { ...process.env };
  let fastify: BaseFastifyInstance;

  beforeEach(() => {
    process.env['SCRIBEAR_BUILD_SERVICE'] = 'session-manager';
    process.env['SCRIBEAR_BUILD_VERSION'] = '1.4.2';
    process.env['SCRIBEAR_BUILD_COMMIT'] = 'def6e68';
    process.env['SCRIBEAR_BUILD_REF'] = 'staging';
    process.env['SCRIBEAR_BUILD_TIME'] = '2026-07-24T12:03:11Z';
    process.env['SCRIBEAR_BUILD_TAGS'] = 'staging,staging-def6e68';
    process.env['SCRIBEAR_BUILD_ORIGIN'] = 'ci';
    delete process.env['SCRIBEAR_BUILD_PR'];

    fastify = createBaseServer(LogLevel.SILENT).fastify;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('reports the build the image was made from', async () => {
    // Act
    const response = await fastify.inject({
      method: 'GET',
      url: BUILD_INFO_PATH,
    });

    // Assert
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      service: 'session-manager',
      version: '1.4.2',
      commit: 'def6e68',
      ref: 'staging',
      builtAt: '2026-07-24T12:03:11Z',
      imageTags: ['staging', 'staging-def6e68'],
      pullRequest: null,
      origin: 'ci',
      dirty: false,
    });
  });

  // The route sits at the root, outside every service's `/api/<service>/v1`
  // prefix, because nginx proxies only the `/api` prefixes - which is what
  // keeps commit hashes off the public internet. A move under `/api` would be
  // an information disclosure, so the path is asserted rather than assumed.
  it('is served at the root, not under an /api prefix', () => {
    // Assert
    expect(BUILD_INFO_PATH).toBe('/build-info');
  });
});
