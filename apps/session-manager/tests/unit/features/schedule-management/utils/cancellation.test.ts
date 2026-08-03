import { describe, expect, it } from 'vitest';

import {
  assertCancelable,
  assertUncancelable,
} from '#src/server/features/schedule-management/utils/cancellation.js';
import type { CancellableSession } from '#src/server/features/schedule-management/utils/cancellation.js';

const NOW = new Date('2024-06-03T12:00:00Z');

function makeSession(
  overrides: Partial<CancellableSession>,
): CancellableSession {
  return {
    type: 'SCHEDULED',
    canceledAt: null,
    startOverride: null,
    scheduledStartTime: new Date('2024-06-03T13:00:00Z'), // 1h after NOW
    ...overrides,
  };
}

describe('assertCancelable', () => {
  it('returns OK for an upcoming SCHEDULED session', () => {
    const session = makeSession({});
    expect(assertCancelable(session, NOW)).toBe('OK');
  });

  it('returns SESSION_NOT_SCHEDULED_TYPE for an AUTO session', () => {
    const session = makeSession({ type: 'AUTO' });
    expect(assertCancelable(session, NOW)).toBe('SESSION_NOT_SCHEDULED_TYPE');
  });

  it('returns SESSION_NOT_SCHEDULED_TYPE for an ON_DEMAND session', () => {
    const session = makeSession({ type: 'ON_DEMAND' });
    expect(assertCancelable(session, NOW)).toBe('SESSION_NOT_SCHEDULED_TYPE');
  });

  it('returns SESSION_ALREADY_CANCELED when canceledAt is already set', () => {
    const session = makeSession({
      canceledAt: new Date('2024-06-01T00:00:00Z'),
    });
    expect(assertCancelable(session, NOW)).toBe('SESSION_ALREADY_CANCELED');
  });

  it('returns SESSION_NOT_UPCOMING when the session has already started', () => {
    const session = makeSession({
      scheduledStartTime: new Date('2024-06-03T11:00:00Z'), // 1h before NOW
    });
    expect(assertCancelable(session, NOW)).toBe('SESSION_NOT_UPCOMING');
  });

  it('returns SESSION_NOT_UPCOMING when the session starts exactly at now', () => {
    const session = makeSession({ scheduledStartTime: NOW });
    expect(assertCancelable(session, NOW)).toBe('SESSION_NOT_UPCOMING');
  });

  it('uses startOverride, not scheduledStartTime, for the upcoming check', () => {
    // scheduledStartTime is in the past, but startOverride pushed it to the future.
    const session = makeSession({
      scheduledStartTime: new Date('2024-06-03T11:00:00Z'),
      startOverride: new Date('2024-06-03T13:00:00Z'),
    });
    expect(assertCancelable(session, NOW)).toBe('OK');
  });

  it('uses startOverride, not scheduledStartTime, when it makes the session no longer upcoming', () => {
    // scheduledStartTime is in the future, but startOverride pulled it into the past.
    const session = makeSession({
      scheduledStartTime: new Date('2024-06-03T13:00:00Z'),
      startOverride: new Date('2024-06-03T11:00:00Z'),
    });
    expect(assertCancelable(session, NOW)).toBe('SESSION_NOT_UPCOMING');
  });
});

describe('assertUncancelable', () => {
  it('returns OK when the session is canceled', () => {
    expect(
      assertUncancelable({ canceledAt: new Date('2024-06-01T00:00:00Z') }),
    ).toBe('OK');
  });

  it('returns SESSION_NOT_CANCELED when the session was never canceled', () => {
    expect(assertUncancelable({ canceledAt: null })).toBe(
      'SESSION_NOT_CANCELED',
    );
  });
});
