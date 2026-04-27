import type { AutoSessionWindow } from '#src/server/features/schedule-management/schedule-management.repository.js';

import { materializeSchedule } from './schedule-materializer.js';

export interface WindowOccurrence {
  windowUid: string;
  startUtc: Date;
  endUtc: Date;
}

/**
 * Expands an auto session window's local-time-of-day pattern into UTC daily
 * ranges within `[from, to)`. A window is conceptually a WEEKLY session
 * schedule with no per-occurrence configuration, so this delegates to
 * `materializeSchedule` with a synthetic schedule record. DST wrap and gap
 * handling come along for free.
 */
export function materializeWindow(
  window: AutoSessionWindow,
  timezone: string,
  from: Date,
  to: Date,
): WindowOccurrence[] {
  const occurrences = materializeSchedule(
    {
      uid: window.uid,
      activeStart: window.activeStart,
      activeEnd: window.activeEnd,
      localStartTime: window.localStartTime,
      localEndTime: window.localEndTime,
      frequency: 'WEEKLY',
      daysOfWeek: window.daysOfWeek,
    },
    timezone,
    from,
    to,
  );
  return occurrences.map((o) => ({
    windowUid: window.uid,
    startUtc: o.startUtc,
    endUtc: o.endUtc,
  }));
}
