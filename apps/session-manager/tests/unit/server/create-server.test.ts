import { type Mock, beforeEach, describe, expect, vi } from 'vitest';

vi.mock('@scribear/base-fastify-server', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@scribear/base-fastify-server')>();
  return { ...actual, createBaseServer: vi.fn() };
});

import { createBaseServer } from '@scribear/base-fastify-server';
import type { AppConfig } from '#src/server/dependency-injection/app-dependencies.js';
import createServer from '#src/server/create-server.js';
import { createMockLogger } from '#tests/utils/mock-logger.js';

type Hook = (...args: unknown[]) => unknown;

describe('createServer', () => {
  let mockWorker: { start: Mock; stop: Mock };
  let mockSeeder: { seed: Mock };
  let mockDbClient: { destroy: Mock };
  let onReadyHooks: Hook[];
  let onCloseHooks: Hook[];
  let mockFastify: { register: Mock; addHook: Mock };
  let mockContainer: { resolve: Mock; register: Mock };
  let logger: ReturnType<typeof createMockLogger>;

  function buildConfig(demoRoomEnabled: boolean): AppConfig {
    return {
      baseConfig: { isDevelopment: false, logLevel: 'silent' },
      demoRoomConfig: { enabled: demoRoomEnabled },
    } as unknown as AppConfig;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    logger = createMockLogger();
    mockWorker = { start: vi.fn(), stop: vi.fn() };
    mockSeeder = { seed: vi.fn() };
    mockDbClient = { destroy: vi.fn() };
    onReadyHooks = [];
    onCloseHooks = [];
    mockFastify = {
      register: vi.fn(),
      addHook: vi.fn((event: string, fn: Hook) => {
        if (event === 'onReady') onReadyHooks.push(fn);
        if (event === 'onClose') onCloseHooks.push(fn);
      }),
    };
    mockContainer = {
      resolve: vi.fn((name: string) => {
        if (name === 'materializationWorker') return mockWorker;
        if (name === 'demoRoomSeeder') return mockSeeder;
        if (name === 'dbClient') return mockDbClient;
        throw new Error(`unexpected resolve: ${name}`);
      }),
      register: vi.fn(),
    };
    vi.mocked(createBaseServer).mockReturnValue({
      logger,
      dependencyContainer: mockContainer,
      fastify: mockFastify,
    } as never);
  });

  describe('materialization worker lifecycle', (it) => {
    it('starts the worker when the server becomes ready', async () => {
      await createServer(buildConfig(false));

      await Promise.all(onReadyHooks.map((hook) => hook()));

      expect(mockWorker.start).toHaveBeenCalledTimes(1);
    });

    it('stops the worker when the server closes', async () => {
      await createServer(buildConfig(false));

      await Promise.all(onCloseHooks.map((hook) => hook()));

      expect(mockWorker.stop).toHaveBeenCalledTimes(1);
    });
  });

  describe('demo-room seeding', (it) => {
    it('swallows a transient seeding failure so a healthy instance stays up', async () => {
      mockSeeder.seed.mockRejectedValue(new Error('ECONNREFUSED'));

      await createServer(buildConfig(true));

      await Promise.all(onReadyHooks.map((hook) => hook()));

      expect(mockSeeder.seed).toHaveBeenCalledTimes(1);
      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ err: expect.any(Error) }),
        expect.stringContaining('seeding failed'),
      );
    });
  });

  describe('database pool shutdown', (it) => {
    it('drains the pg pool when the server closes', async () => {
      await createServer(buildConfig(false));

      await Promise.all(onCloseHooks.map((hook) => hook()));

      expect(mockDbClient.destroy).toHaveBeenCalledTimes(1);
    });
  });
});
