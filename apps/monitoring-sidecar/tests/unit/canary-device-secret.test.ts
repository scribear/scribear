import { afterEach, beforeEach, describe, expect } from 'vitest';

import { CANARY_DEVICE_UID } from '@scribear/session-manager-schema';
import { deriveTestAudioDeviceToken } from '@scribear/session-manager-schema/test-audio';

import { AppConfig } from '#src/app-config/app-config.js';

/**
 * The sidecar half of the seeded canary credential.
 *
 * `CANARY_DEVICE_SECRET` replaced `CANARY_DEVICE_TOKEN`, which an operator
 * produced by hand from a `Set-Cookie` header. The token this service presents
 * is now *derived*, and the Session Manager stores `bcrypt` of the same
 * derivation over the same two inputs — so the only way the two can disagree is
 * if this side computes something other than
 * `deriveTestAudioDeviceToken(secret, CANARY_DEVICE_UID)`. That is what these
 * assert, in the one place where the sidecar chooses those inputs.
 *
 * The end-to-end proof that the two halves agree lives in session-manager's
 * `canary-room-seeder.test.ts`, which presents this exact value to a real
 * server and expects 200.
 */

const REQUIRED_ENV = {
  LOG_LEVEL: 'silent',
  PORT: '0',
  HOST: '127.0.0.1',
};

describe('canary device credential', () => {
  let saved: NodeJS.ProcessEnv;

  beforeEach(() => {
    saved = { ...process.env };
    Object.assign(process.env, REQUIRED_ENV);
    delete process.env['CANARY_DEVICE_SECRET'];
  });

  afterEach(() => {
    process.env = saved;
  });

  describe('with a secret configured', (it) => {
    it('derives the device token from the secret and the reserved canary uid', () => {
      // Arrange
      process.env['CANARY_DEVICE_SECRET'] = 'a-canary-secret';

      // Act
      const config = new AppConfig();

      // Assert - not merely "some non-empty string": the exact value the
      // Session Manager hashed. Anything else authenticates as nothing.
      expect(config.deviceAuthConfig.deviceToken).toBe(
        deriveTestAudioDeviceToken('a-canary-secret', CANARY_DEVICE_UID),
      );
      expect(config.canaryRunnerConfig('').enabled).toBe(true);
    });

    it('produces a different token for a different secret', () => {
      // Arrange - the negative half. A derivation that ignored its key would
      // pass the assertion above only by coincidence, and would make rotation
      // silently do nothing.
      process.env['CANARY_DEVICE_SECRET'] = 'first-secret';
      const first = new AppConfig().deviceAuthConfig.deviceToken;
      process.env['CANARY_DEVICE_SECRET'] = 'second-secret';

      // Act
      const second = new AppConfig().deviceAuthConfig.deviceToken;

      // Assert
      expect(second).not.toBe(first);
    });
  });

  describe('with no secret configured', (it) => {
    it('leaves the token empty and the canary disabled', () => {
      // Arrange / Act - the inert default. With no secret the Session Manager
      // seeded no canary room, device or session, so a well-formed token here
      // could only ever fail to authenticate; failing closed keeps the sidecar
      // from emitting auth errors against session-manager forever.
      const config = new AppConfig();

      // Assert
      expect(config.deviceAuthConfig.deviceToken).toBe('');
      expect(config.canaryRunnerConfig('').enabled).toBe(false);
    });
  });
});
