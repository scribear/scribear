import { afterEach, beforeEach, describe, expect, vi } from 'vitest';

import { LogLevel } from '@scribear/base-fastify-server';

import { AppConfig } from '#src/app-config/app-config.js';
import { DEFAULT_DEMO_SESSION_UID } from '#src/server/features/demo-room/demo-room.constants.js';

const osMock = vi.hoisted(() => ({ hostname: vi.fn() }));

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, hostname: osMock.hostname };
});

const VALID_ENV: Record<string, string> = {
  LOG_LEVEL: 'warn',
  PORT: '8080',
  HOST: '127.0.0.1',
  NODE_SERVER_SERVICE_API_KEY: 'node-server-service-key',
  SESSION_TOKEN_SIGNING_KEY: 'signing-key',
  SESSION_MANAGER_BASE_URL: 'http://session-manager:3000',
  SESSION_MANAGER_SERVICE_API_KEY: 'session-manager-key',
  TRANSCRIPTION_SERVICE_BASE_URL: 'http://transcription:4000',
  TRANSCRIPTION_SERVICE_API_KEY: 'transcription-key',
};

const OPTIONAL_ENV_KEYS = [
  'REDIS_URL',
  'NODE_INSTANCE_ID',
  'DEMO_ROOM_ENABLED',
  'DEMO_SESSION_UID',
];
const ENV_KEYS = [...Object.keys(VALID_ENV), ...OPTIONAL_ENV_KEYS];

const NO_DOTENV_FILE = '/does-not-exist.env';

describe('AppConfig (integration smoke)', () => {
  let savedEnv: Record<string, string | undefined>;
  let savedArgv: string[];

  beforeEach(() => {
    savedArgv = process.argv;
    savedEnv = {};
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      const value = VALID_ENV[key];
      if (value === undefined) {
        Reflect.deleteProperty(process.env, key);
      } else {
        process.env[key] = value;
      }
    }
    process.argv = ['node', 'app-config.test.ts'];
    osMock.hostname.mockReturnValue('test-host');
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) {
        Reflect.deleteProperty(process.env, key);
      } else {
        process.env[key] = savedEnv[key];
      }
    }
    process.argv = savedArgv;
    osMock.hostname.mockReset();
  });

  describe('boot with a valid environment', (it) => {
    it('constructs without throwing and maps every getter', () => {
      const config = new AppConfig(NO_DOTENV_FILE);

      expect(config.baseConfig).toStrictEqual({
        isDevelopment: false,
        logLevel: LogLevel.WARN,
        port: 8080,
        host: '127.0.0.1',
      });
      expect(config.serviceAuthConfig).toStrictEqual({
        serviceApiKey: 'node-server-service-key',
      });
      expect(config.sessionTokenConfig).toStrictEqual({
        signingKey: 'signing-key',
      });
      expect(config.sessionManagerClientConfig).toStrictEqual({
        baseUrl: 'http://session-manager:3000',
        serviceApiKey: 'session-manager-key',
      });
      expect(config.transcriptionServiceClientConfig).toStrictEqual({
        baseUrl: 'http://transcription:4000',
        apiKey: 'transcription-key',
      });
      expect(config.telemetryPublisherConfig).toStrictEqual({
        redisUrl: '',
        nodeInstanceId: 'test-host',
      });
      expect(config.demoRoomConfig).toStrictEqual({
        enabled: true,
        sessionUid: DEFAULT_DEMO_SESSION_UID,
      });
    });
  });

  describe('NODE_INSTANCE_ID colon guard', (it) => {
    it('throws when the id contains a colon (would forge a Redis telemetry key)', () => {
      process.env['NODE_INSTANCE_ID'] = 'bad:id';

      expect(
        () => new AppConfig(NO_DOTENV_FILE).telemetryPublisherConfig,
      ).toThrow(/NODE_INSTANCE_ID/);
    });
  });

  describe('NODE_INSTANCE_ID empty guard', (it) => {
    it('throws when the resolved id is empty', () => {
      osMock.hostname.mockReturnValue('');

      expect(
        () => new AppConfig(NO_DOTENV_FILE).telemetryPublisherConfig,
      ).toThrow(/NODE_INSTANCE_ID/);
    });
  });

  describe('NODE_INSTANCE_ID hostname fallback', (it) => {
    it('falls back to os.hostname() when the id is absent', () => {
      const config = new AppConfig(NO_DOTENV_FILE);

      const { nodeInstanceId } = config.telemetryPublisherConfig;
      expect(nodeInstanceId).toBe('test-host');
      expect(nodeInstanceId.length).toBeGreaterThan(0);
      expect(nodeInstanceId).not.toContain(':');
    });
  });

  describe('schema validation', (it) => {
    it('throws when a required key is missing', () => {
      delete process.env['SESSION_MANAGER_SERVICE_API_KEY'];

      expect(() => new AppConfig(NO_DOTENV_FILE)).toThrow();
    });
  });
});
