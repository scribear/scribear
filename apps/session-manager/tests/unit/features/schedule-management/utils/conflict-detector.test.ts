import { describe, expect, it } from 'vitest';

import { detectConflict } from '#src/server/features/schedule-management/utils/conflict-detector.js';
import type { ScheduleForMaterialization } from '#src/server/features/schedule-management/utils/schedule-materializer.js';

const TZ_UTC = 'UTC';
const NOW = new Date('2024-06-03T00:00:00Z');

function makeSchedule(
  overrides: Partial<ScheduleForMaterialization>,
): ScheduleForMaterialization {
  const activeStart = overrides.activeStart ?? new Date('2024-06-03T00:00:00Z');
  return {
    uid: 'sched-1',
    activeStart,
    activeEnd: null,
    // Default anchor mirrors the original activeStart, matching how the
    // service sets anchor_start = activeStart on schedule creation.
    anchorStart: activeStart,
    localStartTime: '09:00:00',
    localEndTime: '10:00:00',
    frequency: 'WEEKLY',
    daysOfWeek: ['MON'],
    ...overrides,
  };
}

describe('detectConflict', () => {
  describe('WEEKLY vs WEEKLY', () => {
    it('returns true when two schedules share the same time slot', () => {
      // Arrange
      const a = makeSchedule({ uid: 'a', daysOfWeek: ['MON'] });
      const b = makeSchedule({
        uid: 'b',
        daysOfWeek: ['MON'],
        localStartTime: '09:30:00',
        localEndTime: '10:30:00',
      });

      // Act
      const result = detectConflict(a, b, TZ_UTC, NOW);

      // Assert - both fire Mon 09:00-10:00 and 09:30-10:30 - overlap exists
      expect(result).toBe(true);
    });

    it('returns false when two schedules have non-overlapping time slots on the same day', () => {
      // Arrange
      const a = makeSchedule({ uid: 'a', daysOfWeek: ['MON'] });
      const b = makeSchedule({
        uid: 'b',
        daysOfWeek: ['MON'],
        localStartTime: '10:00:00',
        localEndTime: '11:00:00',
      });

      // Act
      const result = detectConflict(a, b, TZ_UTC, NOW);

      // Assert - a ends at 10:00 exactly when b starts - no overlap (half-open intervals)
      expect(result).toBe(false);
    });

    it('returns false when two schedules fire on different days', () => {
      // Arrange
      const a = makeSchedule({ uid: 'a', daysOfWeek: ['MON'] });
      const b = makeSchedule({ uid: 'b', daysOfWeek: ['WED'] });

      // Act
      const result = detectConflict(a, b, TZ_UTC, NOW);

      // Assert
      expect(result).toBe(false);
    });
  });

  describe('BIWEEKLY vs WEEKLY', () => {
    it('detects a conflict on even weeks when they share the same time slot', () => {
      // Arrange - biweekly fires Mon every two weeks; weekly fires every Mon
      const a = makeSchedule({
        uid: 'a',
        activeStart: new Date('2024-06-03T00:00:00Z'), // anchor: week of Jun 3
        frequency: 'BIWEEKLY',
        daysOfWeek: ['MON'],
      });
      const b = makeSchedule({ uid: 'b', daysOfWeek: ['MON'] });

      // Act
      const result = detectConflict(a, b, TZ_UTC, NOW);

      // Assert - Jun 3 (anchor week, offset 0 - even) is an overlap
      expect(result).toBe(true);
    });

    it('returns false when the biweekly off-weeks are all the weekly fires', () => {
      // Arrange - biweekly fires Mon every other week; we only check an off-week window
      const a = makeSchedule({
        uid: 'a',
        activeStart: new Date('2024-06-03T00:00:00Z'), // anchor: week of Jun 3
        frequency: 'BIWEEKLY',
        daysOfWeek: ['MON'],
      });
      // b fires on Tue - never conflicts with a (which fires only on Mon)
      const b = makeSchedule({ uid: 'b', daysOfWeek: ['TUE'] });

      // Act
      const result = detectConflict(a, b, TZ_UTC, NOW);

      // Assert
      expect(result).toBe(false);
    });
  });

  describe('ONCE schedules', () => {
    it('detects a conflict between a ONCE and a WEEKLY schedule on the same day and time', () => {
      // Arrange
      const a = makeSchedule({
        uid: 'a',
        activeStart: new Date('2024-06-03T00:00:00Z'),
        frequency: 'ONCE',
        daysOfWeek: null,
        localStartTime: '09:00:00',
        localEndTime: '10:00:00',
      });
      const b = makeSchedule({ uid: 'b', daysOfWeek: ['MON'] }); // fires every Mon

      // Act
      const result = detectConflict(a, b, TZ_UTC, NOW);

      // Assert - Jun 3 is a Monday; both produce 09:00-10:00 UTC
      expect(result).toBe(true);
    });

    it('returns false when a ONCE schedule fires outside the other schedule', () => {
      // Arrange - ONCE fires on a Wednesday; weekly fires only on Monday
      const a = makeSchedule({
        uid: 'a',
        activeStart: new Date('2024-06-05T00:00:00Z'), // Wed Jun 5
        frequency: 'ONCE',
        daysOfWeek: null,
      });
      const b = makeSchedule({ uid: 'b', daysOfWeek: ['MON'] });

      // Act
      const result = detectConflict(a, b, TZ_UTC, NOW);

      // Assert
      expect(result).toBe(false);
    });
  });

  describe('non-overlapping active windows', () => {
    it('returns false when scheduleA ends before the check window starts', () => {
      // Arrange - a has already ended before the horizon begins
      const a = makeSchedule({
        uid: 'a',
        activeEnd: new Date('2024-05-01T00:00:00Z'), // ended in May
      });
      const b = makeSchedule({ uid: 'b' });

      // Act
      const result = detectConflict(a, b, TZ_UTC, NOW);

      // Assert - checkStart = max(a.activeStart, b.activeStart, now) = now = Jun 3;
      // a.activeEnd = May 1 <= Jun 3 → quick-exit false
      expect(result).toBe(false);
    });

    it('returns false when the two active windows do not overlap', () => {
      // Arrange - a is done before b starts
      const a = makeSchedule({
        uid: 'a',
        activeStart: new Date('2024-01-01T00:00:00Z'),
        activeEnd: new Date('2024-03-01T00:00:00Z'),
        daysOfWeek: ['MON'],
      });
      const b = makeSchedule({
        uid: 'b',
        activeStart: new Date('2024-09-01T00:00:00Z'), // well after now
        daysOfWeek: ['MON'],
      });

      // Act - checkStart = max(Jan 1, Sep 1, Jun 3) = Sep 1;
      // a.activeEnd = Mar 1 <= Sep 1 → quick-exit false
      const result = detectConflict(a, b, TZ_UTC, NOW);

      // Assert
      expect(result).toBe(false);
    });
  });

  describe('active-session edge case', () => {
    it('detects a conflict when the old schedule activeEnd is set to the active session end', () => {
      // Arrange - simulates the update-with-active-session path.
      // Old schedule closes with activeEnd = Mon 10:00 (the active session's effectiveEnd).
      // New (replacement) schedule starts at now (Mon 09:30) and fires Mon 09:30-10:30.
      // The old schedule's Mon 09:00-10:00 occurrence must still be visible (endUtc <= activeEnd).
      const oldSchedule = makeSchedule({
        uid: 'old',
        activeStart: new Date('2024-01-01T00:00:00Z'),
        activeEnd: new Date('2024-06-03T10:00:00Z'), // active session ends at 10:00
        daysOfWeek: ['MON'],
        localStartTime: '09:00:00',
        localEndTime: '10:00:00',
      });
      const newSchedule = makeSchedule({
        uid: 'new',
        activeStart: new Date('2024-06-03T09:30:00Z'), // now() = mid-session
        daysOfWeek: ['MON'],
        localStartTime: '09:30:00', // overlaps with old 09:00-10:00
        localEndTime: '10:30:00',
      });

      // Act - now = 09:30; checkStart = max(old.activeStart, new.activeStart, now) = 09:30
      // Old: Mon [09:00, 10:00]; endUtc=10:00 <= activeEnd=10:00 → included
      // New: Mon [09:30, 10:30]; startUtc=09:30 >= activeStart=09:30 → included
      // Overlap: 09:00 < 10:30 AND 09:30 < 10:00 → true
      const result = detectConflict(
        oldSchedule,
        newSchedule,
        TZ_UTC,
        new Date('2024-06-03T09:30:00Z'),
      );

      // Assert - conflict detected (the active session's slot overlaps the new schedule)
      expect(result).toBe(true);
    });

    it('does not detect a conflict when activeEnd is set to now() (the naive approach)', () => {
      // This test documents the gap that the activeEnd=effectiveEnd fix closes.
      // When activeEnd = now, the active session occurrence is filtered out
      // (endUtc=10:00 > activeEnd=09:30 fails the filter), so no conflict is returned -
      // even though the session is still running. The DB exclusion constraint catches it,
      // but the in-memory check misses it.
      const oldSchedule = makeSchedule({
        uid: 'old',
        activeStart: new Date('2024-01-01T00:00:00Z'),
        activeEnd: new Date('2024-06-03T09:30:00Z'), // set to now(), not effectiveEnd
        daysOfWeek: ['MON'],
        localStartTime: '09:00:00',
        localEndTime: '10:00:00',
      });
      const newSchedule = makeSchedule({
        uid: 'new',
        activeStart: new Date('2024-06-03T09:30:00Z'),
        daysOfWeek: ['MON'],
        localStartTime: '09:30:00', // same setup as above - would conflict if old were visible
        localEndTime: '10:30:00',
      });

      // Act
      const result = detectConflict(
        oldSchedule,
        newSchedule,
        TZ_UTC,
        new Date('2024-06-03T09:30:00Z'),
      );

      // Assert - conflict is missed - old occurrence excluded because endUtc=10:00 > activeEnd=09:30
      expect(result).toBe(false);
    });
  });
});
