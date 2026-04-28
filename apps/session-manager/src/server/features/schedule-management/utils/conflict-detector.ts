import { materializeSchedule } from './schedule-materializer.js';
import type { ScheduleForMaterialization } from './schedule-materializer.js';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Returns true if two schedules in the same room produce overlapping sessions.
 *
 * Expands both schedules over a [checkStart, checkStart + horizonDays] window
 * where checkStart = max(scheduleA.activeStart, scheduleB.activeStart, now).
 * Two weeks covers the worst-case first-overlap bound for ONCE, WEEKLY, and
 * BIWEEKLY frequencies.
 *
 * When a schedule has an active session during an update, the caller sets its
 * activeEnd to that session's effectiveEnd (not now()), so this function
 * correctly includes that session's occurrence in the expansion and detects
 * any overlap with the incoming schedule.
 */
export function detectConflict(
  scheduleA: ScheduleForMaterialization,
  scheduleB: ScheduleForMaterialization,
  timezone: string,
  now: Date,
  horizonDays = 14,
): boolean {
  const checkStart = new Date(
    Math.max(
      scheduleA.activeStart.getTime(),
      scheduleB.activeStart.getTime(),
      now.getTime(),
    ),
  );
  const checkEnd = new Date(checkStart.getTime() + horizonDays * MS_PER_DAY);

  // Quick exit: a schedule whose active window ends before checkStart produces nothing.
  if (scheduleA.activeEnd && scheduleA.activeEnd <= checkStart) return false;
  if (scheduleB.activeEnd && scheduleB.activeEnd <= checkStart) return false;

  const occurrencesA = materializeSchedule(
    scheduleA,
    timezone,
    checkStart,
    checkEnd,
  );
  const occurrencesB = materializeSchedule(
    scheduleB,
    timezone,
    checkStart,
    checkEnd,
  );

  for (const a of occurrencesA) {
    for (const b of occurrencesB) {
      if (a.startUtc < b.endUtc && b.startUtc < a.endUtc) return true;
    }
  }

  return false;
}
