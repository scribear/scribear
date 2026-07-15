import { type Mock, describe, expect, vi } from 'vitest';

import { csrfHook } from '#src/server/shared/hooks/csrf.hook.js';

function makeReply() {
  return {
    code: vi.fn().mockReturnThis(),
    send: vi.fn().mockReturnThis(),
  };
}

function makeRequest(overrides: {
  verifyCsrf?: Mock;
  adminSession?: object | undefined;
  csrfToken?: string;
}) {
  const verifyCsrf = overrides.verifyCsrf ?? vi.fn();
  return {
    diScope: {
      resolve: vi.fn().mockReturnValue({ verifyCsrf }),
    },
    adminSession: overrides.adminSession,
    headers: { 'x-csrf-token': overrides.csrfToken },
    id: 'r1',
  };
}

describe('csrfHook', () => {
  describe('the presented token matches the session', (it) => {
    it('does not reject the request', async () => {
      // Arrange
      const verifyCsrf = vi.fn().mockReturnValue(true);
      const req = makeRequest({
        verifyCsrf,
        adminSession: { csrfToken: 'tok' },
        csrfToken: 'tok',
      });
      const reply = makeReply();

      // Act
      await csrfHook(req as never, reply as never);

      // Assert
      expect(reply.code).not.toHaveBeenCalled();
      expect(reply.send).not.toHaveBeenCalled();
    });
  });

  describe('the presented token does not match the session', (it) => {
    it('replies 403 CSRF_TOKEN_INVALID', async () => {
      // Arrange
      const verifyCsrf = vi.fn().mockReturnValue(false);
      const req = makeRequest({
        verifyCsrf,
        adminSession: { csrfToken: 'tok' },
        csrfToken: 'wrong',
      });
      const reply = makeReply();

      // Act
      await csrfHook(req as never, reply as never);

      // Assert
      expect(reply.code).toHaveBeenCalledWith(403);
      expect(reply.send).toHaveBeenCalledWith(
        expect.objectContaining({
          ok: false,
          error: expect.objectContaining({ code: 'CSRF_TOKEN_INVALID' }),
        }),
      );
    });
  });

  describe('there is no adminSession', (it) => {
    it('replies 403 CSRF_TOKEN_INVALID', async () => {
      // Arrange
      const req = makeRequest({ adminSession: undefined, csrfToken: 'tok' });
      const reply = makeReply();

      // Act
      await csrfHook(req as never, reply as never);

      // Assert
      expect(reply.code).toHaveBeenCalledWith(403);
      expect(reply.send).toHaveBeenCalledWith(
        expect.objectContaining({
          ok: false,
          error: expect.objectContaining({ code: 'CSRF_TOKEN_INVALID' }),
        }),
      );
    });
  });
});
