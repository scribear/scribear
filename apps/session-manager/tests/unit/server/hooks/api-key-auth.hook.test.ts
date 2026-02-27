import { type Mock, beforeEach, describe, expect, vi } from 'vitest';

import { HttpError } from '@scribear/base-fastify-server';

import { apiKeyAuthHook } from '#src/server/hooks/api-key-auth.hook.js';

describe('apiKeyAuthHook', (it) => {
  const TEST_AUTH_HEADER = 'Bearer TEST_API_KEY';

  let mockAuthService: { isValidApiKey: Mock };
  let mockReq: { headers: { authorization: string | undefined }; diScope: { resolve: Mock } };
  let mockRes: object;

  beforeEach(() => {
    mockAuthService = { isValidApiKey: vi.fn() };
    mockReq = {
      headers: { authorization: TEST_AUTH_HEADER },
      diScope: { resolve: vi.fn().mockReturnValue(mockAuthService) },
    };
    mockRes = {};
  });

  it('does not throw when API key is valid', async () => {
    // Arrange
    mockAuthService.isValidApiKey.mockReturnValue(true);

    // Act / Assert
    await expect(
      apiKeyAuthHook(mockReq as never, mockRes as never),
    ).resolves.toBeUndefined();
    expect(mockAuthService.isValidApiKey).toHaveBeenCalledExactlyOnceWith(
      TEST_AUTH_HEADER,
    );
  });

  it('throws Unauthorized when API key is invalid', async () => {
    // Arrange
    mockAuthService.isValidApiKey.mockReturnValue(false);

    // Act / Assert
    await expect(
      apiKeyAuthHook(mockReq as never, mockRes as never),
    ).rejects.toThrow(HttpError.Unauthorized);
  });

  it('throws Unauthorized when authorization header is missing', async () => {
    // Arrange
    mockReq.headers.authorization = undefined;
    mockAuthService.isValidApiKey.mockReturnValue(false);

    // Act / Assert
    await expect(
      apiKeyAuthHook(mockReq as never, mockRes as never),
    ).rejects.toThrow(HttpError.Unauthorized);
  });
});
