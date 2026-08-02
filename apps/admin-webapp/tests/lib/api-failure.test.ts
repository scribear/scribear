import { describe, expect } from 'vitest';

import { ApiError } from '#src/lib/api-error';
import { describeApiFailure } from '#src/lib/api-failure';

describe('describeApiFailure', (it) => {
  it('does not offer a retry for an expired session', () => {
    // Retrying a 401 just fails again; the action is to sign in.
    const failure = describeApiFailure(
      new ApiError('UNAUTHENTICATED', 'Authentication required.', 401, 'r-1'),
      'Could not load rooms.',
    );

    expect(failure.retryable).toBe(false);
    expect(failure.cause).toBe('Your admin session has expired.');
    expect(failure.nextAction).toMatch(/sign in again/i);
  });

  it('does not offer a retry for a wrong ADMIN_API_KEY', () => {
    const failure = describeApiFailure(
      new ApiError('BACKEND_MISCONFIGURATION', 'nope', 502, 'r-2'),
      'Could not load rooms.',
    );

    expect(failure.retryable).toBe(false);
    expect(failure.nextAction).toMatch(/ADMIN_API_KEY/);
  });

  it('keeps the rate limiter’s own wording, which carries the window', () => {
    // `rate-limit.plugin.ts` builds "Too many requests. Please retry after N."
    const failure = describeApiFailure(
      new ApiError(
        'RATE_LIMITED',
        'Too many requests. Please retry after 42 seconds.',
        429,
        'r-3',
      ),
      'Could not load rooms.',
    );

    expect(failure.cause).toContain('42 seconds');
    expect(failure.retryable).toBe(true);
    // The console does not auto-retry, so the copy must not imply it does.
    expect(failure.nextAction).toMatch(
      /nothing on this page retries on its own/,
    );
  });

  it('distinguishes an unreachable Session Manager from a dead admin server', () => {
    const upstream = describeApiFailure(
      new ApiError('UPSTREAM_UNREACHABLE', 'unreachable', 503),
      'Could not load rooms.',
    );
    const network = describeApiFailure(
      new ApiError('NETWORK', 'Could not reach the admin server.', 0),
      'Could not load rooms.',
    );

    expect(upstream.cause).toMatch(/could not reach Session Manager/);
    expect(network.cause).toMatch(/never completed/);
    expect(upstream.nextAction).not.toBe(network.nextAction);
  });

  it('carries the requestId when the server produced one, and not otherwise', () => {
    // `admin-api.ts` mints the NETWORK error itself: the request never reached
    // a server, so there is no correlation id to quote.
    expect(
      describeApiFailure(
        new ApiError('INTERNAL_ERROR', 'boom', 500, 'req-9'),
        'Could not load rooms.',
      ).requestId,
    ).toBe('req-9');
    expect(
      describeApiFailure(
        new ApiError('NETWORK', 'Could not reach the admin server.', 0),
        'Could not load rooms.',
      ).requestId,
    ).toBeUndefined();
  });

  it('falls back to the caller’s wording for a non-ApiError rejection', () => {
    const failure = describeApiFailure(
      new Error('TypeError: undefined is not a function'),
      'Could not load rooms.',
    );

    expect(failure.cause).toBe('Could not load rooms.');
    expect(failure.retryable).toBe(true);
  });
});
