import { describe, expect, it } from 'vitest';

import type { Session } from '@scribear/session-manager-schema';

import {
  computeBlockPosition,
  isOutsideHourWindow,
} from '#src/features/sessions/session-calendar-grid.utils';

/**
 * ISO instant for 2026-06-03 at the given local hour:minute, built from
 * local (not UTC) `Date` components — `computeBlockPosition` reads
 * `getHours()`/`getMinutes()` (local), so fixtures must be constructed this
 * way to be deterministic regardless of the time zone running the suite.
 */
function localTimeIso(hour: number, minute = 0): string {
  return new Date(2026, 5, 3, hour, minute, 0).toISOString();
}

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    uid: 'sess-1',
    roomUid: 'room-1',
    name: 'Session',
    type: 'SCHEDULED',
    scheduledSessionUid: null,
    scheduledStartTime: localTimeIso(9),
    scheduledEndTime: localTimeIso(10),
    startOverride: null,
    endOverride: null,
    canceledAt: null,
    effectiveStart: localTimeIso(9),
    effectiveEnd: localTimeIso(10),
    joinCodeScopes: [],
    transcriptionProviderId: 'whisper',
    transcriptionStreamConfig: {},
    sessionConfigVersion: 1,
    createdAt: '2026-06-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('computeBlockPosition', () => {
  it('positions a session fully within the displayed hours', () => {
    const session = makeSession({
      scheduledStartTime: localTimeIso(9),
      scheduledEndTime: localTimeIso(10),
    });
    const pos = computeBlockPosition(session, 7, 22);
    expect(pos).not.toBeNull();
    // 09:00 is 2h after the 7:00 day start, out of a 15h window.
    expect(pos?.topPct).toBeCloseTo((2 / 15) * 100);
    // 1h duration, out of a 15h window.
    expect(pos?.heightPct).toBeCloseTo((1 / 15) * 100);
  });

  it('clamps a session starting before dayStartHour', () => {
    const session = makeSession({
      scheduledStartTime: localTimeIso(5),
      scheduledEndTime: localTimeIso(8),
    });
    const pos = computeBlockPosition(session, 7, 22);
    expect(pos).not.toBeNull();
    expect(pos?.topPct).toBe(0);
    // Clamped to run from 7:00 to 8:00 -> 1h out of 15h.
    expect(pos?.heightPct).toBeCloseTo((1 / 15) * 100);
  });

  it('runs to the end of the day when scheduledEndTime is null (open-ended)', () => {
    const session = makeSession({
      scheduledStartTime: localTimeIso(20),
      scheduledEndTime: null,
    });
    const pos = computeBlockPosition(session, 7, 22);
    expect(pos).not.toBeNull();
    // 20:00 to 22:00 (day end) -> 2h out of 15h.
    expect(pos?.heightPct).toBeCloseTo((2 / 15) * 100);
  });

  it('returns null for a session entirely outside the displayed window', () => {
    const session = makeSession({
      scheduledStartTime: localTimeIso(1),
      scheduledEndTime: localTimeIso(2),
    });
    const pos = computeBlockPosition(session, 7, 22);
    expect(pos).toBeNull();
  });

  it('uses startOverride/endOverride when set', () => {
    const session = makeSession({
      scheduledStartTime: localTimeIso(1),
      scheduledEndTime: localTimeIso(2),
      startOverride: localTimeIso(9),
      endOverride: localTimeIso(10),
    });
    const pos = computeBlockPosition(session, 7, 22);
    expect(pos).not.toBeNull();
    expect(pos?.topPct).toBeCloseTo((2 / 15) * 100);
  });
});

describe('isOutsideHourWindow', () => {
  it('returns false for a session fully within the window', () => {
    const session = makeSession({
      scheduledStartTime: localTimeIso(9),
      scheduledEndTime: localTimeIso(10),
    });
    expect(isOutsideHourWindow(session, 7, 22)).toBe(false);
  });

  it('returns true for a session entirely outside the window', () => {
    const session = makeSession({
      scheduledStartTime: localTimeIso(1),
      scheduledEndTime: localTimeIso(2),
    });
    expect(isOutsideHourWindow(session, 7, 22)).toBe(true);
  });

  it('returns true for a session starting before the window (clipped)', () => {
    const session = makeSession({
      scheduledStartTime: localTimeIso(5),
      scheduledEndTime: localTimeIso(8),
    });
    expect(isOutsideHourWindow(session, 7, 22)).toBe(true);
  });

  it('returns true for a session ending after the window (clipped)', () => {
    const session = makeSession({
      scheduledStartTime: localTimeIso(21),
      scheduledEndTime: localTimeIso(23),
    });
    expect(isOutsideHourWindow(session, 7, 22)).toBe(true);
  });

  it('returns false for an open-ended session that starts within the window', () => {
    const session = makeSession({
      scheduledStartTime: localTimeIso(20),
      scheduledEndTime: null,
    });
    expect(isOutsideHourWindow(session, 7, 22)).toBe(false);
  });

  it('returns false for anything under the 24h window', () => {
    const session = makeSession({
      scheduledStartTime: localTimeIso(1),
      scheduledEndTime: localTimeIso(2),
    });
    expect(isOutsideHourWindow(session, 0, 24)).toBe(false);
  });
});
