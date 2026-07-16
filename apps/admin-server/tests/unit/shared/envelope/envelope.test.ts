import { describe, expect } from 'vitest';

import {
  errorEnvelope,
  okEnvelope,
} from '#src/server/shared/envelope/envelope.js';

describe('envelope', () => {
  describe('okEnvelope', (it) => {
    it('wraps data in an ok envelope', () => {
      // Arrange / Act
      const result = okEnvelope({ x: 1 });

      // Assert
      expect(result).toStrictEqual({ ok: true, data: { x: 1 } });
    });
  });

  describe('errorEnvelope', (it) => {
    it('builds an error envelope with no details key when details is omitted', () => {
      // Arrange / Act
      const result = errorEnvelope('CODE', 'msg', 'req-1');

      // Assert
      expect(result).toStrictEqual({
        ok: false,
        error: { code: 'CODE', message: 'msg', requestId: 'req-1' },
      });
      expect('details' in result.error).toBe(false);
    });

    it('includes details when provided', () => {
      // Arrange / Act
      const result = errorEnvelope('C', 'm', 'r', { a: 1 });

      // Assert
      expect(result).toStrictEqual({
        ok: false,
        error: { code: 'C', message: 'm', requestId: 'r', details: { a: 1 } },
      });
    });
  });
});
