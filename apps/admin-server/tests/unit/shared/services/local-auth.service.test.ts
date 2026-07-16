import { describe, expect } from 'vitest';

import { LocalAuthService } from '#src/server/shared/services/local-auth.service.js';
import { createMockLogger } from '#tests/utils/mock-logger.js';

describe('LocalAuthService', () => {
  describe('with valid credentials containing a password with spaces', (it) => {
    it('is enabled', () => {
      // Arrange
      const logger = createMockLogger();
      const service = new LocalAuthService(logger as never, {
        credentials: 'engrit super secret pw!',
      });

      // Act
      const result = service.isEnabled();

      // Assert
      expect(result).toBe(true);
    });

    it('verifies the username and full (multi-word) password, splitting on the first space only', () => {
      // Arrange
      const logger = createMockLogger();
      const service = new LocalAuthService(logger as never, {
        credentials: 'engrit super secret pw!',
      });

      // Act
      const result = service.verify('engrit', 'super secret pw!');

      // Assert
      expect(result).toStrictEqual({
        subject: 'engrit',
        displayName: 'engrit',
        provider: 'local',
        roles: ['read-write'],
      });
    });

    it('returns null for a wrong password', () => {
      // Arrange
      const logger = createMockLogger();
      const service = new LocalAuthService(logger as never, {
        credentials: 'engrit super secret pw!',
      });

      // Act
      const result = service.verify('engrit', 'wrong');

      // Assert
      expect(result).toBeNull();
    });

    it('returns null for a wrong username', () => {
      // Arrange
      const logger = createMockLogger();
      const service = new LocalAuthService(logger as never, {
        credentials: 'engrit super secret pw!',
      });

      // Act
      const result = service.verify('wronguser', 'super secret pw!');

      // Assert
      expect(result).toBeNull();
    });

    it('returns null for an empty password', () => {
      // Arrange
      const logger = createMockLogger();
      const service = new LocalAuthService(logger as never, {
        credentials: 'engrit super secret pw!',
      });

      // Act
      const result = service.verify('engrit', '');

      // Assert
      expect(result).toBeNull();
    });
  });

  describe('with empty credentials', (it) => {
    it('is disabled', () => {
      // Arrange
      const logger = createMockLogger();
      const service = new LocalAuthService(logger as never, {
        credentials: '',
      });

      // Act
      const result = service.isEnabled();

      // Assert
      expect(result).toBe(false);
    });

    it('verify returns null for any input', () => {
      // Arrange
      const logger = createMockLogger();
      const service = new LocalAuthService(logger as never, {
        credentials: '',
      });

      // Act
      const result = service.verify('anything', 'anything');

      // Assert
      expect(result).toBeNull();
    });
  });

  describe('with whitespace-only credentials', (it) => {
    it('is disabled', () => {
      // Arrange
      const logger = createMockLogger();
      const service = new LocalAuthService(logger as never, {
        credentials: '   ',
      });

      // Act
      const result = service.isEnabled();

      // Assert
      expect(result).toBe(false);
    });
  });

  describe('with credentials missing a space (no password)', (it) => {
    it('is disabled and logs a warning', () => {
      // Arrange
      const logger = createMockLogger();

      // Act
      const service = new LocalAuthService(logger as never, {
        credentials: 'nopassword',
      });

      // Assert
      expect(service.isEnabled()).toBe(false);
      expect(logger.warn).toHaveBeenCalled();
    });
  });

  describe('with credentials that have a leading space (empty username)', (it) => {
    it('is disabled', () => {
      // Arrange
      const logger = createMockLogger();
      const service = new LocalAuthService(logger as never, {
        credentials: ' leadingspace pw',
      });

      // Act
      const result = service.isEnabled();

      // Assert
      expect(result).toBe(false);
    });
  });
});
