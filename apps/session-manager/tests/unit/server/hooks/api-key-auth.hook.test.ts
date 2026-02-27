import { type Mock, beforeEach, describe, expect, vi } from 'vitest';

import { HttpError } from '@scribear/base-fastify-server';

import { apiKeyAuthHook } from '#src/server/hooks/api-key-auth.hook.js';

describe('apiKeyAuthHook', (it) => {
  const TEST_AUTH_HEADER = 'Bearer TEST_API_KEY';

  let mockAuthService: { isValidApiKey: Mock };
  let mockReq: {
    headers: { authorization: string | undefined };
    diScope: { resolve: Mock };
  };
  let mockDone: Mock;

  beforeEach(() => {
    mockAuthService = { isValidApiKey: vi.fn() };
    mockReq = {
      headers: { authorization: TEST_AUTH_HEADER },
      diScope: { resolve: vi.fn().mockReturnValue(mockAuthService) },
    };
    mockDone = vi.fn();
  });

  it('calls done with no error when API key is valid', () => {
    // Arrange
    mockAuthService.isValidApiKey.mockReturnValue(true);

    // Act
    apiKeyAuthHook(mockReq as never, {} as never, mockDone);

    // Assert
    expect(mockDone).toHaveBeenCalledExactlyOnceWith();
    expect(mockAuthService.isValidApiKey).toHaveBeenCalledExactlyOnceWith(
      TEST_AUTH_HEADER,
    );
  });

  it('calls done with Unauthorized error when API key is invalid', () => {
    // Arrange
    mockAuthService.isValidApiKey.mockReturnValue(false);

    // Act
    apiKeyAuthHook(mockReq as never, {} as never, mockDone);

    // Assert
    expect(mockDone).toHaveBeenCalledExactlyOnceWith(
      expect.any(HttpError.Unauthorized),
    );
  });

  it('calls done with Unauthorized error when authorization header is missing', () => {
    // Arrange
    mockReq.headers.authorization = undefined;
    mockAuthService.isValidApiKey.mockReturnValue(false);

    // Act
    apiKeyAuthHook(mockReq as never, {} as never, mockDone);

    // Assert
    expect(mockDone).toHaveBeenCalledExactlyOnceWith(
      expect.any(HttpError.Unauthorized),
    );
  });
});
