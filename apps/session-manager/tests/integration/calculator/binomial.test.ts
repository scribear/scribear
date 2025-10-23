import { beforeEach, describe, expect } from 'vitest';
import { type MockProxy, mock } from 'vitest-mock-extended';

import {
  type BaseFastifyInstance,
  LogLevel,
} from '@scribear/base-fastify-server';

import AppConfig from '../../../src/app_config/app_config.js';
import createServer from '../../../src/server/create_server.js';

describe('Integration Tests - /calculator/binomial', (it) => {
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
    const request = { a: 12, b: 34, op: '+' };
    const result = 46;

    // Act
    const response = await fastify.inject({
      method: 'POST',
      url: '/calculator/binomial',
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
    const request = { a: 12, b: 34, op: '-' };
    const result = -22;

    // Act
    const response = await fastify.inject({
      method: 'POST',
      url: '/calculator/binomial',
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
    const request = { a: 12, b: 34.5, op: '+' };

    // Act
    const response = await fastify.inject({
      method: 'POST',
      url: '/calculator/binomial',
      body: request,
    });

    // Assert
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      requestErrors: [
        {
          key: '/body/b',
        },
      ],
    });
  });

  /**
   * Test that server rejects invalid operator
   */
  it('rejects invalid operator', async () => {
    // Arrange
    const request = { a: 12, b: 34, op: '*' };

    // Act
    const response = await fastify.inject({
      method: 'POST',
      url: '/calculator/binomial',
      body: request,
    });

    // Assert
    expect(response.statusCode).toBe(400);
  });
});
