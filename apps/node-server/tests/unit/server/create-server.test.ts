import { beforeEach, describe, expect, vi } from 'vitest';

import type { AppConfig } from '#src/app-config/app-config.js';

const base = vi.hoisted(() => {
  const fastify = { register: vi.fn(), addHook: vi.fn() };
  const dependencyContainer = { register: vi.fn(), resolve: vi.fn() };
  const logger = { info: vi.fn() };
  const createBaseServer = vi.fn(() => ({
    logger,
    dependencyContainer,
    fastify,
  }));
  return { fastify, dependencyContainer, logger, createBaseServer };
});

vi.mock('@scribear/base-fastify-server', () => ({
  createBaseServer: base.createBaseServer,
}));

vi.mock('#src/server/plugins/swagger.js', () => ({ default: vi.fn() }));
vi.mock('#src/server/plugins/websocket.js', () => ({ default: vi.fn() }));
vi.mock('#src/server/dependency-injection/register-dependencies.js', () => ({
  default: vi.fn(),
}));
vi.mock('#src/server/features/probes/probes.router.js', () => ({
  probesRouter: vi.fn(),
}));
vi.mock('#src/server/features/status/status.router.js', () => ({
  statusRouter: vi.fn(),
}));
vi.mock('#src/server/features/transcription-stream/transcription-stream.router.js', () => ({
  transcriptionStreamRouter: vi.fn(),
}));

import swaggerPlugin from '#src/server/plugins/swagger.js';
import websocketPlugin from '#src/server/plugins/websocket.js';

import createServer from '#src/server/create-server.js';

function makeConfig(opts: {
  isDevelopment?: boolean;
  redisUrl?: string;
  demoEnabled?: boolean;
} = {}): AppConfig {
  return {
    baseConfig: {
      isDevelopment: opts.isDevelopment ?? false,
      logLevel: 'info',
      port: 8080,
      host: '127.0.0.1',
    },
    serviceAuthConfig: { serviceApiKey: 'key' },
    sessionTokenConfig: { signingKey: 'key' },
    sessionManagerClientConfig: { baseUrl: 'http://sm', serviceApiKey: 'key' },
    transcriptionServiceClientConfig: { baseUrl: 'http://ts', apiKey: 'key' },
    telemetryPublisherConfig: {
      redisUrl: opts.redisUrl ?? '',
      nodeInstanceId: 'node-test',
    },
    demoRoomConfig: {
      enabled: opts.demoEnabled ?? false,
      sessionUid: 'demo-session-uid',
    },
  } as unknown as AppConfig;
}

function hookCallback(
  name: string,
): ((...args: unknown[]) => unknown) | undefined {
  for (const call of base.fastify.addHook.mock.calls) {
    if (call[0] === name) {
      return call[1] as (...args: unknown[]) => unknown;
    }
  }
  return undefined;
}

describe('createServer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    base.dependencyContainer.resolve.mockReset();
  });

  describe('swagger plugin', (it) => {
    it('registers swagger and websocket when baseConfig.isDevelopment is true', async () => {
      await createServer(makeConfig({ isDevelopment: true }));

      expect(base.fastify.register).toHaveBeenCalledWith(websocketPlugin);
      expect(base.fastify.register).toHaveBeenCalledWith(swaggerPlugin);
    });

    it('skips swagger but still registers websocket when baseConfig.isDevelopment is false', async () => {
      await createServer(makeConfig({ isDevelopment: false }));

      expect(base.fastify.register).toHaveBeenCalledWith(websocketPlugin);
      expect(base.fastify.register).not.toHaveBeenCalledWith(swaggerPlugin);
    });
  });

  describe('redis telemetry publisher', (it) => {
    it('resolves the publisher and invokes start() from the onReady hook when redisUrl is set', async () => {
      const publisher = {
        start: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn().mockResolvedValue(undefined),
      };
      base.dependencyContainer.resolve.mockReturnValue(publisher);

      await createServer(makeConfig({ redisUrl: 'redis://localhost:6379' }));

      expect(base.dependencyContainer.resolve).toHaveBeenCalledWith(
        'redisTelemetryPublisher',
      );
      const onReady = hookCallback('onReady');
      expect(onReady).toBeDefined();

      onReady?.();
      expect(publisher.start).toHaveBeenCalledTimes(1);
    });

    it('does not await publisher.start() in onReady (fire-and-forget)', async () => {
      const startPromise = Promise.reject(new Error('redis down'));
      const publisher = {
        start: vi.fn(() => startPromise),
        stop: vi.fn().mockResolvedValue(undefined),
      };
      base.dependencyContainer.resolve.mockReturnValue(publisher);

      await createServer(makeConfig({ redisUrl: 'redis://localhost:6379' }));

      const onReady = hookCallback('onReady');
      expect(onReady).toBeDefined();

      // The hook returns undefined (not a promise): start() is not awaited, so a
      // rejecting start cannot make boot fail.
      const result = onReady?.();
      expect(result).toBeUndefined();
      expect(publisher.start).toHaveBeenCalledTimes(1);

      // Silence the floating rejection so it cannot fail this test.
      await startPromise.catch(() => undefined);
    });

    it('does not resolve the publisher or add hooks when redisUrl is empty', async () => {
      await createServer(makeConfig({ redisUrl: '' }));

      expect(base.dependencyContainer.resolve).not.toHaveBeenCalledWith(
        'redisTelemetryPublisher',
      );
      expect(hookCallback('onReady')).toBeUndefined();
      expect(hookCallback('onClose')).toBeUndefined();
    });
  });

  describe('demo caption source', (it) => {
    it('resolves and wires start/stop hooks when demoRoomConfig.enabled is true', async () => {
      const demo = { start: vi.fn(), stop: vi.fn() };
      base.dependencyContainer.resolve.mockReturnValue(demo);

      await createServer(makeConfig({ demoEnabled: true }));

      expect(base.dependencyContainer.resolve).toHaveBeenCalledWith(
        'demoCaptionSource',
      );

      const onReady = hookCallback('onReady');
      expect(onReady).toBeDefined();
      onReady?.();
      expect(demo.start).toHaveBeenCalledTimes(1);

      const onClose = hookCallback('onClose');
      expect(onClose).toBeDefined();
      onClose?.();
      expect(demo.stop).toHaveBeenCalledTimes(1);
    });

    it('does not resolve the demo caption source when disabled', async () => {
      await createServer(makeConfig({ demoEnabled: false }));

      expect(base.dependencyContainer.resolve).not.toHaveBeenCalledWith(
        'demoCaptionSource',
      );
    });
  });
});
