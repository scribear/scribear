import { type Mock, beforeEach, describe, expect, vi } from 'vitest';

import { HttpError } from '@scribear/base-fastify-server';
import { DEVICE_TOKEN_COOKIE_NAME } from '@scribear/session-manager-schema';

import { deviceTokenHook } from '#src/server/hooks/device-token.hook.js';

function makeRequest(overrides: {
  token?: string;
  deviceAuthService?: { verify: Mock };
  baseConfig?: { isDevelopment: boolean };
}) {
  const deviceAuthService = overrides.deviceAuthService ?? { verify: vi.fn() };
  const baseConfig = overrides.baseConfig ?? { isDevelopment: false };
  return {
    cookies: { [DEVICE_TOKEN_COOKIE_NAME]: overrides.token },
    diScope: {
      resolve: vi.fn((name: string) => {
        if (name === 'deviceAuthService') return deviceAuthService;
        if (name === 'baseConfig') return baseConfig;
        return;
      }),
    },
  } as never;
}

function makeReply() {
  return { setCookie: vi.fn() } as never;
}

describe('deviceTokenHook', () => {
  let done: Mock;

  beforeEach(() => {
    done = vi.fn();
  });

  describe('missing token', (it) => {
    it('calls done with an unauthorized error when the cookie is absent', () => {
      // Arrange
      const req = makeRequest({});
      const reply = makeReply();

      // Act
      deviceTokenHook(req, reply, done);

      // Assert
      expect(done).toHaveBeenCalledWith(
        expect.objectContaining({
          statusCode: 401,
          message: 'Missing device token.',
        }),
      );
    });
  });

  describe('token verification', (it) => {
    it('calls done with an unauthorized error when verify returns null', async () => {
      // Arrange
      const verify = vi.fn().mockResolvedValue(null);
      const req = makeRequest({
        token: 'bad-token',
        deviceAuthService: { verify },
      });
      const reply = makeReply();

      // Act
      deviceTokenHook(req, reply, done);
      await vi.waitFor(() => expect(done).toHaveBeenCalled());

      // Assert
      expect(done).toHaveBeenCalledWith(
        expect.objectContaining({
          statusCode: 401,
          message: 'Invalid or revoked device token.',
        }),
      );
    });

    it('calls done with the rejection error when verify rejects', async () => {
      // Arrange
      const error = new Error('db failure');
      const verify = vi.fn().mockRejectedValue(error);
      const req = makeRequest({
        token: 'some-token',
        deviceAuthService: { verify },
      });
      const reply = makeReply();

      // Act
      deviceTokenHook(req, reply, done);
      await vi.waitFor(() => expect(done).toHaveBeenCalled());

      // Assert
      expect(done).toHaveBeenCalledWith(error);
    });

    it('sets deviceUid on the request and calls done with no error when token is valid', async () => {
      // Arrange
      const verify = vi.fn().mockResolvedValue({ deviceUid: 'device-1' });
      const req = makeRequest({
        token: 'good-token',
        deviceAuthService: { verify },
      });
      const reply = makeReply();

      // Act
      deviceTokenHook(req, reply, done);
      await vi.waitFor(() => expect(done).toHaveBeenCalled());

      // Assert
      expect((req as { deviceUid?: string }).deviceUid).toBe('device-1');
      expect(done).toHaveBeenCalledWith();
    });

    it('refreshes the cookie with httpOnly and maxAge when token is valid', async () => {
      // Arrange
      const verify = vi.fn().mockResolvedValue({ deviceUid: 'device-1' });
      const req = makeRequest({
        token: 'good-token',
        deviceAuthService: { verify },
      });
      const reply = makeReply();

      // Act
      deviceTokenHook(req, reply, done);
      await vi.waitFor(() => expect(done).toHaveBeenCalled());

      // Assert
      expect((reply as { setCookie: Mock }).setCookie).toHaveBeenCalledWith(
        DEVICE_TOKEN_COOKIE_NAME,
        'good-token',
        expect.objectContaining({ httpOnly: true, maxAge: 60 * 60 * 24 * 365 }),
      );
    });

    it('sets secure: false in development', async () => {
      // Arrange
      const verify = vi.fn().mockResolvedValue({ deviceUid: 'device-1' });
      const req = makeRequest({
        token: 'good-token',
        deviceAuthService: { verify },
        baseConfig: { isDevelopment: true },
      });
      const reply = makeReply();

      // Act
      deviceTokenHook(req, reply, done);
      await vi.waitFor(() => expect(done).toHaveBeenCalled());

      // Assert
      expect((reply as { setCookie: Mock }).setCookie).toHaveBeenCalledWith(
        DEVICE_TOKEN_COOKIE_NAME,
        'good-token',
        expect.objectContaining({ secure: false }),
      );
    });

    it('sets secure: true in production', async () => {
      // Arrange
      const verify = vi.fn().mockResolvedValue({ deviceUid: 'device-1' });
      const req = makeRequest({
        token: 'good-token',
        deviceAuthService: { verify },
        baseConfig: { isDevelopment: false },
      });
      const reply = makeReply();

      // Act
      deviceTokenHook(req, reply, done);
      await vi.waitFor(() => expect(done).toHaveBeenCalled());

      // Assert
      expect((reply as { setCookie: Mock }).setCookie).toHaveBeenCalledWith(
        DEVICE_TOKEN_COOKIE_NAME,
        'good-token',
        expect.objectContaining({ secure: true }),
      );
    });
  });
});
