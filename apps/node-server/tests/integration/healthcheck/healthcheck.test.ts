import { beforeEach, describe, expect } from 'vitest';
import { type MockProxy, mock } from 'vitest-mock-extended';

import {
  type BaseFastifyInstance,
  LogLevel,
} from '@scribear/base-fastify-server';
import { HEALTHCHECK_ROUTE } from '@scribear/node-server-schema';

import type AppConfig from '#src/app-config/app-config.js';
import createServer from '#src/server/create-server.js';

describe(`Integration Tests - ${HEALTHCHECK_ROUTE.method} ${HEALTHCHECK_ROUTE.url}`, (it) => {
  let fastify: BaseFastifyInstance;
  let mockConfig: MockProxy<AppConfig>;

  beforeEach(async () => {
    mockConfig = mock<AppConfig>({
      baseConfig: { isDevelopment: false, logLevel: LogLevel.SILENT },
    });

    const server = await createServer(mockConfig);
    fastify = server.fastify;
  });

  it('responds with 200', async () => {
    // Act
    const response = await fastify.inject({
      ...HEALTHCHECK_ROUTE,
    });

    // Assert
    expect(response.statusCode).toBe(200);
  });
});
