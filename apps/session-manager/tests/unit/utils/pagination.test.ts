import { describe, expect } from 'vitest';

import {
  decodeCursor,
  encodeCursor,
} from '#src/server/utils/pagination.js';

describe('pagination', () => {
  describe('encodeCursor / decodeCursor', (it) => {
    it('round-trips a date and uid', () => {
      // Arrange
      const createdAt = new Date('2024-01-15T10:30:00.000Z');
      const uid = 'abc-123';

      // Act
      const cursor = encodeCursor(createdAt, uid);
      const decoded = decodeCursor(cursor);

      // Assert
      expect(decoded).toStrictEqual({
        createdAt: createdAt.toISOString(),
        uid,
      });
    });

    it('produces a base64url-encoded string', () => {
      // Arrange / Act
      const cursor = encodeCursor(new Date(), 'some-uid');

      // Assert - base64url uses only [A-Za-z0-9_-] characters
      expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    });
  });

  describe('decodeCursor', (it) => {
    it('returns null for an empty string', () => {
      // Arrange / Act
      const result = decodeCursor('');

      // Assert
      expect(result).toBeNull();
    });

    it('returns null for non-base64 input', () => {
      // Arrange / Act
      const result = decodeCursor('not-valid-base64!!!');

      // Assert
      expect(result).toBeNull();
    });

    it('returns null when the decoded JSON is missing required fields', () => {
      // Arrange - valid base64url but missing uid
      const cursor = Buffer.from(JSON.stringify({ createdAt: '2024-01-15T10:30:00.000Z' })).toString('base64url');

      // Act
      const result = decodeCursor(cursor);

      // Assert
      expect(result).toBeNull();
    });

    it('returns null when the decoded value is not an object', () => {
      // Arrange
      const cursor = Buffer.from(JSON.stringify(42)).toString('base64url');

      // Act
      const result = decodeCursor(cursor);

      // Assert
      expect(result).toBeNull();
    });
  });
});
