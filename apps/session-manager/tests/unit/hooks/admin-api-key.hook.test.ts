import { type Mock, beforeEach, describe, expect, vi } from 'vitest';

import { adminApiKeyHook } from '#src/server/hooks/admin-api-key.hook.js';

function makeRequest(overrides: {
  authorization?: string;
  adminAuthService?: { isValid: Mock };
}) {
  const adminAuthService = overrides.adminAuthService ?? { isValid: vi.fn() };
  return {
    headers: { authorization: overrides.authorization },
    diScope: {
      resolve: vi.fn(() => adminAuthService),
    },
  } as never;
}

const makeReply = () => ({}) as never;

describe('adminApiKeyHook', () => {
  let done: Mock;

  beforeEach(() => {
    done = vi.fn();
  });

  describe('invalid key', (it) => {
    it('calls done with an unauthorized error when isValid returns false', () => {
      // Arrange
      const isValid = vi.fn().mockReturnValue(false);
      const req = makeRequest({
        authorization: 'Bearer wrong-key',
        adminAuthService: { isValid },
      });

      // Act
      adminApiKeyHook(req, makeReply(), done);

      // Assert
      expect(done).toHaveBeenCalledWith(
        expect.objectContaining({
          statusCode: 401,
          message: 'Invalid or missing admin API key.',
        }),
      );
    });

    it('calls done with an unauthorized error when authorization header is absent', () => {
      // Arrange
      const isValid = vi.fn().mockReturnValue(false);
      const req = makeRequest({
        adminAuthService: { isValid },
      });

      // Act
      adminApiKeyHook(req, makeReply(), done);

      // Assert
      expect(done).toHaveBeenCalledWith(
        expect.objectContaining({ statusCode: 401 }),
      );
    });
  });

  describe('valid key', (it) => {
    it('calls done with no error when isValid returns true', () => {
      // Arrange
      const isValid = vi.fn().mockReturnValue(true);
      const req = makeRequest({
        authorization: 'Bearer correct-key',
        adminAuthService: { isValid },
      });

      // Act
      adminApiKeyHook(req, makeReply(), done);

      // Assert
      expect(done).toHaveBeenCalledWith();
    });

    it('passes the authorization header value to isValid', () => {
      // Arrange
      const isValid = vi.fn().mockReturnValue(true);
      const req = makeRequest({
        authorization: 'Bearer my-key',
        adminAuthService: { isValid },
      });

      // Act
      adminApiKeyHook(req, makeReply(), done);

      // Assert
      expect(isValid).toHaveBeenCalledWith('Bearer my-key');
    });
  });
});
