import { describe, expect, it } from 'vitest';

import { materializeSchedule } from '#src/server/features/schedule-management/utils/schedule-materializer.js';
import type { ScheduleForMaterialization } from '#src/server/features/schedule-management/utils/schedule-materializer.js';

const TZ_NY = 'America/New_York';
const TZ_UTC = 'UTC';

// 2024-03-10: US Eastern spring-forward (2:00 AM EST → 3:00 AM EDT, UTC-5 → UTC-4)
// 2024-11-03: US Eastern fall-back (2:00 AM EDT → 1:00 AM EST, UTC-4 → UTC-5)

function makeSchedule(
  overrides: Partial<ScheduleForMaterialization>,
): ScheduleForMaterialization {
  return {
    uid: 'sched-1',
    activeStart: new Date('2024-01-01T00:00:00Z'),
    activeEnd: null,
    localStartTime: '09:00:00',
    localEndTime: '10:00:00',
    frequency: 'WEEKLY',
    daysOfWeek: ['MON'],
    ...overrides,
  };
}

describe('materializeSchedule', () => {
  describe('ONCE', () => {
    it('returns the single occurrence when it falls in the window', () => {
      // Arrange
      const schedule = makeSchedule({
        activeStart: new Date('2024-06-03T00:00:00Z'), // Mon Jun 3 in UTC
        frequency: 'ONCE',
        daysOfWeek: null,
        localStartTime: '09:00:00',
        localEndTime: '10:00:00',
      });

      // Act
      const result = materializeSchedule(
        schedule,
        TZ_UTC,
        new Date('2024-06-01T00:00:00Z'),
        new Date('2024-06-30T00:00:00Z'),
      );

      // Assert
      expect(result).toHaveLength(1);
      expect(result[0]!.startUtc).toEqual(new Date('2024-06-03T09:00:00Z'));
      expect(result[0]!.endUtc).toEqual(new Date('2024-06-03T10:00:00Z'));
    });

    it('returns empty when the occurrence falls outside the window', () => {
      // Arrange
      const schedule = makeSchedule({
        activeStart: new Date('2024-01-01T00:00:00Z'),
        frequency: 'ONCE',
        daysOfWeek: null,
      });

      // Act
      const result = materializeSchedule(
        schedule,
        TZ_UTC,
        new Date('2024-06-01T00:00:00Z'),
        new Date('2024-06-30T00:00:00Z'),
      );

      // Assert
      expect(result).toHaveLength(0);
    });

    it('drops the occurrence when occurrence start is before activeStart', () => {
      // Arrange: activeStart is late in the day; localStartTime is earlier, so
      // the computed UTC start would be before activeStart.
      const schedule = makeSchedule({
        activeStart: new Date('2024-06-03T14:00:00Z'), // 14:00 UTC = 10:00 EDT
        frequency: 'ONCE',
        daysOfWeek: null,
        localStartTime: '09:00:00', // 09:00 EDT = 13:00 UTC — before activeStart
        localEndTime: '10:00:00',
      });

      // Act
      const result = materializeSchedule(
        schedule,
        TZ_NY,
        new Date('2024-06-01T00:00:00Z'),
        new Date('2024-06-30T00:00:00Z'),
      );

      // Assert
      expect(result).toHaveLength(0);
    });
  });

  describe('WEEKLY', () => {
    it('materializes occurrences on the correct weekdays within the window', () => {
      // Arrange: MON/WED/FRI, 14:00-14:30 UTC for one week
      const schedule = makeSchedule({
        localStartTime: '14:00:00',
        localEndTime: '14:30:00',
        frequency: 'WEEKLY',
        daysOfWeek: ['MON', 'WED', 'FRI'],
      });

      // Act
      const result = materializeSchedule(
        schedule,
        TZ_UTC,
        new Date('2024-06-03T00:00:00Z'), // Mon
        new Date('2024-06-10T00:00:00Z'), // Next Mon (exclusive)
      );

      // Assert
      expect(result).toHaveLength(3);
      expect(result[0]!.startUtc).toEqual(new Date('2024-06-03T14:00:00Z')); // Mon
      expect(result[1]!.startUtc).toEqual(new Date('2024-06-05T14:00:00Z')); // Wed
      expect(result[2]!.startUtc).toEqual(new Date('2024-06-07T14:00:00Z')); // Fri
    });

    it('respects activeEnd and excludes occurrences whose end exceeds it', () => {
      // Arrange
      const schedule = makeSchedule({
        activeEnd: new Date('2024-06-05T14:30:00Z'), // Cuts off after Wed
        localStartTime: '14:00:00',
        localEndTime: '14:30:00',
        frequency: 'WEEKLY',
        daysOfWeek: ['MON', 'WED', 'FRI'],
      });

      // Act
      const result = materializeSchedule(
        schedule,
        TZ_UTC,
        new Date('2024-06-03T00:00:00Z'),
        new Date('2024-06-10T00:00:00Z'),
      );

      // Assert: Mon and Wed qualify; Fri's end (14:30) > activeEnd (14:30 on Wed) — wait, activeEnd is Jun 5 14:30
      // Fri Jun 7 14:30 > Jun 5 14:30 → excluded
      // Wed Jun 5 14:30 <= Jun 5 14:30 → included
      expect(result).toHaveLength(2);
      expect(result[0]!.startUtc).toEqual(new Date('2024-06-03T14:00:00Z'));
      expect(result[1]!.startUtc).toEqual(new Date('2024-06-05T14:00:00Z'));
    });

    it('includes an occurrence that started before windowStart but ends within it', () => {
      // Arrange: occurrence is 23:00-01:00 wrapping midnight
      const schedule = makeSchedule({
        localStartTime: '23:00:00',
        localEndTime: '01:00:00', // wraps to next day
        frequency: 'WEEKLY',
        daysOfWeek: ['MON'],
      });

      // Act: window starts at Mon 23:30 UTC, so the Mon 23:00 start is before it
      const result = materializeSchedule(
        schedule,
        TZ_UTC,
        new Date('2024-06-03T23:30:00Z'), // after occurrence start
        new Date('2024-06-04T12:00:00Z'),
      );

      // Assert: endUtc (Tue 01:00) > windowStart (Mon 23:30) → included
      expect(result).toHaveLength(1);
      expect(result[0]!.startUtc).toEqual(new Date('2024-06-03T23:00:00Z'));
      expect(result[0]!.endUtc).toEqual(new Date('2024-06-04T01:00:00Z'));
    });
  });

  describe('BIWEEKLY', () => {
    it('fires every other week from the anchor, skipping off weeks', () => {
      // Arrange: anchor week = ISO week of 2024-01-08 (Mon Jan 8).
      // Even-offset weeks from that anchor: Jan 8, Jan 22, Feb 5, ...
      const schedule = makeSchedule({
        activeStart: new Date('2024-01-08T14:00:00Z'),
        localStartTime: '14:00:00',
        localEndTime: '14:30:00',
        frequency: 'BIWEEKLY',
        daysOfWeek: ['MON'],
      });

      // Act: window covers Jan 8 - Feb 6 (four Mondays: Jan 8, 15, 22, 29)
      const result = materializeSchedule(
        schedule,
        TZ_UTC,
        new Date('2024-01-08T00:00:00Z'),
        new Date('2024-02-05T00:00:00Z'),
      );

      // Assert: only Jan 8 and Jan 22 qualify (0 and 2 weeks from anchor)
      expect(result).toHaveLength(2);
      expect(result[0]!.startUtc).toEqual(new Date('2024-01-08T14:00:00Z'));
      expect(result[1]!.startUtc).toEqual(new Date('2024-01-22T14:00:00Z'));
    });

    it('handles anchor weeks that span a year boundary', () => {
      // Arrange: anchor week contains 2024-12-30 (Mon, ISO week 1 of 2025).
      const schedule = makeSchedule({
        activeStart: new Date('2024-12-30T09:00:00Z'),
        localStartTime: '09:00:00',
        localEndTime: '10:00:00',
        frequency: 'BIWEEKLY',
        daysOfWeek: ['MON'],
      });

      // Act: window covers Dec 30 - Jan 20 2025
      const result = materializeSchedule(
        schedule,
        TZ_UTC,
        new Date('2024-12-30T00:00:00Z'),
        new Date('2025-01-21T00:00:00Z'),
      );

      // Assert: Dec 30, Jan 13 (2 weeks later) qualify; Jan 6 (1 week) does not
      expect(result).toHaveLength(2);
      expect(result[0]!.startUtc).toEqual(new Date('2024-12-30T09:00:00Z'));
      expect(result[1]!.startUtc).toEqual(new Date('2025-01-13T09:00:00Z'));
    });
  });

  describe('midnight-wrap', () => {
    it('produces a cross-midnight occurrence when localEndTime < localStartTime', () => {
      // Arrange: 23:00-01:00 means the session runs from Mon 23:00 to Tue 01:00
      const schedule = makeSchedule({
        localStartTime: '23:00:00',
        localEndTime: '01:00:00',
        frequency: 'WEEKLY',
        daysOfWeek: ['MON'],
      });

      // Act
      const result = materializeSchedule(
        schedule,
        TZ_UTC,
        new Date('2024-06-03T00:00:00Z'),
        new Date('2024-06-10T00:00:00Z'),
      );

      // Assert
      expect(result).toHaveLength(1);
      expect(result[0]!.startUtc).toEqual(new Date('2024-06-03T23:00:00Z'));
      expect(result[0]!.endUtc).toEqual(new Date('2024-06-04T01:00:00Z'));
    });
  });

  describe('DST — spring-forward (America/New_York, 2024-03-10)', () => {
    it('snaps an occurrence whose start is in the gap to the first valid instant', () => {
      // Arrange: 02:30-04:00 on spring-forward day; 02:30 does not exist.
      // Start should snap to 03:00 EDT; end is 04:00 EDT.
      const schedule = makeSchedule({
        activeStart: new Date('2024-03-10T05:00:00Z'), // midnight EST = Mar 10 local
        localStartTime: '02:30:00',
        localEndTime: '04:00:00',
        frequency: 'ONCE',
        daysOfWeek: null,
      });

      // Act
      const result = materializeSchedule(
        schedule,
        TZ_NY,
        new Date('2024-03-10T00:00:00Z'),
        new Date('2024-03-11T00:00:00Z'),
      );

      // Assert: 03:00 EDT = 07:00 UTC, 04:00 EDT = 08:00 UTC
      expect(result).toHaveLength(1);
      expect(result[0]!.startUtc).toEqual(new Date('2024-03-10T07:00:00Z'));
      expect(result[0]!.endUtc).toEqual(new Date('2024-03-10T08:00:00Z'));
    });

    it('snaps an occurrence whose end is in the gap', () => {
      // Arrange: 01:30-02:30 on spring-forward day; end (02:30) does not exist.
      // Start is 01:30 EST; end should snap to 03:00 EDT.
      const schedule = makeSchedule({
        activeStart: new Date('2024-03-10T05:00:00Z'), // midnight EST = Mar 10 local
        localStartTime: '01:30:00',
        localEndTime: '02:30:00',
        frequency: 'ONCE',
        daysOfWeek: null,
      });

      // Act
      const result = materializeSchedule(
        schedule,
        TZ_NY,
        new Date('2024-03-10T00:00:00Z'),
        new Date('2024-03-11T00:00:00Z'),
      );

      // Assert: 01:30 EST = 06:30 UTC, snapped end 03:00 EDT = 07:00 UTC
      expect(result).toHaveLength(1);
      expect(result[0]!.startUtc).toEqual(new Date('2024-03-10T06:30:00Z'));
      expect(result[0]!.endUtc).toEqual(new Date('2024-03-10T07:00:00Z'));
    });

    it('drops an occurrence whose entire span falls within the gap', () => {
      // Arrange: 02:15-02:45 — both endpoints are inside the 02:00-03:00 gap.
      const schedule = makeSchedule({
        activeStart: new Date('2024-03-10T05:00:00Z'), // midnight EST = Mar 10 local
        localStartTime: '02:15:00',
        localEndTime: '02:45:00',
        frequency: 'ONCE',
        daysOfWeek: null,
      });

      // Act
      const result = materializeSchedule(
        schedule,
        TZ_NY,
        new Date('2024-03-10T00:00:00Z'),
        new Date('2024-03-11T00:00:00Z'),
      );

      // Assert: both endpoints snap to 07:00 UTC → start >= end → dropped
      expect(result).toHaveLength(0);
    });

    it('produces normal occurrences on other days of the same week', () => {
      // Arrange: schedule fires Sun-Mon; spring-forward is Sunday Mar 10.
      // Sunday 02:30 snaps; Monday is unaffected.
      const schedule = makeSchedule({
        activeStart: new Date('2024-03-10T05:00:00Z'), // midnight EST = Mar 10 local
        localStartTime: '02:30:00',
        localEndTime: '04:00:00',
        frequency: 'WEEKLY',
        daysOfWeek: ['SUN', 'MON'],
      });

      // Act
      const result = materializeSchedule(
        schedule,
        TZ_NY,
        new Date('2024-03-10T00:00:00Z'),
        new Date('2024-03-13T00:00:00Z'),
      );

      // Assert: Sun snaps to 07:00 UTC; Mon 02:30 EDT = 06:30 UTC
      expect(result).toHaveLength(2);
      expect(result[0]!.startUtc).toEqual(new Date('2024-03-10T07:00:00Z')); // snapped
      expect(result[1]!.startUtc).toEqual(new Date('2024-03-11T06:30:00Z')); // Mon 02:30 EDT = 06:30 UTC
    });
  });

  describe('DST — fall-back (America/New_York, 2024-11-03)', () => {
    it('picks the later (standard-time) UTC instant for an ambiguous local time', () => {
      // Arrange: 01:30-03:00 on fall-back day.
      // 01:30 occurs twice: first as EDT (05:30 UTC), then as EST (06:30 UTC).
      // We want 06:30 UTC (the later, standard-time occurrence).
      const schedule = makeSchedule({
        activeStart: new Date('2024-11-03T04:00:00Z'), // midnight EDT = Nov 3 local
        localStartTime: '01:30:00',
        localEndTime: '03:00:00',
        frequency: 'ONCE',
        daysOfWeek: null,
      });

      // Act
      const result = materializeSchedule(
        schedule,
        TZ_NY,
        new Date('2024-11-03T00:00:00Z'),
        new Date('2024-11-04T00:00:00Z'),
      );

      // Assert: 01:30 EST = 06:30 UTC, 03:00 EST = 08:00 UTC
      expect(result).toHaveLength(1);
      expect(result[0]!.startUtc).toEqual(new Date('2024-11-03T06:30:00Z'));
      expect(result[0]!.endUtc).toEqual(new Date('2024-11-03T08:00:00Z'));
    });

    it('does not affect times outside the ambiguous window', () => {
      // Arrange: 10:00-11:00 — well outside the fall-back ambiguous hour.
      const schedule = makeSchedule({
        activeStart: new Date('2024-11-03T04:00:00Z'), // midnight EDT = Nov 3 local
        localStartTime: '10:00:00',
        localEndTime: '11:00:00',
        frequency: 'ONCE',
        daysOfWeek: null,
      });

      // Act
      const result = materializeSchedule(
        schedule,
        TZ_NY,
        new Date('2024-11-03T00:00:00Z'),
        new Date('2024-11-04T00:00:00Z'),
      );

      // Assert: 10:00 EST = 15:00 UTC, 11:00 EST = 16:00 UTC
      expect(result).toHaveLength(1);
      expect(result[0]!.startUtc).toEqual(new Date('2024-11-03T15:00:00Z'));
      expect(result[0]!.endUtc).toEqual(new Date('2024-11-03T16:00:00Z'));
    });
  });

  describe('timezone offset application', () => {
    it('converts local times correctly using the room timezone', () => {
      // Arrange: schedule at 09:00-10:00 in America/New_York (EDT, UTC-4 in June)
      const schedule = makeSchedule({
        activeStart: new Date('2024-06-03T04:00:00Z'), // midnight EDT = Jun 3 local
        localStartTime: '09:00:00',
        localEndTime: '10:00:00',
        frequency: 'ONCE',
        daysOfWeek: null,
      });

      // Act
      const result = materializeSchedule(
        schedule,
        TZ_NY,
        new Date('2024-06-01T00:00:00Z'),
        new Date('2024-06-30T00:00:00Z'),
      );

      // Assert: 09:00 EDT = 13:00 UTC
      expect(result).toHaveLength(1);
      expect(result[0]!.startUtc).toEqual(new Date('2024-06-03T13:00:00Z'));
      expect(result[0]!.endUtc).toEqual(new Date('2024-06-03T14:00:00Z'));
    });
  });

  describe('edge cases', () => {
    it('returns empty when windowStart >= windowEnd', () => {
      // Arrange
      const schedule = makeSchedule({});

      // Act
      const result = materializeSchedule(
        schedule,
        TZ_UTC,
        new Date('2024-06-10T00:00:00Z'),
        new Date('2024-06-10T00:00:00Z'),
      );

      // Assert
      expect(result).toHaveLength(0);
    });

    it('returns empty when the schedule active window is entirely outside the materialization window', () => {
      // Arrange
      const schedule = makeSchedule({
        activeStart: new Date('2024-01-01T00:00:00Z'),
        activeEnd: new Date('2024-01-31T00:00:00Z'),
      });

      // Act
      const result = materializeSchedule(
        schedule,
        TZ_UTC,
        new Date('2024-06-01T00:00:00Z'),
        new Date('2024-06-30T00:00:00Z'),
      );

      // Assert
      expect(result).toHaveLength(0);
    });

    it('attaches the correct scheduleUid to each occurrence', () => {
      // Arrange
      const schedule = makeSchedule({
        uid: 'my-schedule-uid',
        activeStart: new Date('2024-06-03T00:00:00Z'),
        frequency: 'ONCE',
        daysOfWeek: null,
      });

      // Act
      const result = materializeSchedule(
        schedule,
        TZ_UTC,
        new Date('2024-06-01T00:00:00Z'),
        new Date('2024-06-30T00:00:00Z'),
      );

      // Assert
      expect(result[0]!.scheduleUid).toBe('my-schedule-uid');
    });
  });
});
