import type { Session } from '@scribear/session-manager-schema';

/** Computes a session's vertical position within a day column, as percentages. */
export function computeBlockPosition(
  session: Session,
  dayStartHour: number,
  dayEndHour: number,
): { topPct: number; heightPct: number } | null {
  const start = new Date(session.startOverride ?? session.scheduledStartTime);
  const endIso = session.endOverride ?? session.scheduledEndTime;
  const end = endIso ? new Date(endIso) : null;

  const dayStartMin = dayStartHour * 60;
  const dayEndMin = dayEndHour * 60;
  const totalMin = dayEndMin - dayStartMin;

  const startMin = start.getHours() * 60 + start.getMinutes();
  const endMin = end ? end.getHours() * 60 + end.getMinutes() : dayEndMin;

  const clampedStart = Math.max(startMin, dayStartMin);
  const clampedEnd = Math.min(
    endMin <= startMin ? dayEndMin : endMin,
    dayEndMin,
  ); // open-ended -> runs to day end
  if (clampedStart >= clampedEnd) return null; // entirely outside the displayed window

  return {
    topPct: ((clampedStart - dayStartMin) / totalMin) * 100,
    heightPct: ((clampedEnd - clampedStart) / totalMin) * 100,
  };
}

/**
 * True when any part of the session's displayed time range falls outside
 * `[dayStartHour, dayEndHour)` — either fully hidden or clipped by
 * `computeBlockPosition`. Mirrors that function's "open-ended runs to day
 * end" treatment, so a session with no end time isn't flagged just for
 * running to the edge of the window.
 */
export function isOutsideHourWindow(
  session: Session,
  dayStartHour: number,
  dayEndHour: number,
): boolean {
  const start = new Date(session.startOverride ?? session.scheduledStartTime);
  const endIso = session.endOverride ?? session.scheduledEndTime;
  const end = endIso ? new Date(endIso) : null;

  const dayStartMin = dayStartHour * 60;
  const dayEndMin = dayEndHour * 60;

  const startMin = start.getHours() * 60 + start.getMinutes();
  const endMin = end ? end.getHours() * 60 + end.getMinutes() : dayEndMin;
  const effectiveEndMin = endMin <= startMin ? dayEndMin : endMin;

  return startMin < dayStartMin || effectiveEndMin > dayEndMin;
}
