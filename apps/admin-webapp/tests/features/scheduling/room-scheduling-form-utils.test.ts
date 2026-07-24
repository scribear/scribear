import { describe, expect } from 'vitest';

import {
  diffAutoWindowUpdate,
  diffScheduleUpdate,
  sameDaysOfWeek,
  sameStringArray,
} from '#src/features/scheduling/room-scheduling-form-utils';
import type { DayOfWeek, SessionScope } from '#src/lib/admin-api';

import { buildSchedule, buildWindow } from './fixtures';

/** The exact "resolved next state" `diffScheduleUpdate` expects, built from
 * a schedule so that "no changes" is the starting point for each test. */
function resolvedFromSchedule(
  schedule: ReturnType<typeof buildSchedule>,
): Parameters<typeof diffScheduleUpdate>[1] {
  return {
    name: schedule.name,
    activeStart: schedule.activeStart,
    activeEnd: schedule.activeEnd,
    localStartTime: schedule.localStartTime.slice(0, 5),
    localEndTime: schedule.localEndTime.slice(0, 5),
    frequency: schedule.frequency,
    daysOfWeek: schedule.daysOfWeek,
    joinCodeScopes: schedule.joinCodeScopes,
    transcriptionProviderId: schedule.transcriptionProviderId ?? '',
    transcriptionStreamConfig: schedule.transcriptionStreamConfig ?? {},
  };
}

function resolvedFromWindow(
  w: ReturnType<typeof buildWindow>,
): Parameters<typeof diffAutoWindowUpdate>[1] {
  return {
    localStartTime: w.localStartTime.slice(0, 5),
    localEndTime: w.localEndTime.slice(0, 5),
    daysOfWeek: w.daysOfWeek,
    activeStart: w.activeStart,
    activeEnd: w.activeEnd,
    joinCodeScopes: w.joinCodeScopes,
    transcriptionProviderId: w.transcriptionProviderId,
    transcriptionStreamConfig: w.transcriptionStreamConfig,
  };
}

describe('sameStringArray', (it) => {
  it('is true for the same elements regardless of order', () => {
    // Assert
    expect(sameStringArray(['MON', 'WED', 'FRI'], ['FRI', 'MON', 'WED'])).toBe(
      true,
    );
  });

  it('is false when lengths differ or elements differ', () => {
    // Assert
    expect(sameStringArray(['MON'], ['MON', 'TUE'])).toBe(false);
    expect(sameStringArray(['MON'], ['TUE'])).toBe(false);
  });
});

describe('sameDaysOfWeek', (it) => {
  it('is true for the same elements regardless of order, like sameStringArray', () => {
    // Assert
    expect(sameDaysOfWeek(['MON', 'WED', 'FRI'], ['FRI', 'MON', 'WED'])).toBe(
      true,
    );
  });

  it('is true when both sides are null', () => {
    // Assert
    expect(sameDaysOfWeek(null, null)).toBe(true);
  });

  it('is false when one side is null and the other is an array, even an empty one', () => {
    // Assert
    expect(sameDaysOfWeek(null, [])).toBe(false);
    expect(sameDaysOfWeek([], null)).toBe(false);
    expect(sameDaysOfWeek(null, ['MON'])).toBe(false);
  });
});

describe('diffScheduleUpdate', (it) => {
  it('returns an empty body when nothing changed', () => {
    // Arrange
    const schedule = buildSchedule();

    // Act
    const body = diffScheduleUpdate(schedule, resolvedFromSchedule(schedule));

    // Assert
    expect(body).toEqual({});
  });

  it('includes only name when only name changed', () => {
    // Arrange
    const schedule = buildSchedule();
    const next = { ...resolvedFromSchedule(schedule), name: 'New name' };

    // Act
    const body = diffScheduleUpdate(schedule, next);

    // Assert
    expect(body).toEqual({ name: 'New name' });
  });

  it('includes only activeStart when only activeStart changed', () => {
    // Arrange
    const schedule = buildSchedule();
    const next = {
      ...resolvedFromSchedule(schedule),
      activeStart: '2027-01-01T00:00:00.000Z',
    };

    // Act
    const body = diffScheduleUpdate(schedule, next);

    // Assert
    expect(body).toEqual({ activeStart: '2027-01-01T00:00:00.000Z' });
  });

  it('includes only activeEnd when only activeEnd changed', () => {
    // Arrange
    const schedule = buildSchedule({ activeEnd: null });
    const next = {
      ...resolvedFromSchedule(schedule),
      activeEnd: '2027-01-01T00:00:00.000Z',
    };

    // Act
    const body = diffScheduleUpdate(schedule, next);

    // Assert
    expect(body).toEqual({ activeEnd: '2027-01-01T00:00:00.000Z' });
  });

  it('includes only localStartTime when only localStartTime changed', () => {
    // Arrange
    const schedule = buildSchedule();
    const next = {
      ...resolvedFromSchedule(schedule),
      localStartTime: '10:00',
    };

    // Act
    const body = diffScheduleUpdate(schedule, next);

    // Assert
    expect(body).toEqual({ localStartTime: '10:00' });
  });

  it('includes only localEndTime when only localEndTime changed', () => {
    // Arrange
    const schedule = buildSchedule();
    const next = { ...resolvedFromSchedule(schedule), localEndTime: '11:00' };

    // Act
    const body = diffScheduleUpdate(schedule, next);

    // Assert
    expect(body).toEqual({ localEndTime: '11:00' });
  });

  it('includes only frequency when only frequency changed', () => {
    // Arrange
    const schedule = buildSchedule({ frequency: 'WEEKLY' });
    const next = {
      ...resolvedFromSchedule(schedule),
      frequency: 'ONCE' as const,
    };

    // Act
    const body = diffScheduleUpdate(schedule, next);

    // Assert
    expect(body).toEqual({ frequency: 'ONCE' });
  });

  it('includes only daysOfWeek when only daysOfWeek changed', () => {
    // Arrange
    const schedule = buildSchedule({ daysOfWeek: ['MON'] });
    const next = {
      ...resolvedFromSchedule(schedule),
      daysOfWeek: ['MON', 'TUE'] as DayOfWeek[],
    };

    // Act
    const body = diffScheduleUpdate(schedule, next);

    // Assert
    expect(body).toEqual({ daysOfWeek: ['MON', 'TUE'] });
  });

  it('includes only joinCodeScopes when only joinCodeScopes changed', () => {
    // Arrange
    const schedule = buildSchedule({ joinCodeScopes: ['SEND_AUDIO'] });
    const next = {
      ...resolvedFromSchedule(schedule),
      joinCodeScopes: ['RECEIVE_TRANSCRIPTIONS'] as SessionScope[],
    };

    // Act
    const body = diffScheduleUpdate(schedule, next);

    // Assert
    expect(body).toEqual({ joinCodeScopes: ['RECEIVE_TRANSCRIPTIONS'] });
  });

  it('includes only transcriptionProviderId when only that changed', () => {
    // Arrange
    const schedule = buildSchedule({ transcriptionProviderId: 'whisper' });
    const next = {
      ...resolvedFromSchedule(schedule),
      transcriptionProviderId: 'other-provider',
    };

    // Act
    const body = diffScheduleUpdate(schedule, next);

    // Assert
    expect(body).toEqual({ transcriptionProviderId: 'other-provider' });
  });

  it('treats a null transcriptionProviderId as unchanged against an empty-string next value', () => {
    // Arrange
    const schedule = buildSchedule({ transcriptionProviderId: null });
    const next = { ...resolvedFromSchedule(schedule), transcriptionProviderId: '' };

    // Act
    const body = diffScheduleUpdate(schedule, next);

    // Assert
    expect(body).toEqual({});
  });

  it('includes only transcriptionStreamConfig when only that changed', () => {
    // Arrange
    const schedule = buildSchedule({ transcriptionStreamConfig: { a: 1 } });
    const next = {
      ...resolvedFromSchedule(schedule),
      transcriptionStreamConfig: { a: 2 },
    };

    // Act
    const body = diffScheduleUpdate(schedule, next);

    // Assert
    expect(body).toEqual({ transcriptionStreamConfig: { a: 2 } });
  });

  it('treats a null transcriptionStreamConfig as unchanged against an empty-object next value', () => {
    // Arrange
    const schedule = buildSchedule({ transcriptionStreamConfig: null });
    const next = {
      ...resolvedFromSchedule(schedule),
      transcriptionStreamConfig: {},
    };

    // Act
    const body = diffScheduleUpdate(schedule, next);

    // Assert
    expect(body).toEqual({});
  });

  it('combines several changed fields, and only those, into one body', () => {
    // Arrange
    const schedule = buildSchedule();
    const next = {
      ...resolvedFromSchedule(schedule),
      name: 'Renamed',
      localEndTime: '12:00',
    };

    // Act
    const body = diffScheduleUpdate(schedule, next);

    // Assert
    expect(body).toEqual({ name: 'Renamed', localEndTime: '12:00' });
  });

  it('treats a same-set-but-reordered daysOfWeek as unchanged (order-insensitive, consistent with joinCodeScopes)', () => {
    // Arrange
    const schedule = buildSchedule({ daysOfWeek: ['MON', 'WED', 'FRI'] });
    const next = {
      ...resolvedFromSchedule(schedule),
      daysOfWeek: ['FRI', 'MON', 'WED'] as DayOfWeek[],
    };

    // Act
    const body = diffScheduleUpdate(schedule, next);

    // Assert
    expect(body).toEqual({});
  });

  it('treats a null daysOfWeek as unchanged against a null next value', () => {
    // Arrange
    const schedule = buildSchedule({ daysOfWeek: null });
    const next = { ...resolvedFromSchedule(schedule), daysOfWeek: null };

    // Act
    const body = diffScheduleUpdate(schedule, next);

    // Assert
    expect(body).toEqual({});
  });

  it('treats null vs. an actual daysOfWeek array as changed, not equivalent to empty', () => {
    // Arrange
    const schedule = buildSchedule({ daysOfWeek: null });
    const next = {
      ...resolvedFromSchedule(schedule),
      daysOfWeek: ['MON'] as DayOfWeek[],
    };

    // Act
    const body = diffScheduleUpdate(schedule, next);

    // Assert
    expect(body).toEqual({ daysOfWeek: ['MON'] });
  });

  it('treats a same-set-but-reordered joinCodeScopes as unchanged (order-insensitive)', () => {
    // Arrange
    const schedule = buildSchedule({
      joinCodeScopes: ['SEND_AUDIO', 'RECEIVE_TRANSCRIPTIONS'],
    });
    const next = {
      ...resolvedFromSchedule(schedule),
      joinCodeScopes: ['RECEIVE_TRANSCRIPTIONS', 'SEND_AUDIO'] as SessionScope[],
    };

    // Act
    const body = diffScheduleUpdate(schedule, next);

    // Assert
    expect(body).toEqual({});
  });
});

describe('diffAutoWindowUpdate', (it) => {
  it('returns an empty body when nothing changed', () => {
    // Arrange
    const w = buildWindow();

    // Act
    const body = diffAutoWindowUpdate(w, resolvedFromWindow(w));

    // Assert
    expect(body).toEqual({});
  });

  it('includes only localStartTime when only localStartTime changed', () => {
    // Arrange
    const w = buildWindow();
    const next = { ...resolvedFromWindow(w), localStartTime: '10:00' };

    // Act
    const body = diffAutoWindowUpdate(w, next);

    // Assert
    expect(body).toEqual({ localStartTime: '10:00' });
  });

  it('includes only localEndTime when only localEndTime changed', () => {
    // Arrange
    const w = buildWindow();
    const next = { ...resolvedFromWindow(w), localEndTime: '18:00' };

    // Act
    const body = diffAutoWindowUpdate(w, next);

    // Assert
    expect(body).toEqual({ localEndTime: '18:00' });
  });

  it('includes only daysOfWeek when the set of days actually changed', () => {
    // Arrange
    const w = buildWindow({ daysOfWeek: ['MON', 'TUE'] });
    const next = {
      ...resolvedFromWindow(w),
      daysOfWeek: ['MON', 'TUE', 'WED'] as DayOfWeek[],
    };

    // Act
    const body = diffAutoWindowUpdate(w, next);

    // Assert
    expect(body).toEqual({ daysOfWeek: ['MON', 'TUE', 'WED'] });
  });

  it('treats a same-set-but-reordered daysOfWeek as unchanged (order-insensitive, unlike the schedule dialog)', () => {
    // Arrange
    const w = buildWindow({ daysOfWeek: ['MON', 'TUE', 'WED'] });
    const next = {
      ...resolvedFromWindow(w),
      daysOfWeek: ['WED', 'MON', 'TUE'] as DayOfWeek[],
    };

    // Act
    const body = diffAutoWindowUpdate(w, next);

    // Assert
    expect(body).toEqual({});
  });

  it('includes only activeStart when only activeStart changed', () => {
    // Arrange
    const w = buildWindow();
    const next = {
      ...resolvedFromWindow(w),
      activeStart: '2027-01-01T00:00:00.000Z',
    };

    // Act
    const body = diffAutoWindowUpdate(w, next);

    // Assert
    expect(body).toEqual({ activeStart: '2027-01-01T00:00:00.000Z' });
  });

  it('includes only activeEnd when only activeEnd changed', () => {
    // Arrange
    const w = buildWindow({ activeEnd: null });
    const next = {
      ...resolvedFromWindow(w),
      activeEnd: '2027-01-01T00:00:00.000Z',
    };

    // Act
    const body = diffAutoWindowUpdate(w, next);

    // Assert
    expect(body).toEqual({ activeEnd: '2027-01-01T00:00:00.000Z' });
  });

  it('includes only joinCodeScopes when the set of scopes actually changed', () => {
    // Arrange
    const w = buildWindow({ joinCodeScopes: ['SEND_AUDIO'] });
    const next = {
      ...resolvedFromWindow(w),
      joinCodeScopes: ['SEND_AUDIO', 'RECEIVE_TRANSCRIPTIONS'] as SessionScope[],
    };

    // Act
    const body = diffAutoWindowUpdate(w, next);

    // Assert
    expect(body).toEqual({
      joinCodeScopes: ['SEND_AUDIO', 'RECEIVE_TRANSCRIPTIONS'],
    });
  });

  it('treats a same-set-but-reordered joinCodeScopes as unchanged (order-insensitive)', () => {
    // Arrange
    const w = buildWindow({
      joinCodeScopes: ['SEND_AUDIO', 'RECEIVE_TRANSCRIPTIONS'],
    });
    const next = {
      ...resolvedFromWindow(w),
      joinCodeScopes: ['RECEIVE_TRANSCRIPTIONS', 'SEND_AUDIO'] as SessionScope[],
    };

    // Act
    const body = diffAutoWindowUpdate(w, next);

    // Assert
    expect(body).toEqual({});
  });

  it('includes only transcriptionProviderId when only that changed', () => {
    // Arrange
    const w = buildWindow({ transcriptionProviderId: 'whisper' });
    const next = {
      ...resolvedFromWindow(w),
      transcriptionProviderId: 'other-provider',
    };

    // Act
    const body = diffAutoWindowUpdate(w, next);

    // Assert
    expect(body).toEqual({ transcriptionProviderId: 'other-provider' });
  });

  it('includes only transcriptionStreamConfig when only that changed', () => {
    // Arrange
    const w = buildWindow({ transcriptionStreamConfig: { a: 1 } });
    const next = {
      ...resolvedFromWindow(w),
      transcriptionStreamConfig: { a: 2 },
    };

    // Act
    const body = diffAutoWindowUpdate(w, next);

    // Assert
    expect(body).toEqual({ transcriptionStreamConfig: { a: 2 } });
  });

  it('combines several changed fields, and only those, into one body', () => {
    // Arrange
    const w = buildWindow();
    const next = {
      ...resolvedFromWindow(w),
      localStartTime: '07:00',
      transcriptionProviderId: 'other-provider',
    };

    // Act
    const body = diffAutoWindowUpdate(w, next);

    // Assert
    expect(body).toEqual({
      localStartTime: '07:00',
      transcriptionProviderId: 'other-provider',
    });
  });
});
