import { beforeEach, describe, expect } from 'vitest';
import { type MockProxy, mock } from 'vitest-mock-extended';

import {
  type BaseFastifyInstance,
  LogLevel,
} from '@scribear/base-fastify-server';

import AppConfig from '../../../src/app_config/app_config.js';
import createServer from '../../../src/server/create_server.js';

describe('Integration Tests - /calculator/monomial', (it) => {
  let fastify: BaseFastifyInstance;
  let mockConfig: MockProxy<AppConfig>;

  beforeEach(async () => {
    mockConfig = mock<AppConfig>({
      isDevelopment: false,
      logLevel: LogLevel.SILENT,
    });

    const server = await createServer(mockConfig);
    fastify = server.fastify;
  });

  /**
   * Test that server correctly adds two numbers
   */
  it('correctly adds two numbers', async () => {
    // Arrange
    const request = { a: 12, op: 'square' };
    const result = 144;

    // Act
    const response = await fastify.inject({
      method: 'POST',
      url: '/calculator/monomial',
      body: request,
    });

    // Assert
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ result });
  });

  /**
   * Test that server correctly subtracts two numbers
   */
  it('correctly subtracts two numbers', async () => {
    // Arrange
    const request = { a: 12, op: 'cube' };
    const result = 1728;

    // Act
    const response = await fastify.inject({
      method: 'POST',
      url: '/calculator/monomial',
      body: request,
    });

    // Assert
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ result });
  });

  /**
   * Test that server rejects invalid operand
   */
  it('rejects invalid operand', async () => {
    // Arrange
    const request = { a: 12.5, op: 'square' };

    // Act
    const response = await fastify.inject({
      method: 'POST',
      url: '/calculator/monomial',
      body: request,
    });

    // Assert
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      requestErrors: [
        {
          key: '/body/a',
        },
      ],
    });
  });

  /**
   * Test that server rejects invalid operator
   */
  it('rejects invalid operator', async () => {
    // Arrange
    const request = { a: 12, op: 'quad' };

    // Act
    const response = await fastify.inject({
      method: 'POST',
      url: '/calculator/monomial',
      body: request,
    });

    // Assert
    expect(response.statusCode).toBe(400);
  });
});
