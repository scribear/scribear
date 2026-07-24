import type {
  AutoSessionWindow,
  SessionSchedule,
} from '@scribear/session-manager-schema';

import type { DayOfWeek, SessionScope } from '#src/lib/admin-api';

/**
 * A schedule's `activeStart` must be strictly in the future server-side, so one
 * starting today is anchored slightly ahead of now. Occurrences starting before
 * the anchor are not materialized, so keep the lead small. Windows have no such
 * rule and are anchored at midnight, which keeps today's open hours intact.
 */
export const START_LEAD_MS = 30_000;

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** Formats a Date as a browser-local `type="date"` input value. */
export function dateToInput(d: Date): string {
  return `${String(d.getFullYear())}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/**
 * Parses a `type="date"` input value as browser-local midnight. Avoids
 * `new Date(value)`, which reads bare `yyyy-mm-dd` as UTC.
 */
export function dateInputToLocalMidnight(value: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (m === null) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) ? null : d;
}

function hhmm(localTime: string): string {
  return localTime.slice(0, 5);
}

export function describeSchedule(s: SessionSchedule): string {
  const days =
    s.daysOfWeek === null || s.daysOfWeek.length === 0
      ? ''
      : ` ${s.daysOfWeek.join(', ')}`;
  return `${s.name} — ${s.frequency}${days} ${hhmm(s.localStartTime)}–${hhmm(s.localEndTime)}`;
}

export function describeWindow(w: AutoSessionWindow): string {
  return `${w.daysOfWeek.join(', ')} ${hhmm(w.localStartTime)}–${hhmm(w.localEndTime)}`;
}

/** Fields the schedule form and the window form have in common. */
export interface CommonFormState {
  daysOfWeek: DayOfWeek[];
  localStartTime: string;
  localEndTime: string;
  startsOn: string;
  indefinite: boolean;
  endsOn: string;
  joinCodeScopes: SessionScope[];
  transcriptionProviderId: string;
  transcriptionStreamConfig: string;
}

export type RangeResult =
  | { ok: true; activeStart: string; activeEnd: string | null }
  | { ok: false; error: string };

/**
 * Turns the two date inputs into the ISO instants the API wants.
 * `anchorToFuture` covers the schedule endpoint's strictly-in-the-future rule.
 */
export function resolveActiveRange(
  form: CommonFormState,
  anchorToFuture: boolean,
): RangeResult {
  const startDay = dateInputToLocalMidnight(form.startsOn);
  if (startDay === null)
    return { ok: false, error: 'Enter a valid start date.' };

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  if (startDay.getTime() < todayStart.getTime()) {
    return { ok: false, error: 'The start date must be today or later.' };
  }

  const activeStartMs = anchorToFuture
    ? Math.max(startDay.getTime(), Date.now() + START_LEAD_MS)
    : startDay.getTime();

  if (form.indefinite) {
    return {
      ok: true,
      activeStart: new Date(activeStartMs).toISOString(),
      activeEnd: null,
    };
  }

  const endDay = dateInputToLocalMidnight(form.endsOn);
  if (endDay === null) {
    return {
      ok: false,
      error: 'Enter a valid end date, or tick "No end date".',
    };
  }
  // Inclusive: occurrences on the end date itself still materialize.
  endDay.setHours(23, 59, 59, 999);
  if (endDay.getTime() <= activeStartMs) {
    return { ok: false, error: 'The end date must be after the start date.' };
  }
  return {
    ok: true,
    activeStart: new Date(activeStartMs).toISOString(),
    activeEnd: endDay.toISOString(),
  };
}
