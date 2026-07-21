import { hostname } from 'node:os';
import { afterEach, beforeEach, describe, expect } from 'vitest';

import { LogLevel } from '@scribear/base-fastify-server';

import { AppConfig } from '#src/app-config/app-config.js';

// A fully-populated, valid environment. Values are set on `process.env` before
// each test, which env-schema merges with higher precedence than any on-disk
// `.env` file, keeping these tests deterministic regardless of the local env.
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
/**
 * Optional variables, absent from {@link VALID_ENV} on purpose: they are
 * cleared before each test so the defaults are what is exercised, and restored
 * afterwards like the rest.
 */
const OPTIONAL_ENV_KEYS = ['REDIS_URL', 'NODE_INSTANCE_ID'];
const ENV_KEYS = [...Object.keys(VALID_ENV), ...OPTIONAL_ENV_KEYS];

// A path that does not exist, used to disable dotenv file loading so validation
// failures depend only on `process.env` (env-schema silently ignores ENOENT).
const NO_DOTENV_FILE = '/does-not-exist.env';

describe('AppConfig', () => {
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
    // Deterministic, non-dev argv unless a test opts in.
    process.argv = ['node', 'app-config.test.ts'];
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
  });

  describe('valid environment', (it) => {
    it('maps base configuration and coerces the port to a number', () => {
      // Act
      const config = new AppConfig();

      // Assert
      expect(config.baseConfig).toStrictEqual({
        isDevelopment: false,
        logLevel: LogLevel.WARN,
        port: 8080,
        host: '127.0.0.1',
      });
    });

    it('maps the inbound service-auth configuration', () => {
      // Act
      const config = new AppConfig();

      // Assert - the inbound key, not the outbound session-manager one
      expect(config.serviceAuthConfig).toStrictEqual({
        serviceApiKey: 'node-server-service-key',
      });
    });

    it('maps the session-token configuration', () => {
      // Act
      const config = new AppConfig();

      // Assert
      expect(config.sessionTokenConfig).toStrictEqual({
        signingKey: 'signing-key',
      });
    });

    it('maps the session-manager client configuration', () => {
      // Act
      const config = new AppConfig();

      // Assert
      expect(config.sessionManagerClientConfig).toStrictEqual({
        baseUrl: 'http://session-manager:3000',
        serviceApiKey: 'session-manager-key',
      });
    });

    it('maps the transcription-service client configuration', () => {
      // Act
      const config = new AppConfig();

      // Assert
      expect(config.transcriptionServiceClientConfig).toStrictEqual({
        baseUrl: 'http://transcription:4000',
        apiKey: 'transcription-key',
      });
    });
  });

  describe('telemetry publisher configuration', (it) => {
    it('is off and named after the host when neither variable is set', () => {
      // Act - both are absent from VALID_ENV, which is the state every
      // deployment predating B1.7 boots in.
      const config = new AppConfig(NO_DOTENV_FILE);

      // Assert
      expect(config.telemetryPublisherConfig.redisUrl).toBe('');
      expect(config.telemetryPublisherConfig.nodeInstanceId).toBe(hostname());
    });

    it('maps an explicit instance id and redis url', () => {
      // Arrange
      process.env['REDIS_URL'] = 'redis://:pw@redis:6379';
      process.env['NODE_INSTANCE_ID'] = 'node-a7';

      // Act
      const config = new AppConfig(NO_DOTENV_FILE);

      // Assert
      expect(config.telemetryPublisherConfig).toStrictEqual({
        redisUrl: 'redis://:pw@redis:6379',
        nodeInstanceId: 'node-a7',
      });
    });

    it('rejects an instance id containing a colon', () => {
      // Arrange - the id is interpolated into the telemetry key namespace, so
      // a colon would let it forge a key in another part of it. Failing here
      // means failing at boot rather than once per heartbeat.
      process.env['NODE_INSTANCE_ID'] = 'node:a7';

      // Act / Assert
      expect(
        () => new AppConfig(NO_DOTENV_FILE).telemetryPublisherConfig,
      ).toThrow(/NODE_INSTANCE_ID/);
    });
  });

  describe('--dev flag', (it) => {
    it('reports isDevelopment as true when --dev is present in argv', () => {
      // Arrange
      process.argv = ['node', 'app-config.test.ts', '--dev'];

      // Act
      const config = new AppConfig();

      // Assert
      expect(config.baseConfig.isDevelopment).toBe(true);
    });

    it('reports isDevelopment as false when --dev is absent from argv', () => {
      // Act
      const config = new AppConfig();

      // Assert
      expect(config.baseConfig.isDevelopment).toBe(false);
    });
  });

  describe('schema validation', (it) => {
    it('throws when a required variable is missing', () => {
      // Arrange
      delete process.env['SESSION_TOKEN_SIGNING_KEY'];

      // Act / Assert
      expect(() => new AppConfig(NO_DOTENV_FILE)).toThrow();
    });

    it('throws when PORT is outside the valid range', () => {
      // Arrange
      process.env['PORT'] = '99999';

      // Act / Assert
      expect(() => new AppConfig(NO_DOTENV_FILE)).toThrow();
    });
  });
});
