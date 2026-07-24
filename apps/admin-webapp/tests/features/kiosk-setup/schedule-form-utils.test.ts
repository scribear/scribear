import { afterEach, beforeEach, describe, expect, vi } from 'vitest';

import type { CommonFormState } from '#src/features/kiosk-setup/schedule-form-utils';
import {
  START_LEAD_MS,
  dateInputToLocalMidnight,
  dateToInput,
  describeSchedule,
  describeWindow,
  resolveActiveRange,
} from '#src/features/kiosk-setup/schedule-form-utils';

// Wall-clock "now" used by every fake-timer test: 2026-07-23 10:00:00 local,
// safely away from a midnight rollover unless a test deliberately wants one.
const NOW = new Date(2026, 6, 23, 10, 0, 0, 0);

function buildForm(overrides: Partial<CommonFormState> = {}): CommonFormState {
  return {
    daysOfWeek: [],
    localStartTime: '09:00',
    localEndTime: '10:00',
    startsOn: dateToInput(NOW),
    indefinite: true,
    endsOn: '',
    joinCodeScopes: ['SEND_AUDIO', 'RECEIVE_TRANSCRIPTIONS'],
    transcriptionProviderId: 'whisper',
    transcriptionStreamConfig: '{}',
    ...overrides,
  };
}

describe('dateToInput / dateInputToLocalMidnight', (it) => {
  it('round-trips a local date through the input format', () => {
    // Arrange
    const d = new Date(2026, 7, 24, 15, 30);

    // Act
    const input = dateToInput(d);
    const parsed = dateInputToLocalMidnight(input);

    // Assert
    expect(input).toBe('2026-08-24');
    expect(parsed).not.toBeNull();
    expect(parsed?.getFullYear()).toBe(2026);
    expect(parsed?.getMonth()).toBe(7);
    expect(parsed?.getDate()).toBe(24);
    expect(parsed?.getHours()).toBe(0);
    expect(parsed?.getMinutes()).toBe(0);
    expect(parsed?.getSeconds()).toBe(0);
  });

  it('parses as local midnight, not UTC midnight', () => {
    // Act
    const parsed = dateInputToLocalMidnight('2026-08-24');

    // Assert: `new Date('2026-08-24')` would read this as UTC midnight, which
    // is the wrong calendar day in any zone west of Greenwich.
    expect(parsed?.getHours()).toBe(0);
    expect(parsed?.getFullYear()).toBe(2026);
    expect(parsed?.getMonth()).toBe(7);
    expect(parsed?.getDate()).toBe(24);
  });

  it('returns null for input that does not match the yyyy-mm-dd shape', () => {
    expect(dateInputToLocalMidnight('')).toBeNull();
    expect(dateInputToLocalMidnight('garbage')).toBeNull();
    expect(dateInputToLocalMidnight('08/24/2026')).toBeNull();
    expect(dateInputToLocalMidnight('2026-8-24')).toBeNull();
  });

  it('rolls over out-of-range month/day components rather than rejecting them', () => {
    // The regex only checks shape, not calendar validity, so `Date`'s own
    // rollover semantics apply — documented here so a tightening of the regex
    // is a deliberate choice, not an accidental behavior change.
    const parsed = dateInputToLocalMidnight('2026-13-01');
    expect(parsed).not.toBeNull();
    expect(parsed?.getFullYear()).toBe(2027);
    expect(parsed?.getMonth()).toBe(0);
  });
});

describe('resolveActiveRange', (it) => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('rejects a start date before today', () => {
    // Arrange
    const yesterday = new Date(NOW);
    yesterday.setDate(yesterday.getDate() - 1);
    const form = buildForm({ startsOn: dateToInput(yesterday) });

    // Act
    const result = resolveActiveRange(form, true);

    // Assert
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.toLowerCase()).toMatch(/today|later/);
    }
  });

  it('anchors a today start to now + lead time when anchorToFuture is true', () => {
    // Arrange
    const form = buildForm({ startsOn: dateToInput(NOW) });

    // Act
    const result = resolveActiveRange(form, true);

    // Assert
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.activeStart).toBe(
        new Date(NOW.getTime() + START_LEAD_MS).toISOString(),
      );
    }
  });

  it('anchors a future start to exactly local midnight when anchorToFuture is true', () => {
    // Arrange
    const tomorrow = new Date(NOW);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const midnight = new Date(
      tomorrow.getFullYear(),
      tomorrow.getMonth(),
      tomorrow.getDate(),
    );
    const form = buildForm({ startsOn: dateToInput(tomorrow) });

    // Act
    const result = resolveActiveRange(form, true);

    // Assert
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.activeStart).toBe(midnight.toISOString());
    }
  });

  it('anchors a today start to exactly local midnight when anchorToFuture is false', () => {
    // Arrange: this is the window-form regression guard — a kiosk configured
    // mid-morning must not lose the rest of today's open hours to a
    // now-based anchor the way schedules do.
    const midnight = new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate());
    const form = buildForm({ startsOn: dateToInput(NOW) });

    // Act
    const result = resolveActiveRange(form, false);

    // Assert
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.activeStart).toBe(midnight.toISOString());
      expect(result.activeStart).not.toBe(
        new Date(NOW.getTime() + START_LEAD_MS).toISOString(),
      );
    }
  });

  it('returns a null activeEnd when indefinite is true', () => {
    // Arrange
    const form = buildForm({ startsOn: dateToInput(NOW), indefinite: true });

    // Act
    const result = resolveActiveRange(form, false);

    // Assert
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.activeEnd).toBeNull();
    }
  });

  it('rejects an end date that has already fallen before the anchored start', () => {
    // Arrange: with 10s left in the day, the anchorToFuture lead time rolls
    // activeStart into tomorrow, so an end date equal to today's start date
    // (even at its last inclusive instant, 23:59:59.999) is now too early.
    // This guards the exact overlap between START_LEAD_MS and a day boundary.
    const lateNow = new Date(2026, 6, 23, 23, 59, 50, 0);
    vi.setSystemTime(lateNow);
    const today = dateToInput(lateNow);
    const form = buildForm({
      startsOn: today,
      indefinite: false,
      endsOn: today,
    });

    // Act
    const result = resolveActiveRange(form, true);

    // Assert
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/end date must be after/i);
    }
  });

  it('accepts an end date after the start date, inclusive through end of day', () => {
    // Arrange
    const start = dateToInput(NOW);
    const endDate = new Date(NOW);
    endDate.setDate(endDate.getDate() + 5);
    const form = buildForm({
      startsOn: start,
      indefinite: false,
      endsOn: dateToInput(endDate),
    });

    // Act
    const result = resolveActiveRange(form, false);

    // Assert
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.activeEnd).not.toBeNull();
      const parsedEnd = new Date(result.activeEnd!);
      expect(parsedEnd.getFullYear()).toBe(endDate.getFullYear());
      expect(parsedEnd.getMonth()).toBe(endDate.getMonth());
      expect(parsedEnd.getDate()).toBe(endDate.getDate());
      expect(parsedEnd.getHours()).toBe(23);
      expect(parsedEnd.getMinutes()).toBe(59);
      expect(parsedEnd.getSeconds()).toBe(59);
      expect(parsedEnd.getMilliseconds()).toBe(999);
    }
  });

  it('rejects an empty startsOn without throwing', () => {
    const form = buildForm({ startsOn: '' });
    expect(() => resolveActiveRange(form, true)).not.toThrow();
    expect(resolveActiveRange(form, true).ok).toBe(false);
  });

  it('rejects a garbage startsOn without throwing', () => {
    const form = buildForm({ startsOn: 'garbage' });
    expect(() => resolveActiveRange(form, true)).not.toThrow();
    expect(resolveActiveRange(form, true).ok).toBe(false);
  });

  it('rejects a missing endsOn when not indefinite', () => {
    const form = buildForm({
      startsOn: dateToInput(NOW),
      indefinite: false,
      endsOn: '',
    });
    const result = resolveActiveRange(form, false);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/end date/i);
    }
  });
});

describe('describeSchedule / describeWindow', (it) => {
  it('truncates seconds from the time-of-day', () => {
    const schedule = {
      uid: 's1',
      name: 'CS 225 Lecture',
      frequency: 'ONCE' as const,
      daysOfWeek: null,
      localStartTime: '09:00:00',
      localEndTime: '09:50:00',
    };

    expect(describeSchedule(schedule as never)).toBe(
      'CS 225 Lecture — ONCE 09:00–09:50',
    );
  });

  it('renders with no stray separator when daysOfWeek is null (ONCE)', () => {
    const schedule = {
      uid: 's1',
      name: 'One-off',
      frequency: 'ONCE' as const,
      daysOfWeek: null,
      localStartTime: '13:00:00',
      localEndTime: '14:00:00',
    };

    expect(describeSchedule(schedule as never)).toBe(
      'One-off — ONCE 13:00–14:00',
    );
  });

  it('lists days for a recurring schedule', () => {
    const schedule = {
      uid: 's1',
      name: 'MWF Lecture',
      frequency: 'WEEKLY' as const,
      daysOfWeek: ['MON', 'WED', 'FRI'],
      localStartTime: '09:00:00',
      localEndTime: '09:50:00',
    };

    expect(describeSchedule(schedule as never)).toBe(
      'MWF Lecture — WEEKLY MON, WED, FRI 09:00–09:50',
    );
  });

  it('renders a window as a day list and time range', () => {
    const window = {
      uid: 'w1',
      daysOfWeek: ['MON', 'TUE', 'WED', 'THU', 'FRI'],
      localStartTime: '08:00:00',
      localEndTime: '17:00:00',
    };

    expect(describeWindow(window as never)).toBe(
      'MON, TUE, WED, THU, FRI 08:00–17:00',
    );
  });
});
