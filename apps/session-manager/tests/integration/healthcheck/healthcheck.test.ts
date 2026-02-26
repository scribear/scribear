import { beforeEach, describe, expect } from 'vitest';
import { type MockProxy, mock } from 'vitest-mock-extended';

import {
  type BaseFastifyInstance,
  LogLevel,
} from '@scribear/base-fastify-server';

import AppConfig from '#src/app-config/app-config.js';
import createServer from '#src/server/create-server.js';

describe('Integration Tests - /healthcheck', (it) => {
  let fastify: BaseFastifyInstance;
  let mockConfig: MockProxy<AppConfig>;

  beforeEach(async () => {
    mockConfig = mock<AppConfig>({
      baseConfig: { isDevelopment: false, logLevel: LogLevel.SILENT },
    });

    const server = await createServer(mockConfig);
    fastify = server.fastify;
  });

  /**
   * Test that server responds successfully on /healthcheck endpoint
   */
  it('responds with 200 on /healthcheck', async () => {
    // Arrange
    // Act
    const response = await fastify.inject({
      method: 'GET',
      url: '/healthcheck',
    });

    // Assert
    expect(response.statusCode).toBe(200);
  });
});
