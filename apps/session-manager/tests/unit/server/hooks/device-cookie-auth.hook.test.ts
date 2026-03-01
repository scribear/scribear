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
  let mockDone: Mock;

  beforeEach(() => {
    mockAuthService = { verifyDeviceToken: vi.fn() };
    mockReq = {
      cookies: { [DEVICE_COOKIE_NAME]: TEST_TOKEN },
      diScope: { resolve: vi.fn().mockReturnValue(mockAuthService) },
      deviceId: undefined,
    };
    mockDone = vi.fn();
  });

  it('calls done with no error when token is valid', async () => {
    // Arrange
    const verifyPromise = Promise.resolve({ deviceId: TEST_DEVICE_ID });
    mockAuthService.verifyDeviceToken.mockReturnValue(verifyPromise);

    // Act
    deviceCookieAuthHook(mockReq as never, {} as never, mockDone);
    await verifyPromise;

    // Assert
    expect(mockAuthService.verifyDeviceToken).toHaveBeenCalledExactlyOnceWith(
      TEST_TOKEN,
    );
    expect(mockReq.deviceId).toBe(TEST_DEVICE_ID);
    expect(mockDone).toHaveBeenCalledExactlyOnceWith();
  });

  it('calls done with Unauthorized when cookie is missing', () => {
    // Arrange
    mockReq.cookies = {};

    // Act
    deviceCookieAuthHook(mockReq as never, {} as never, mockDone);

    // Assert
    expect(mockAuthService.verifyDeviceToken).not.toHaveBeenCalled();
    expect(mockDone).toHaveBeenCalledExactlyOnceWith(
      expect.any(HttpError.Unauthorized),
    );
  });

  it('calls done with Unauthorized when token verification fails', async () => {
    // Arrange
    const verifyPromise = Promise.resolve(null);
    mockAuthService.verifyDeviceToken.mockReturnValue(verifyPromise);

    // Act
    deviceCookieAuthHook(mockReq as never, {} as never, mockDone);
    await verifyPromise;

    // Assert
    expect(mockDone).toHaveBeenCalledExactlyOnceWith(
      expect.any(HttpError.Unauthorized),
    );
  });
});
