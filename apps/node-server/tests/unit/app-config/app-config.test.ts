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
const OPTIONAL_ENV_KEYS = [
  'REDIS_URL',
  'NODE_INSTANCE_ID',
  'DEMO_ROOM_ENABLED',
  'DEMO_SESSION_UID',
];
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

  describe('demo room configuration', (it) => {
    it('is enabled with the default session uid when unset', () => {
      // Act - both vars are absent; the demo room is on by default.
      const config = new AppConfig(NO_DOTENV_FILE);

      // Assert
      expect(config.demoRoomConfig).toStrictEqual({
        enabled: true,
        sessionUid: 'deadbeef-0000-4000-8000-000000000001',
      });
    });

    it('can be turned off with DEMO_ROOM_ENABLED=false', () => {
      // Arrange
      process.env['DEMO_ROOM_ENABLED'] = 'false';

      // Act
      const config = new AppConfig(NO_DOTENV_FILE);

      // Assert
      expect(config.demoRoomConfig).toStrictEqual({
        enabled: false,
        sessionUid: 'deadbeef-0000-4000-8000-000000000001',
      });
    });

    it('maps an explicit enable flag and session uid', () => {
      // Arrange
      process.env['DEMO_ROOM_ENABLED'] = 'true';
      process.env['DEMO_SESSION_UID'] = 'aaaaaaaa-0000-4000-8000-000000000002';

      // Act
      const config = new AppConfig(NO_DOTENV_FILE);

      // Assert
      expect(config.demoRoomConfig).toStrictEqual({
        enabled: true,
        sessionUid: 'aaaaaaaa-0000-4000-8000-000000000002',
      });
    });

    it('rejects a non-boolean enable flag (only true/false are accepted)', () => {
      // Arrange - env-schema coerces "true"/"false" but not "1".
      process.env['DEMO_ROOM_ENABLED'] = '1';

      // Act / Assert
      expect(() => new AppConfig(NO_DOTENV_FILE)).toThrow();
    });
  });

  describe('secret placeholders (PLAN-ConfigCheck-Coverage Phase 2)', (it) => {
    it('reports every secret as not-a-placeholder for a fully-populated environment', () => {
      // Act
      const config = new AppConfig(NO_DOTENV_FILE);

      // Assert
      expect(config.secretPlaceholders).toStrictEqual({
        sessionTokenSigningKeyIsPlaceholder: false,
        sessionManagerServiceApiKeyIsPlaceholder: false,
        nodeServerServiceApiKeyIsPlaceholder: false,
        transcriptionServiceApiKeyIsPlaceholder: false,
      });
    });

    it('flags only the secret that is still CHANGEME, matching case-insensitively', () => {
      // Arrange - the deployment/.env.example marker embedded in an otherwise
      // real-looking value, same as config-check.service.ts's own tests on
      // the Admin Server exercise for its own secrets.
      process.env['TRANSCRIPTION_SERVICE_API_KEY'] = 'changeme';

      // Act
      const config = new AppConfig(NO_DOTENV_FILE);

      // Assert - never the value itself, only the classification.
      expect(config.secretPlaceholders).toStrictEqual({
        sessionTokenSigningKeyIsPlaceholder: false,
        sessionManagerServiceApiKeyIsPlaceholder: false,
        nodeServerServiceApiKeyIsPlaceholder: false,
        transcriptionServiceApiKeyIsPlaceholder: true,
      });
    });

    it('flags a secret whose value only contains the marker as a substring', () => {
      // Arrange
      process.env['SESSION_TOKEN_SIGNING_KEY'] = 'prefix-CHANGEME-suffix';

      // Act
      const config = new AppConfig(NO_DOTENV_FILE);

      // Assert
      expect(
        config.secretPlaceholders.sessionTokenSigningKeyIsPlaceholder,
      ).toBe(true);
    });

    // Regression test: `isPlaceholder('')` used to be false, so an operator
    // who never set a secret (rather than leaving the .env.example CHANGEME
    // stub in place) self-reported as fine on Config Check. None of these four
    // secrets has a fallback for "unset" that would make it a different
    // situation from "still the stub" - each is used directly, so empty is
    // exactly as guessable and shares the same remediation.
    it('flags a secret that is empty, not just one that still reads CHANGEME', () => {
      // Arrange - env-schema requires these to be present but does not
      // enforce a minimum length, so an empty string is a valid, bootable
      // configuration; this is the state an .env with the line present but
      // no value (or COMPOSE_PROFILES substituting a blank) produces.
      process.env['SESSION_MANAGER_SERVICE_API_KEY'] = '';

      // Act
      const config = new AppConfig(NO_DOTENV_FILE);

      // Assert
      expect(config.secretPlaceholders).toStrictEqual({
        sessionTokenSigningKeyIsPlaceholder: false,
        sessionManagerServiceApiKeyIsPlaceholder: true,
        nodeServerServiceApiKeyIsPlaceholder: false,
        transcriptionServiceApiKeyIsPlaceholder: false,
      });
    });

    it('flags a placeholder regardless of case', () => {
      // Arrange - env-schema does not normalize case, so an operator who
      // typed the stub in lowercase or mixed case must still be caught.
      process.env['NODE_SERVER_SERVICE_API_KEY'] = 'ChangeMe';

      // Act
      const config = new AppConfig(NO_DOTENV_FILE);

      // Assert
      expect(
        config.secretPlaceholders.nodeServerServiceApiKeyIsPlaceholder,
      ).toBe(true);
    });

    it('does not flag whitespace-only as a placeholder', () => {
      // Arrange - a real (if odd) high-entropy-looking value is not this
      // check's job to reject; whitespace-only is neither empty nor CHANGEME,
      // so it is deliberately left alone here, the same restraint
      // `isPlaceholderSecret` already applies (equality/substring only, no
      // trimming or strength rule).
      process.env['TRANSCRIPTION_SERVICE_API_KEY'] = '   ';

      // Act
      const config = new AppConfig(NO_DOTENV_FILE);

      // Assert
      expect(
        config.secretPlaceholders.transcriptionServiceApiKeyIsPlaceholder,
      ).toBe(false);
    });

    it('does not flag a healthy, real-looking secret', () => {
      // Act - VALID_ENV's secrets are already real-looking; this test just
      // makes the "healthy" case explicit rather than leaving it implied by
      // the fully-populated-environment test above.
      const config = new AppConfig(NO_DOTENV_FILE);

      // Assert
      expect(
        config.secretPlaceholders.sessionManagerServiceApiKeyIsPlaceholder,
      ).toBe(false);
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
