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
 * The shortest session worth creating, and therefore the floor below which a
 * *clipped* occurrence is discarded rather than materialized.
 *
 * Exported because the AUTO slot materializer applies the same floor to the
 * gaps it fills; one constant keeps a clipped occurrence and an AUTO slot
 * agreeing on what "too short to be worth creating" means.
 *
 * Sixty seconds is not arbitrary: join codes are handed over in a 60 s window
 * (`session-auth`), so a session shorter than this cannot reliably be joined
 * even by a client that is already waiting for it.
 */
export const MIN_SESSION_DURATION_SECONDS = 60;

const MIN_SESSION_DURATION_MS = MIN_SESSION_DURATION_SECONDS * 1000;

/**
 * Expands a schedule's occurrences within [windowStart, windowEnd).
 *
 * Occurrences are *clipped* to the schedule's `[activeStart, activeEnd]`
 * range rather than dropped when they straddle either end - see
 * {@link clipToActiveRange}.
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
    const admitted = occ ? admit(occ, schedule, windowStart, windowEnd) : null;
    return admitted ? [admitted] : [];
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
        const admitted = occ
          ? admit(occ, schedule, windowStart, windowEnd)
          : null;
        if (admitted) occurrences.push(admitted);
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

/**
 * Clips an occurrence to the schedule's active range, then tests it against
 * the caller's materialization window.
 *
 * @returns the occurrence to materialize (clipped if it straddled either end
 * of the active range), or `null` if nothing usable remains.
 */
function admit(
  occ: Occurrence,
  schedule: ScheduleForMaterialization,
  windowStart: Date,
  windowEnd: Date,
): Occurrence | null {
  const clipped = clipToActiveRange(occ, schedule);
  if (!clipped) return null;
  // Occurrence must overlap the window: end after windowStart AND start before windowEnd.
  if (clipped.endUtc <= windowStart) return null;
  if (clipped.startUtc >= windowEnd) return null;
  return clipped;
}

/**
 * Trims an occurrence to `[activeStart, activeEnd]`.
 *
 * Both ends used to *drop* an occurrence that straddled them, which read as a
 * safe conservative choice and is not: the shape the admin console creates is
 * a daily `00:00-23:59` window, so every occurrence straddles both ends of any
 * active range that does not begin at midnight and finish at 23:59. "Auto
 * sessions every day, until 30 minutes from now" therefore materialized
 * *nothing*, and narrowing a live window ended the running session
 * immediately instead of at the requested instant. `activeStart` had the
 * mirror-image failure: a window starting "now" produced its first session
 * only on the next local day.
 *
 * Clipping is what the field names imply ("active *between* these instants")
 * and what `materializeAutoSessions` already does when it fills a window
 * around a blocking session. Clipping happens on absolute UTC instants, so a
 * DST-adjusted occurrence keeps whichever instants `buildOccurrence` resolved.
 *
 * The floor applies only when the occurrence was actually clipped: a residue
 * shorter than {@link MIN_SESSION_DURATION_SECONDS} is an artefact of the
 * operator's boundary rather than something they asked for, and materializing
 * it would insert a session nobody can join - or, at exactly zero length, one
 * the `sessions_scheduled_end_after_start` CHECK rejects, turning the write
 * into a 500. An *unclipped* occurrence is the operator's explicit request and
 * keeps its existing treatment, so this cannot retroactively invalidate a
 * short schedule that materializes today.
 *
 * The floor is enforced here rather than in the callers because SCHEDULED
 * occurrences go straight to `insertSessions` with no other length check;
 * AUTO window occurrences pass through `materializeAutoSessions`, which
 * already applies the same floor to every slot it emits.
 */
function clipToActiveRange(
  occ: Occurrence,
  schedule: ScheduleForMaterialization,
): Occurrence | null {
  const startMs = Math.max(
    occ.startUtc.getTime(),
    schedule.activeStart.getTime(),
  );
  const endMs = schedule.activeEnd
    ? Math.min(occ.endUtc.getTime(), schedule.activeEnd.getTime())
    : occ.endUtc.getTime();

  if (
    startMs === occ.startUtc.getTime() &&
    endMs === occ.endUtc.getTime() &&
    startMs < endMs
  ) {
    return occ;
  }

  if (endMs - startMs < MIN_SESSION_DURATION_MS) return null;

  return {
    scheduleUid: occ.scheduleUid,
    startUtc: new Date(startMs),
    endUtc: new Date(endMs),
  };
}

/**
 * Converts a local wall-clock time on a specific date to a UTC DateTime.
 *
 * Spring-forward: if the requested local time falls in the skipped interval,
 * Luxon returns a DateTime whose local time differs from what was requested
 * (it uses the pre-transition offset, producing a post-transition wall-clock
 * time). We detect the mismatch and binary-search for the true transition
 * instant - the first UTC moment with the post-transition offset - which is
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
