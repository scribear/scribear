import { describe, expect } from 'vitest';

import {
  ApiError,
  errorMessage,
  errorSeverity,
  isRateLimited,
  loginErrorMessage,
} from '#src/lib/api-error';

/**
 * A 429 exactly as admin-server's rate-limit plugin serializes it. `null`
 * models a 429 that carried no `details` at all.
 */
function rateLimited(retryAfter: string | null = '1 minute'): ApiError {
  return new ApiError(
    'RATE_LIMITED',
    'Too many requests. Please retry after 1 minute.',
    429,
    'req-1',
    retryAfter === null ? undefined : { retryAfter },
  );
}

describe('isRateLimited', (it) => {
  it('is true for any 429, since admin-server rate limits every route globally', () => {
    // Arrange / Act / Assert - keyed on status, not on the route or the code,
    // because `global: true` means there is no route-level allowlist to check.
    expect(isRateLimited(rateLimited())).toBe(true);
    expect(isRateLimited(new ApiError('CONFLICT', 'nope', 409))).toBe(false);
    expect(isRateLimited(new TypeError('Failed to fetch'))).toBe(false);
  });
});

describe('errorMessage', (it) => {
  it('replaces the log-facing 429 text with copy naming cause, effect and next action', () => {
    // Act
    const message = errorMessage(rateLimited(), 'Failed to load rooms.');

    // Assert - the server's own wording ("Please retry after 1 minute.") is
    // a summary for logs; the console has to say what happened to the request.
    expect(message).toBe(
      'Too many requests — the admin server is rate limiting this browser. Nothing was changed; wait 1 minute, then try again.',
    );
  });

  it('degrades to "a moment" when the server sent no retryAfter', () => {
    // Arrange - an older admin-server image, or a 429 from a proxy in front.
    // Act
    const message = errorMessage(rateLimited(null), 'Failed to load.');

    // Assert - never invents a duration it was not told.
    expect(message).toContain('wait a moment, then try again');
  });

  it('still passes non-429 API errors through verbatim', () => {
    // Act / Assert
    expect(
      errorMessage(
        new ApiError('CONFLICT', 'Room name already in use.', 409),
        'Failed to create room.',
      ),
    ).toBe('Room name already in use.');
    expect(errorMessage(new TypeError('boom'), 'Failed to create room.')).toBe(
      'Failed to create room.',
    );
  });
});

describe('loginErrorMessage', (it) => {
  it('tells the operator a rate-limited sign-in is not a rejected password', () => {
    // Arrange - the login route allows 5 attempts a minute, so this is what an
    // operator who mistyped their password a few times actually sees.
    // Act
    const message = loginErrorMessage(rateLimited());

    // Assert
    expect(message).toBe(
      'Too many sign-in attempts. This is a rate limit, not a rejected password — wait 1 minute, then sign in again.',
    );
  });

  it('leaves a real credential rejection alone', () => {
    // Act / Assert
    expect(
      loginErrorMessage(
        new ApiError('INVALID_CREDENTIALS', 'Invalid credentials.', 401),
      ),
    ).toBe('Invalid credentials.');
  });
});

describe('errorSeverity', (it) => {
  it('rates a rate limit as warning and everything else as error', () => {
    // Assert - house convention: `warning` = transient, no action but waiting;
    // `error` = terminal, the operator has to do something.
    expect(errorSeverity(rateLimited())).toBe('warning');
    expect(
      errorSeverity(new ApiError('INVALID_CREDENTIALS', 'Invalid.', 401)),
    ).toBe('error');
    expect(errorSeverity(new TypeError('boom'))).toBe('error');
  });
});
