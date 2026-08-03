import { describe, expect, vi } from 'vitest';

import { requireRole } from '#src/server/shared/hooks/require-role.hook.js';
import type { Identity } from '#src/server/shared/types/identity.js';

function makeReply() {
  return {
    code: vi.fn().mockReturnThis(),
    send: vi.fn().mockReturnThis(),
  };
}

function makeRequest(adminIdentity?: Identity) {
  return { adminIdentity, id: 'r1' };
}

describe('requireRole', () => {
  describe('caller holds the required role', (it) => {
    it('does not reject the request', async () => {
      // Arrange
      const identity: Identity = {
        subject: 'u',
        displayName: 'u',
        provider: 'local',
        roles: ['read-write'],
      };
      const req = makeRequest(identity);
      const reply = makeReply();
      const hook = requireRole('read-write');

      // Act
      await hook(req as never, reply as never);

      // Assert
      expect(reply.code).not.toHaveBeenCalled();
      expect(reply.send).not.toHaveBeenCalled();
    });
  });

  describe('caller lacks the required role', (it) => {
    it('replies 403 FORBIDDEN', async () => {
      // Arrange
      const identity: Identity = {
        subject: 'u',
        displayName: 'u',
        provider: 'local',
        roles: ['read-only'],
      };
      const req = makeRequest(identity);
      const reply = makeReply();
      const hook = requireRole('read-write');

      // Act
      await hook(req as never, reply as never);

      // Assert
      expect(reply.code).toHaveBeenCalledWith(403);
      expect(reply.send).toHaveBeenCalledWith(
        expect.objectContaining({
          ok: false,
          error: expect.objectContaining({ code: 'FORBIDDEN' }),
        }),
      );
    });
  });

  describe('caller has no adminIdentity', (it) => {
    it('replies 403 FORBIDDEN', async () => {
      // Arrange
      const req = makeRequest(undefined);
      const reply = makeReply();
      const hook = requireRole('read-write');

      // Act
      await hook(req as never, reply as never);

      // Assert
      expect(reply.code).toHaveBeenCalledWith(403);
      expect(reply.send).toHaveBeenCalledWith(
        expect.objectContaining({
          ok: false,
          error: expect.objectContaining({ code: 'FORBIDDEN' }),
        }),
      );
    });
  });
});
