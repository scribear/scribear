import { describe, expect } from 'vitest';
import { mock } from 'vitest-mock-extended';

import { LogLevel } from '@scribear/base-fastify-server';

import AppConfig from '@/app-config/app-config.js';
import createServer from '@/server/create-server.js';

describe('Integration Tests - /api-docs', (it) => {
  /**
   * Test that server does not expose swagger /api-docs endpoint when not in development mode
   */
  it('returns 404 on /api-docs when not in development mode', async () => {
    // Arrange
    const mockConfig = mock<AppConfig>({
      baseConfig: { isDevelopment: false, logLevel: LogLevel.SILENT },
    });
    const { fastify } = await createServer(mockConfig);

    // Act
    const response = await fastify.inject({
      method: 'GET',
      url: '/api-docs',
    });

    // Assert
    expect(response.statusCode).toBe(404);
  });

  /**
   * Test that server does expose swagger /api-docs endpoint when in development mode
   */
  it('returns 200 on /api-docs when in development mode', async () => {
    // Arrange
    const mockConfig = mock<AppConfig>({
      baseConfig: { isDevelopment: true, logLevel: LogLevel.SILENT },
    });
    const { fastify } = await createServer(mockConfig);

    // Act
    const response = await fastify.inject({
      method: 'GET',
      url: '/api-docs',
    });

    // Assert
    expect(response.statusCode).toBe(200);
  });
});
