import { beforeEach, describe, expect, vi } from 'vitest';

import type { AppConfig } from '#src/app-config/app-config.js';

vi.mock('awilix', () => ({
  asValue: vi.fn((value: unknown) => ({ kind: 'value' as const, value })),
  asClass: vi.fn((Class: unknown, opts?: unknown) => ({
    kind: 'class' as const,
    Class,
    opts,
  })),
  asFunction: vi.fn((fn: unknown, opts?: unknown) => ({
    kind: 'function' as const,
    fn,
    opts,
  })),
  Lifetime: {
    SINGLETON: 'SINGLETON',
    SCOPED: 'SCOPED',
    TRANSIENT: 'TRANSIENT',
  },
}));

const redisMock = vi.hoisted(() => ({
  createTelemetryRedisClient: vi.fn(() => ({ sentinel: 'redis-client' })),
}));

vi.mock('@scribear/scribear-redis', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@scribear/scribear-redis')>();
  return {
    ...actual,
    createTelemetryRedisClient: redisMock.createTelemetryRedisClient,
  };
});

import registerDependencies from '#src/server/dependency-injection/register-dependencies.js';

interface CapturedRegistration {
  telemetryRedisClient: {
    kind: string;
    fn: (telemetryPublisherConfig: { redisUrl: string }) => unknown;
  };
}

function makeConfig(redisUrl = 'redis://localhost:6379'): AppConfig {
  return {
    baseConfig: {
      isDevelopment: false,
      logLevel: 'info',
      port: 8080,
      host: '127.0.0.1',
    },
    serviceAuthConfig: { serviceApiKey: 'key' },
    sessionTokenConfig: { signingKey: 'key' },
    sessionManagerClientConfig: { baseUrl: 'http://sm', serviceApiKey: 'key' },
    transcriptionServiceClientConfig: { baseUrl: 'http://ts', apiKey: 'key' },
    telemetryPublisherConfig: { redisUrl, nodeInstanceId: 'node-test' },
    demoRoomConfig: { enabled: false, sessionUid: 'uid' },
  } as unknown as AppConfig;
}

describe('registerDependencies telemetryRedisClient factory', (it) => {
  let registration: CapturedRegistration;

  beforeEach(() => {
    redisMock.createTelemetryRedisClient.mockClear();
    const container = { register: vi.fn() };
    registerDependencies(container as never, makeConfig());
    registration = container.register.mock
      .calls[0]![0] as CapturedRegistration;
  });

  it('registers telemetryRedisClient via asFunction', () => {
    expect(registration.telemetryRedisClient.kind).toBe('function');
  });

  it('the factory calls createTelemetryRedisClient with the configured redisUrl', () => {
    registration.telemetryRedisClient.fn({ redisUrl: 'redis://localhost:6379' });
    expect(redisMock.createTelemetryRedisClient).toHaveBeenCalledWith(
      'redis://localhost:6379',
    );
  });
});
