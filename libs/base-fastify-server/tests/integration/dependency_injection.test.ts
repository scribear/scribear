import { asValue } from 'awilix';
import type { AwilixContainer } from 'awilix';
import { beforeEach, describe, expect } from 'vitest';

import { LogLevel } from '../../src/index.js';
import createBaseServer from '../../src/server/create_base_server.js';
import type { BaseDependencies } from '../../src/server/types/base_dependencies.js';
import type { BaseFastifyInstance } from '../../src/server/types/base_fastify_types.js';

interface TestDependencies extends BaseDependencies {
  test: string;
}

describe('Integration Tests - Dependency Injection', (it) => {
  let fastify: BaseFastifyInstance;
  let container: AwilixContainer<TestDependencies>;

  beforeEach(() => {
    const server = createBaseServer(LogLevel.SILENT);

    fastify = server.fastify;
    container = server.dependencyContainer as AwilixContainer<TestDependencies>;
  });

  /**
   * Test that dependency container contains logger
   */
  it('makes logger available in dependency container', () => {
    // Arrange
    // Act
    const logger = container.resolve('logger');

    // Assert
    expect(logger).not.toBeUndefined();
  });

  /**
   * Test that dependency container makes registered dependencies available in request container scope
   */
  it('makes registered dependencies available in request handlers', async () => {
    // Arrange
    const testValue = 'TEST_VALUE';
    container.register({ test: asValue(testValue) });
    fastify.get('/di', (req, res) => {
      return res.send(req.diScope.resolve('test'));
    });

    // Act
    const response = await fastify.inject({
      method: 'GET',
      url: '/di',
    });

    // Assert
    expect(response.statusCode).toBe(200);
    expect(response.payload).toBe(testValue);
  });
});
