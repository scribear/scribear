import { type Mock, beforeEach, describe, expect, vi } from 'vitest';

import { HttpError } from '@scribear/base-fastify-server';

import { nodeServerKeyAuthHook } from '#src/server/hooks/node-server-key-auth.hook.js';

describe('nodeServerKeyAuthHook', (it) => {
  const TEST_AUTH_HEADER = 'Bearer TEST_NODE_SERVER_KEY';

  let mockAuthService: { isValidNodeServerKey: Mock };
  let mockReq: {
    headers: { authorization: string | undefined };
    diScope: { resolve: Mock };
  };
  let mockDone: Mock;

  beforeEach(() => {
    mockAuthService = { isValidNodeServerKey: vi.fn() };
    mockReq = {
      headers: { authorization: TEST_AUTH_HEADER },
      diScope: { resolve: vi.fn().mockReturnValue(mockAuthService) },
    };
    mockDone = vi.fn();
  });

  it('calls done with no error when node server key is valid', () => {
    // Arrange
    mockAuthService.isValidNodeServerKey.mockReturnValue(true);

    // Act
    nodeServerKeyAuthHook(mockReq as never, {} as never, mockDone);

    // Assert
    expect(mockDone).toHaveBeenCalledExactlyOnceWith();
    expect(
      mockAuthService.isValidNodeServerKey,
    ).toHaveBeenCalledExactlyOnceWith(TEST_AUTH_HEADER);
  });

  it('calls done with Unauthorized error when node server key is invalid', () => {
    // Arrange
    mockAuthService.isValidNodeServerKey.mockReturnValue(false);

    // Act
    nodeServerKeyAuthHook(mockReq as never, {} as never, mockDone);

    // Assert
    expect(mockDone).toHaveBeenCalledExactlyOnceWith(
      expect.any(HttpError.Unauthorized),
    );
  });

  it('calls done with Unauthorized error when authorization header is missing', () => {
    // Arrange
    mockReq.headers.authorization = undefined;
    mockAuthService.isValidNodeServerKey.mockReturnValue(false);

    // Act
    nodeServerKeyAuthHook(mockReq as never, {} as never, mockDone);

    // Assert
    expect(mockDone).toHaveBeenCalledExactlyOnceWith(
      expect.any(HttpError.Unauthorized),
    );
  });
});
