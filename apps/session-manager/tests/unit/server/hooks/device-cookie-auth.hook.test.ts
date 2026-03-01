import { type Mock, beforeEach, describe, expect, vi } from 'vitest';

import { HttpError } from '@scribear/base-fastify-server';
import { DEVICE_COOKIE_NAME } from '@scribear/session-manager-schema';

import { deviceCookieAuthHook } from '#src/server/hooks/device-cookie-auth.hook.js';

const TEST_DEVICE_ID = 'test-device-id';
const TEST_TOKEN = `${TEST_DEVICE_ID}:secret-token`;

describe('deviceCookieAuthHook', (it) => {
  let mockAuthService: { verifyDeviceToken: Mock };
  let mockReq: {
    cookies: Record<string, string | undefined>;
    diScope: { resolve: Mock };
    deviceId: string | undefined;
  };

  beforeEach(() => {
    mockAuthService = { verifyDeviceToken: vi.fn() };
    mockReq = {
      cookies: { [DEVICE_COOKIE_NAME]: TEST_TOKEN },
      diScope: { resolve: vi.fn().mockReturnValue(mockAuthService) },
      deviceId: undefined,
    };
  });

  it('sets req.deviceId when token is valid', async () => {
    // Arrange
    mockAuthService.verifyDeviceToken.mockResolvedValue({
      deviceId: TEST_DEVICE_ID,
    });

    // Act
    await deviceCookieAuthHook(mockReq as never, {} as never);

    // Assert
    expect(mockAuthService.verifyDeviceToken).toHaveBeenCalledExactlyOnceWith(
      TEST_TOKEN,
    );
    expect(mockReq.deviceId).toBe(TEST_DEVICE_ID);
  });

  it('throws Unauthorized when cookie is missing', async () => {
    // Arrange
    mockReq.cookies = {};

    // Act / Assert
    await expect(
      deviceCookieAuthHook(mockReq as never, {} as never),
    ).rejects.toThrow(HttpError.Unauthorized);
    expect(mockAuthService.verifyDeviceToken).not.toHaveBeenCalled();
  });

  it('throws Unauthorized when token verification fails', async () => {
    // Arrange
    mockAuthService.verifyDeviceToken.mockResolvedValue(null);

    // Act / Assert
    await expect(
      deviceCookieAuthHook(mockReq as never, {} as never),
    ).rejects.toThrow(HttpError.Unauthorized);
  });
});
