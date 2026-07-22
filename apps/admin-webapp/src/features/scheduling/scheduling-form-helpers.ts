import type { DayOfWeek, SessionScope } from '#src/lib/admin-api';
import { ApiError } from '#src/lib/api-error';

export const DAYS_OF_WEEK: readonly DayOfWeek[] = [
  'SUN',
  'MON',
  'TUE',
  'WED',
  'THU',
  'FRI',
  'SAT',
];
export const SCOPES: readonly SessionScope[] = [
  'SEND_AUDIO',
  'RECEIVE_TRANSCRIPTIONS',
];

export function errorMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

export function formatInRoomTz(iso: string, timezone: string): string {
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date(iso));
  } catch {
    return new Date(iso).toLocaleString();
  }
}

/** Converts a `datetime-local` input value to an ISO instant, or null if empty. */
export function localInputToIso(value: string): string | null {
  if (value === '') return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

/** Converts an ISO instant to a `datetime-local` input value (browser-local). */
export function isoToLocalInput(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  const year = String(d.getFullYear());
  return `${year}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function sameStringArray(
  a: readonly string[],
  b: readonly string[],
): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((v, i) => v === sb[i]);
}
