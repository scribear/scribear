import { describe, expect } from 'vitest';

import {
  ServiceAuthService,
  assertUsableServiceKey,
} from '#src/server/shared/auth/service-auth.service.js';

/**
 * The inbound key guarding every control route.
 *
 * This is the only thing between a caller on the backend network and the
 * ability to point a synthetic audio source at a live room, so the interesting
 * cases are the ones where it fails *open*.
 */
describe('ServiceAuthService', () => {
  describe('an unusable key', (it) => {
    it('refuses to construct on an empty key', () => {
      // Arrange — compose substitutes a blank string for an unset variable, so
      // an .env predating this service arrives here as empty.
      // Act + Assert — an empty configured key matches the empty credential an
      // unauthenticated caller presents as `Authorization: Bearer `, which is
      // an auth bypass rather than a closed door.
      expect(() => new ServiceAuthService({ serviceKey: '' })).toThrow(
        /empty credential/,
      );
    });

    it('refuses to construct on the .env.example placeholder', () => {
      // Act + Assert
      expect(
        () => new ServiceAuthService({ serviceKey: 'CHANGEME-test-audio-key' }),
      ).toThrow(/placeholder/);
      expect(() => {
        assertUsableServiceKey('changeme');
      }).toThrow(/placeholder/);
    });
  });

  describe('validation', (it) => {
    const auth = new ServiceAuthService({
      serviceKey: 'a-real-high-entropy-key',
    });

    it('accepts exactly the configured bearer token', () => {
      // Assert
      expect(auth.isValid('Bearer a-real-high-entropy-key')).toBe(true);
    });

    it('rejects a missing, empty, wrong or unprefixed credential', () => {
      // Assert — `Bearer ` with nothing after it is the shape an empty
      // configured key would have admitted, so it is checked explicitly.
      expect(auth.isValid(undefined)).toBe(false);
      expect(auth.isValid('')).toBe(false);
      expect(auth.isValid('Bearer ')).toBe(false);
      expect(auth.isValid('Bearer wrong')).toBe(false);
      expect(auth.isValid('a-real-high-entropy-key')).toBe(false);
      expect(auth.isValid('bearer a-real-high-entropy-key')).toBe(false);
    });

    it('rejects a prefix of the key, which a length-only comparison would not', () => {
      // Assert
      expect(auth.isValid('Bearer a-real-high-entropy-ke')).toBe(false);
      expect(auth.isValid('Bearer a-real-high-entropy-keys')).toBe(false);
    });
  });
});
