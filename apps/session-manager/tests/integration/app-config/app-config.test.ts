import { afterEach, beforeEach, describe, expect } from 'vitest';

import { LogLevel } from '@scribear/base-fastify-server';

import { AppConfig } from '#src/app-config/app-config.js';
import { DEFAULT_DEMO_SESSION_UID } from '#src/server/features/demo-room/demo-room.constants.js';
import { DEFAULT_MATERIALIZATION_WORKER_CONFIG } from '#src/server/features/schedule-management/materialization.worker.js';

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

const OPTIONAL_ENV_KEYS = ['DEMO_ROOM_ENABLED', 'DEMO_SESSION_UID'];
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

  describe('boot with a valid environment', (it) => {
    it('constructs without throwing and maps every getter', () => {
      const config = new AppConfig(NO_DOTENV_FILE);

      expect(config.baseConfig).toStrictEqual({
        isDevelopment: false,
        logLevel: LogLevel.WARN,
        port: 8080,
        host: '127.0.0.1',
      });
      expect(config.adminAuthConfig).toStrictEqual({
        adminApiKey: 'admin-key',
      });
      expect(config.serviceAuthConfig).toStrictEqual({
        serviceApiKey: 'service-key',
      });
      expect(config.sessionTokenConfig).toStrictEqual({
        signingKey: 'signing-key',
      });
      expect(config.dbClientConfig).toStrictEqual({
        dbHost: 'db-host',
        dbPort: 5432,
        dbName: 'scribear',
        dbUser: 'dbuser',
        dbPassword: 'dbpass',
      });
      expect(config.materializationWorkerConfig).toStrictEqual(
        DEFAULT_MATERIALIZATION_WORKER_CONFIG,
      );
      expect(config.demoRoomConfig).toStrictEqual({
        enabled: true,
        sessionUid: DEFAULT_DEMO_SESSION_UID,
      });
    });
  });

  describe('schema validation', (it) => {
    it('throws when a required key is missing', () => {
      delete process.env['SESSION_TOKEN_SIGNING_KEY'];

      expect(() => new AppConfig(NO_DOTENV_FILE)).toThrow();
    });
  });

  describe('--dev flag', (it) => {
    it('reports isDevelopment as true when --dev is present in argv', () => {
      process.argv = ['node', 'app-config.test.ts', '--dev'];

      const config = new AppConfig(NO_DOTENV_FILE);

      expect(config.baseConfig.isDevelopment).toBe(true);
    });

    it('reports isDevelopment as false when --dev is absent from argv', () => {
      const config = new AppConfig(NO_DOTENV_FILE);

      expect(config.baseConfig.isDevelopment).toBe(false);
    });
  });

  describe('DEMO_ROOM_ENABLED coercion', (it) => {
    it('coerces "true" to enabled', () => {
      process.env['DEMO_ROOM_ENABLED'] = 'true';

      const config = new AppConfig(NO_DOTENV_FILE);

      expect(config.demoRoomConfig.enabled).toBe(true);
    });

    it('coerces "false" to disabled', () => {
      process.env['DEMO_ROOM_ENABLED'] = 'false';

      const config = new AppConfig(NO_DOTENV_FILE);

      expect(config.demoRoomConfig.enabled).toBe(false);
    });

    it('rejects "1"', () => {
      process.env['DEMO_ROOM_ENABLED'] = '1';

      expect(() => new AppConfig(NO_DOTENV_FILE)).toThrow();
    });

    it('rejects "0"', () => {
      process.env['DEMO_ROOM_ENABLED'] = '0';

      expect(() => new AppConfig(NO_DOTENV_FILE)).toThrow();
    });

    it('rejects an empty string', () => {
      process.env['DEMO_ROOM_ENABLED'] = '';

      expect(() => new AppConfig(NO_DOTENV_FILE)).toThrow();
    });
  });
});
