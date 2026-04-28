import { DateTime } from 'luxon';

export interface ScheduleForMaterialization {
  uid: string;
  activeStart: Date;
  activeEnd: Date | null;
  /**
   * BIWEEKLY parity reference. Set on creation to the original `activeStart`
   * and preserved verbatim across updates so that updates never shift the
   * cadence. Unused for ONCE/WEEKLY but still required to keep callers honest.
   */
  anchorStart: Date;
  // Wall-clock time in the room's timezone: "HH:MM" or "HH:MM:SS".
  localStartTime: string;
  // Wall-clock time in the room's timezone: "HH:MM" or "HH:MM:SS".
  localEndTime: string;
  frequency: 'ONCE' | 'WEEKLY' | 'BIWEEKLY';
  // Required for WEEKLY and BIWEEKLY; null for ONCE.
  daysOfWeek: string[] | null;
}

export interface Occurrence {
  scheduleUid: string;
  startUtc: Date;
  endUtc: Date;
}

const DOW_TO_LUXON: Record<string, number> = {
  MON: 1,
  TUE: 2,
  WED: 3,
  THU: 4,
  FRI: 5,
  SAT: 6,
  SUN: 7,
};

const MS_PER_WEEK = 7 * 24 * 60 * 60 * 1000;

/**
 * Expands a schedule's occurrences within [windowStart, windowEnd).
 *
 * Handles all DST edge cases:
 * - Spring-forward: times in the skipped interval snap to the first valid instant.
 *   Occurrences whose entire span falls in the gap are dropped.
 * - Fall-back: picks the later (standard-time) UTC instant for ambiguous times.
 */
export function materializeSchedule(
  schedule: ScheduleForMaterialization,
  timezone: string,
  windowStart: Date,
  windowEnd: Date,
): Occurrence[] {
  const effectiveStart = new Date(
    Math.max(schedule.activeStart.getTime(), windowStart.getTime()),
  );
  const effectiveEnd = schedule.activeEnd
    ? new Date(Math.min(schedule.activeEnd.getTime(), windowEnd.getTime()))
    : windowEnd;

  if (effectiveStart >= effectiveEnd) return [];

  const [startH, startM, startS] = parseTime(schedule.localStartTime);
  const [endH, endM, endS] = parseTime(schedule.localEndTime);
  const wraps =
    timeToSeconds(schedule.localEndTime) <
    timeToSeconds(schedule.localStartTime);

  const activeStartDt = DateTime.fromJSDate(schedule.activeStart, {
    zone: timezone,
  });

  if (schedule.frequency === 'ONCE') {
    const candidate = activeStartDt.startOf('day');
    const occ = buildOccurrence(
      schedule.uid,
      candidate,
      startH,
      startM,
      startS,
      endH,
      endM,
      endS,
      wraps,
      timezone,
    );
    if (occ && inRange(occ, schedule, windowStart, windowEnd)) return [occ];
    return [];
  }

  const anchorWeekStart = DateTime.fromJSDate(schedule.anchorStart, {
    zone: timezone,
  }).startOf('week');
  const qualifyingWeekdays = new Set(
    (schedule.daysOfWeek ?? []).map((d) => DOW_TO_LUXON[d]),
  );

  // Start one day early to catch midnight-wrap occurrences whose start falls
  // before effectiveStart but whose end falls within the window.
  const startDt = DateTime.fromJSDate(effectiveStart, { zone: timezone });
  let cursor = startDt.startOf('day').minus({ days: wraps ? 1 : 0 });
  const stopDt = DateTime.fromJSDate(effectiveEnd, { zone: timezone })
    .startOf('day')
    .plus({ days: 1 });

  const occurrences: Occurrence[] = [];

  while (cursor <= stopDt) {
    if (qualifyingWeekdays.has(cursor.weekday)) {
      const weeksFromAnchor = weeksBetween(
        anchorWeekStart,
        cursor.startOf('week'),
      );
      const biweeklyOk =
        schedule.frequency === 'WEEKLY' || weeksFromAnchor % 2 === 0;

      if (biweeklyOk) {
        const occ = buildOccurrence(
          schedule.uid,
          cursor,
          startH,
          startM,
          startS,
          endH,
          endM,
          endS,
          wraps,
          timezone,
        );
        if (occ && inRange(occ, schedule, windowStart, windowEnd))
          occurrences.push(occ);
      }
    }
    cursor = cursor.plus({ days: 1 });
  }

  return occurrences;
}

function buildOccurrence(
  scheduleUid: string,
  date: DateTime,
  startH: number,
  startM: number,
  startS: number,
  endH: number,
  endM: number,
  endS: number,
  wraps: boolean,
  zone: string,
): Occurrence | null {
  const startDt = localToUtc(
    date.year,
    date.month,
    date.day,
    startH,
    startM,
    startS,
    zone,
  );
  const endDate = wraps ? date.plus({ days: 1 }) : date;
  const endDt = localToUtc(
    endDate.year,
    endDate.month,
    endDate.day,
    endH,
    endM,
    endS,
    zone,
  );

  // Both endpoints snapped to the same instant: entire occurrence was in the gap.
  if (startDt.toMillis() >= endDt.toMillis()) return null;

  return {
    scheduleUid,
    startUtc: startDt.toJSDate(),
    endUtc: endDt.toJSDate(),
  };
}

function inRange(
  occ: Occurrence,
  schedule: ScheduleForMaterialization,
  windowStart: Date,
  windowEnd: Date,
): boolean {
  if (occ.startUtc < schedule.activeStart) return false;
  if (schedule.activeEnd && occ.endUtc > schedule.activeEnd) return false;
  // Occurrence must overlap the window: end after windowStart AND start before windowEnd.
  if (occ.endUtc <= windowStart) return false;
  if (occ.startUtc >= windowEnd) return false;
  return true;
}

/**
 * Converts a local wall-clock time on a specific date to a UTC DateTime.
 *
 * Spring-forward: if the requested local time falls in the skipped interval,
 * Luxon returns a DateTime whose local time differs from what was requested
 * (it uses the pre-transition offset, producing a post-transition wall-clock
 * time). We detect the mismatch and binary-search for the true transition
 * instant — the first UTC moment with the post-transition offset — which is
 * the correct snap point.
 *
 * Fall-back: Luxon may return the DST (earlier UTC) interpretation for an
 * ambiguous local time. We detect this by checking whether adding the DST
 * offset difference (60 min for most zones, 30 min for Lord Howe Island)
 * yields the same wall-clock time, and if so, return the later instant.
 */
function localToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  zone: string,
): DateTime {
  const dt = DateTime.fromObject(
    { year, month, day, hour, minute, second, millisecond: 0 },
    { zone },
  );

  if (dt.hour !== hour || dt.minute !== minute || dt.second !== second) {
    return findSpringForwardSnap(year, month, day, zone, dt);
  }

  if (dt.isInDST) {
    for (const offsetMinutes of [60, 30]) {
      const later = dt.plus({ minutes: offsetMinutes });
      if (
        later.hour === hour &&
        later.minute === minute &&
        later.second === second
      ) {
        return later;
      }
    }
  }

  return dt;
}

/**
 * Binary-searches for the first UTC instant that carries the post-spring-forward
 * zone offset, which is the snap point for times in the DST gap.
 */
function findSpringForwardSnap(
  year: number,
  month: number,
  day: number,
  zone: string,
  snappedDt: DateTime,
): DateTime {
  const postOffset = snappedDt.offset;

  let lo = DateTime.fromObject(
    { year, month, day, hour: 0, minute: 0, second: 0, millisecond: 0 },
    { zone },
  ).toUTC();
  let hi = snappedDt.toUTC();

  while (hi.toMillis() - lo.toMillis() > 1) {
    const midMs = Math.floor((lo.toMillis() + hi.toMillis()) / 2);
    const mid = DateTime.fromMillis(midMs, { zone: 'UTC' });
    if (mid.setZone(zone).offset === postOffset) {
      hi = mid;
    } else {
      lo = mid;
    }
  }

  return hi.setZone(zone);
}

function parseTime(timeStr: string): [number, number, number] {
  const parts = timeStr.split(':').map(Number);
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
}

function timeToSeconds(timeStr: string): number {
  const [h, m, s] = parseTime(timeStr);
  return h * 3600 + m * 60 + s;
}

function weeksBetween(a: DateTime, b: DateTime): number {
  return Math.round(
    (b.startOf('week').toMillis() - a.startOf('week').toMillis()) / MS_PER_WEEK,
  );
}
