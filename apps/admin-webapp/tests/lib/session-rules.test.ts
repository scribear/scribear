import { describe, expect, it } from 'vitest';

import type { Room, Session } from '@scribear/session-manager-schema';

import {
  GRID_MAX_COLUMNS,
  HOUR_RANGE_PRESETS,
  canCancel,
  canEndEarly,
  canStartEarly,
  defaultRoomSelection,
  nextHourRangeIndex,
  sessionTypeColor,
} from '#src/lib/session-rules';

const NOW = new Date('2026-06-03T12:00:00.000Z');

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    uid: 'sess-1',
    roomUid: 'room-1',
    name: 'Session',
    type: 'SCHEDULED',
    scheduledSessionUid: 'sched-1',
    scheduledStartTime: '2026-06-03T13:00:00.000Z', // 1h after NOW
    scheduledEndTime: '2026-06-03T14:00:00.000Z',
    startOverride: null,
    endOverride: null,
    canceledAt: null,
    effectiveStart: '2026-06-03T13:00:00.000Z',
    effectiveEnd: '2026-06-03T14:00:00.000Z',
    joinCodeScopes: [],
    transcriptionProviderId: 'whisper',
    transcriptionStreamConfig: {},
    sessionConfigVersion: 1,
    createdAt: '2026-06-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('sessionTypeColor', () => {
  it('returns info for SCHEDULED', () => {
    expect(sessionTypeColor('SCHEDULED')).toBe('info');
  });

  it('returns success for ON_DEMAND', () => {
    expect(sessionTypeColor('ON_DEMAND')).toBe('success');
  });

  it('returns default for AUTO', () => {
    expect(sessionTypeColor('AUTO')).toBe('default');
  });
});

describe('canCancel', () => {
  it('returns true for an upcoming SCHEDULED session', () => {
    expect(canCancel(makeSession(), NOW)).toBe(true);
  });

  it('returns false for an AUTO session', () => {
    expect(canCancel(makeSession({ type: 'AUTO' }), NOW)).toBe(false);
  });

  it('returns false for an ON_DEMAND session', () => {
    expect(canCancel(makeSession({ type: 'ON_DEMAND' }), NOW)).toBe(false);
  });

  it('returns false when already canceled', () => {
    expect(
      canCancel(makeSession({ canceledAt: '2026-06-01T00:00:00.000Z' }), NOW),
    ).toBe(false);
  });

  it('returns false once the session has started', () => {
    expect(
      canCancel(
        makeSession({ scheduledStartTime: '2026-06-03T11:00:00.000Z' }),
        NOW,
      ),
    ).toBe(false);
  });

  it('uses startOverride, not scheduledStartTime, for the upcoming check', () => {
    expect(
      canCancel(
        makeSession({
          scheduledStartTime: '2026-06-03T11:00:00.000Z',
          startOverride: '2026-06-03T13:00:00.000Z',
        }),
        NOW,
      ),
    ).toBe(true);
  });
});

describe('canStartEarly', () => {
  it('returns true for an upcoming non-AUTO session', () => {
    expect(canStartEarly(makeSession(), NOW)).toBe(true);
    expect(canStartEarly(makeSession({ type: 'ON_DEMAND' }), NOW)).toBe(true);
  });

  it('returns false for an AUTO session', () => {
    expect(canStartEarly(makeSession({ type: 'AUTO' }), NOW)).toBe(false);
  });

  it('returns false once the session has already started', () => {
    expect(
      canStartEarly(
        makeSession({ scheduledStartTime: '2026-06-03T11:00:00.000Z' }),
        NOW,
      ),
    ).toBe(false);
  });

  it('uses startOverride over scheduledStartTime', () => {
    expect(
      canStartEarly(
        makeSession({
          scheduledStartTime: '2026-06-03T11:00:00.000Z',
          startOverride: '2026-06-03T13:00:00.000Z',
        }),
        NOW,
      ),
    ).toBe(true);
  });
});

describe('canEndEarly', () => {
  it('returns false for a session that has not started yet', () => {
    expect(canEndEarly(makeSession(), NOW)).toBe(false);
  });

  it('returns true for a currently-active non-AUTO session', () => {
    const session = makeSession({
      scheduledStartTime: '2026-06-03T11:00:00.000Z',
      scheduledEndTime: '2026-06-03T13:00:00.000Z',
    });
    expect(canEndEarly(session, NOW)).toBe(true);
  });

  it('returns false for an AUTO session', () => {
    const session = makeSession({
      type: 'AUTO',
      scheduledStartTime: '2026-06-03T11:00:00.000Z',
      scheduledEndTime: '2026-06-03T13:00:00.000Z',
    });
    expect(canEndEarly(session, NOW)).toBe(false);
  });

  it('returns false once the session has already ended', () => {
    const session = makeSession({
      scheduledStartTime: '2026-06-03T09:00:00.000Z',
      scheduledEndTime: '2026-06-03T10:00:00.000Z',
    });
    expect(canEndEarly(session, NOW)).toBe(false);
  });

  it('treats a null scheduledEndTime as open-ended (never "ended")', () => {
    const session = makeSession({
      scheduledStartTime: '2026-06-03T11:00:00.000Z',
      scheduledEndTime: null,
    });
    expect(canEndEarly(session, NOW)).toBe(true);
  });

  it('uses endOverride over scheduledEndTime', () => {
    const session = makeSession({
      scheduledStartTime: '2026-06-03T09:00:00.000Z',
      scheduledEndTime: '2026-06-03T13:00:00.000Z',
      endOverride: '2026-06-03T10:00:00.000Z',
    });
    expect(canEndEarly(session, NOW)).toBe(false);
  });
});

function makeRoom(overrides: Partial<Room> = {}): Room {
  return {
    uid: 'room-1',
    name: 'Room 1',
    timezone: 'America/Chicago',
    autoSessionEnabled: false,
    roomScheduleVersion: 1,
    createdAt: '2026-06-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('defaultRoomSelection', () => {
  it('returns the full page for a small deployment (no more pages, within threshold)', () => {
    const rooms = Array.from({ length: 3 }, (_, i) =>
      makeRoom({ uid: `room-${String(i)}` }),
    );
    expect(defaultRoomSelection(rooms, false)).toEqual(rooms);
  });

  it('returns the full page when the count exactly meets the threshold', () => {
    const rooms = Array.from({ length: GRID_MAX_COLUMNS }, (_, i) =>
      makeRoom({ uid: `room-${String(i)}` }),
    );
    expect(defaultRoomSelection(rooms, false)).toEqual(rooms);
  });

  it('returns nothing when there are more pages beyond the first', () => {
    const rooms = [makeRoom()];
    expect(defaultRoomSelection(rooms, true)).toEqual([]);
  });

  it('returns nothing when the first page alone exceeds the grid threshold', () => {
    const rooms = Array.from({ length: GRID_MAX_COLUMNS + 1 }, (_, i) =>
      makeRoom({ uid: `room-${String(i)}` }),
    );
    expect(defaultRoomSelection(rooms, false)).toEqual([]);
  });
});

describe('nextHourRangeIndex', () => {
  it('advances to the next preset', () => {
    expect(nextHourRangeIndex(0)).toBe(1);
  });

  it('wraps back to the first preset after the last', () => {
    expect(nextHourRangeIndex(HOUR_RANGE_PRESETS.length - 1)).toBe(0);
  });

  it('cycles through every preset and back to the start', () => {
    let index = 0;
    for (let i = 0; i < HOUR_RANGE_PRESETS.length; i++) {
      index = nextHourRangeIndex(index);
    }
    expect(index).toBe(0);
  });
});
