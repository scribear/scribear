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
  let mockTestAudioSeeder: { seed: Mock };
  let mockDbClient: { destroy: Mock };
  let onReadyHooks: Hook[];
  let onCloseHooks: Hook[];
  let mockFastify: { register: Mock; addHook: Mock };
  let mockContainer: { resolve: Mock; register: Mock };
  let logger: ReturnType<typeof createMockLogger>;

  function buildConfig(
    demoRoomEnabled: boolean,
    testAudioRoomsEnabled = false,
  ): AppConfig {
    return {
      baseConfig: { isDevelopment: false, logLevel: 'silent' },
      demoRoomConfig: { enabled: demoRoomEnabled },
      testAudioRoomsConfig: { enabled: testAudioRoomsEnabled },
    } as unknown as AppConfig;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    logger = createMockLogger();
    mockWorker = { start: vi.fn(), stop: vi.fn() };
    mockSeeder = { seed: vi.fn() };
    mockTestAudioSeeder = { seed: vi.fn() };
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
        if (name === 'testAudioRoomsSeeder') return mockTestAudioSeeder;
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

  describe('test-audio room seeding', (it) => {
    it('is not resolved at all when no device secret is configured', async () => {
      // Arrange / Act - the inert default. Resolving the seeder would be
      // harmless, but not resolving it is what guarantees a deployment that has
      // never asked for this feature cannot have rows appear in its tables.
      await createServer(buildConfig(false, false));
      await Promise.all(onReadyHooks.map((hook) => hook()));

      // Assert
      expect(mockTestAudioSeeder.seed).not.toHaveBeenCalled();
    });

    it('swallows a transient seeding failure so a healthy instance stays up', async () => {
      // Arrange - a database blip must not take down session-manager over two
      // test rooms, exactly as for the demo room above.
      mockTestAudioSeeder.seed.mockRejectedValue(new Error('ECONNREFUSED'));

      // Act
      await createServer(buildConfig(false, true));
      await Promise.all(onReadyHooks.map((hook) => hook()));

      // Assert
      expect(mockTestAudioSeeder.seed).toHaveBeenCalledTimes(1);
      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ err: expect.any(Error) }),
        expect.stringContaining('test-audio rooms: seeding failed'),
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
