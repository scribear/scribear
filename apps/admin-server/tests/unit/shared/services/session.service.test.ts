import { afterEach, beforeEach, describe, expect, vi } from 'vitest';

import { SessionService } from '#src/server/shared/services/session.service.js';
import type { Identity } from '#src/server/shared/types/identity.js';

const IDENTITY: Identity = {
  subject: 'u',
  displayName: 'u',
  provider: 'local',
  roles: ['read-write'],
};

describe('SessionService', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  describe('create', (it) => {
    it('returns a non-empty sessionId and csrfToken that differ from each other', () => {
      // Arrange
      const service = new SessionService({
        secure: true,
        idleTimeoutMs: 10_000,
        absoluteTimeoutMs: 100_000,
      });

      // Act
      const { sessionId, csrfToken } = service.create(IDENTITY);

      // Assert
      expect(typeof sessionId).toBe('string');
      expect(sessionId.length).toBeGreaterThan(0);
      expect(typeof csrfToken).toBe('string');
      expect(csrfToken.length).toBeGreaterThan(0);
      expect(sessionId).not.toBe(csrfToken);
    });
  });

  describe('validate', (it) => {
    it('returns a record whose identity matches the one used to create the session', () => {
      // Arrange
      const service = new SessionService({
        secure: true,
        idleTimeoutMs: 10_000,
        absoluteTimeoutMs: 100_000,
      });
      const { sessionId } = service.create(IDENTITY);

      // Act
      const record = service.validate(sessionId);

      // Assert
      expect(record?.identity).toStrictEqual(IDENTITY);
    });

    it('returns null for an unknown sessionId', () => {
      // Arrange
      const service = new SessionService({
        secure: true,
        idleTimeoutMs: 10_000,
        absoluteTimeoutMs: 100_000,
      });

      // Act
      const record = service.validate('unknown');

      // Assert
      expect(record).toBeNull();
    });

    it('returns null for an undefined sessionId', () => {
      // Arrange
      const service = new SessionService({
        secure: true,
        idleTimeoutMs: 10_000,
        absoluteTimeoutMs: 100_000,
      });

      // Act
      const record = service.validate(undefined);

      // Assert
      expect(record).toBeNull();
    });
  });

  describe('idle expiry', (it) => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(0);
    });

    it('returns null once the idle timeout has elapsed with no activity', () => {
      // Arrange
      const service = new SessionService({
        secure: true,
        idleTimeoutMs: 1_000,
        absoluteTimeoutMs: 100_000,
      });
      const { sessionId } = service.create(IDENTITY);

      // Act
      vi.advanceTimersByTime(1_001);
      const record = service.validate(sessionId);

      // Assert
      expect(record).toBeNull();
    });
  });

  describe('absolute expiry', (it) => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(0);
    });

    it('returns null past the absolute timeout even with continued activity that slides the idle window', () => {
      // Arrange
      const service = new SessionService({
        secure: true,
        idleTimeoutMs: 1_000,
        absoluteTimeoutMs: 3_000,
      });
      const { sessionId } = service.create(IDENTITY);

      // Act
      // Repeatedly validate at intervals shorter than idleTimeoutMs, sliding the
      // idle window forward, until we cross absoluteTimeoutMs.
      vi.advanceTimersByTime(900);
      expect(service.validate(sessionId)).not.toBeNull();
      vi.advanceTimersByTime(900);
      expect(service.validate(sessionId)).not.toBeNull();
      vi.advanceTimersByTime(900);
      expect(service.validate(sessionId)).not.toBeNull();
      vi.advanceTimersByTime(900);
      const record = service.validate(sessionId);

      // Assert
      expect(record).toBeNull();
    });
  });

  describe('verifyCsrf', (it) => {
    it('returns true for the record own csrfToken', () => {
      // Arrange
      const service = new SessionService({
        secure: true,
        idleTimeoutMs: 10_000,
        absoluteTimeoutMs: 100_000,
      });
      const { sessionId, csrfToken } = service.create(IDENTITY);
      const record = service.validate(sessionId);

      // Act
      const result = service.verifyCsrf(record!, csrfToken);

      // Assert
      expect(result).toBe(true);
    });

    it('returns false for a wrong token of the same length', () => {
      // Arrange
      const service = new SessionService({
        secure: true,
        idleTimeoutMs: 10_000,
        absoluteTimeoutMs: 100_000,
      });
      const { sessionId, csrfToken } = service.create(IDENTITY);
      const record = service.validate(sessionId);
      const wrongToken =
        csrfToken.slice(0, -1) + (csrfToken.at(-1) === 'a' ? 'b' : 'a');

      // Act
      const result = service.verifyCsrf(record!, wrongToken);

      // Assert
      expect(result).toBe(false);
    });

    it('returns false for undefined', () => {
      // Arrange
      const service = new SessionService({
        secure: true,
        idleTimeoutMs: 10_000,
        absoluteTimeoutMs: 100_000,
      });
      const { sessionId } = service.create(IDENTITY);
      const record = service.validate(sessionId);

      // Act
      const result = service.verifyCsrf(record!, undefined);

      // Assert
      expect(result).toBe(false);
    });

    it('returns false for a token of a different length', () => {
      // Arrange
      const service = new SessionService({
        secure: true,
        idleTimeoutMs: 10_000,
        absoluteTimeoutMs: 100_000,
      });
      const { sessionId, csrfToken } = service.create(IDENTITY);
      const record = service.validate(sessionId);

      // Act
      const result = service.verifyCsrf(record!, csrfToken + 'x');

      // Assert
      expect(result).toBe(false);
    });
  });

  describe('destroy', (it) => {
    it('removes the session so subsequent validate calls return null', () => {
      // Arrange
      const service = new SessionService({
        secure: true,
        idleTimeoutMs: 10_000,
        absoluteTimeoutMs: 100_000,
      });
      const { sessionId } = service.create(IDENTITY);

      // Act
      service.destroy(sessionId);
      const record = service.validate(sessionId);

      // Assert
      expect(record).toBeNull();
    });

    it('decrements activeCount', () => {
      // Arrange
      const service = new SessionService({
        secure: true,
        idleTimeoutMs: 10_000,
        absoluteTimeoutMs: 100_000,
      });
      const { sessionId } = service.create(IDENTITY);
      const before = service.activeCount;

      // Act
      service.destroy(sessionId);

      // Assert
      expect(before).toBe(1);
      expect(service.activeCount).toBe(0);
    });
  });
});
