import { afterEach, beforeEach, describe, expect } from 'vitest';

import { LogLevel } from '@scribear/base-fastify-server';

import { AppConfig } from '#src/app-config/app-config.js';
import { DEFAULT_MATERIALIZATION_WORKER_CONFIG } from '#src/server/features/schedule-management/materialization.worker.js';

// A fully-populated, valid environment. Values are set on `process.env` before
// each test, which env-schema merges with higher precedence than any on-disk
// `.env` file, keeping these tests deterministic regardless of the local env.
const VALID_ENV: Record<string, string> = {
  LOG_LEVEL: 'warn',
  PORT: '8080',
  HOST: '127.0.0.1',
  ADMIN_API_KEY: 'admin-key',
  SESSION_MANAGER_SERVICE_API_KEY: 'service-key',
  SESSION_TOKEN_SIGNING_KEY: 'signing-key',
  DB_HOST: 'db-host',
  DB_PORT: '5432',
  DB_NAME: 'scribear',
  DB_USER: 'dbuser',
  DB_PASSWORD: 'dbpass',
};
const ENV_KEYS = Object.keys(VALID_ENV);

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
      process.env[key] = VALID_ENV[key];
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

    it('maps admin, service, and session-token configuration', () => {
      // Act
      const config = new AppConfig();

      // Assert
      expect(config.adminAuthConfig).toStrictEqual({
        adminApiKey: 'admin-key',
      });
      expect(config.serviceAuthConfig).toStrictEqual({
        serviceApiKey: 'service-key',
      });
      expect(config.sessionTokenConfig).toStrictEqual({
        signingKey: 'signing-key',
      });
    });

    it('maps database configuration and coerces the db port', () => {
      // Act
      const config = new AppConfig();

      // Assert
      expect(config.dbClientConfig).toStrictEqual({
        dbHost: 'db-host',
        dbPort: 5432,
        dbName: 'scribear',
        dbUser: 'dbuser',
        dbPassword: 'dbpass',
      });
    });

    it('exposes the default materialization worker configuration', () => {
      // Act
      const config = new AppConfig();

      // Assert
      expect(config.materializationWorkerConfig).toStrictEqual(
        DEFAULT_MATERIALIZATION_WORKER_CONFIG,
      );
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
