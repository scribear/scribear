import type {
  AutoSessionWindow,
  SessionSchedule,
} from '@scribear/session-manager-schema';

import type {
  DayOfWeek,
  ScheduleFrequency,
  SessionScope,
  UpdateAutoWindowBody,
  UpdateScheduleBody,
} from '#src/lib/admin-api';

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

/** `sameStringArray`, but `null` is only equal to `null` (never to an empty
 * array) — for the one field, `ScheduleDialog`'s `daysOfWeek`, that can be
 * absent entirely rather than just empty. */
export function sameDaysOfWeek(
  a: readonly string[] | null,
  b: readonly string[] | null,
): boolean {
  if (a === null || b === null) return a === b;
  return sameStringArray(a, b);
}

/** The schedule dialog's fully-resolved next-state values: validation and
 * JSON-parsing of the raw form have already happened in the caller. */
export interface ResolvedScheduleFields {
  name: string;
  activeStart: string;
  activeEnd: string | null;
  localStartTime: string;
  localEndTime: string;
  frequency: ScheduleFrequency;
  daysOfWeek: DayOfWeek[] | null;
  joinCodeScopes: SessionScope[];
  transcriptionProviderId: string;
  transcriptionStreamConfig: unknown;
}

/**
 * Diffs the resolved next-state fields against the loaded schedule and
 * returns only the changed ones, for a PATCH-shaped update body.
 */
export function diffScheduleUpdate(
  schedule: SessionSchedule,
  next: ResolvedScheduleFields,
): Omit<UpdateScheduleBody, 'scheduleUid'> {
  const body: Omit<UpdateScheduleBody, 'scheduleUid'> = {};
  if (next.name !== schedule.name) body.name = next.name;
  if (next.activeStart !== schedule.activeStart) {
    body.activeStart = next.activeStart;
  }
  if (next.activeEnd !== schedule.activeEnd) body.activeEnd = next.activeEnd;
  if (next.localStartTime !== schedule.localStartTime.slice(0, 5)) {
    body.localStartTime = next.localStartTime;
  }
  if (next.localEndTime !== schedule.localEndTime.slice(0, 5)) {
    body.localEndTime = next.localEndTime;
  }
  if (next.frequency !== schedule.frequency) body.frequency = next.frequency;
  if (!sameDaysOfWeek(next.daysOfWeek, schedule.daysOfWeek)) {
    body.daysOfWeek = next.daysOfWeek;
  }
  if (!sameStringArray(next.joinCodeScopes, schedule.joinCodeScopes)) {
    body.joinCodeScopes = next.joinCodeScopes;
  }
  if (
    next.transcriptionProviderId !== (schedule.transcriptionProviderId ?? '')
  ) {
    body.transcriptionProviderId = next.transcriptionProviderId;
  }
  if (
    JSON.stringify(next.transcriptionStreamConfig) !==
    JSON.stringify(schedule.transcriptionStreamConfig ?? {})
  ) {
    body.transcriptionStreamConfig = next.transcriptionStreamConfig;
  }
  return body;
}

/** The auto-window dialog's fully-resolved next-state values: validation and
 * JSON-parsing of the raw form have already happened in the caller. */
export interface ResolvedAutoWindowFields {
  localStartTime: string;
  localEndTime: string;
  daysOfWeek: DayOfWeek[];
  activeStart: string;
  activeEnd: string | null;
  joinCodeScopes: SessionScope[];
  transcriptionProviderId: string;
  transcriptionStreamConfig: unknown;
}

/**
 * Diffs the resolved next-state fields against the loaded auto-session
 * window and returns only the changed ones, for a PATCH-shaped update body.
 */
export function diffAutoWindowUpdate(
  autoWindow: AutoSessionWindow,
  next: ResolvedAutoWindowFields,
): Omit<UpdateAutoWindowBody, 'windowUid'> {
  const body: Omit<UpdateAutoWindowBody, 'windowUid'> = {};
  if (next.localStartTime !== autoWindow.localStartTime.slice(0, 5)) {
    body.localStartTime = next.localStartTime;
  }
  if (next.localEndTime !== autoWindow.localEndTime.slice(0, 5)) {
    body.localEndTime = next.localEndTime;
  }
  if (!sameStringArray(next.daysOfWeek, autoWindow.daysOfWeek)) {
    body.daysOfWeek = next.daysOfWeek;
  }
  if (next.activeStart !== autoWindow.activeStart) {
    body.activeStart = next.activeStart;
  }
  if (next.activeEnd !== autoWindow.activeEnd) body.activeEnd = next.activeEnd;
  if (!sameStringArray(next.joinCodeScopes, autoWindow.joinCodeScopes)) {
    body.joinCodeScopes = next.joinCodeScopes;
  }
  if (next.transcriptionProviderId !== autoWindow.transcriptionProviderId) {
    body.transcriptionProviderId = next.transcriptionProviderId;
  }
  if (
    JSON.stringify(next.transcriptionStreamConfig) !==
    JSON.stringify(autoWindow.transcriptionStreamConfig)
  ) {
    body.transcriptionStreamConfig = next.transcriptionStreamConfig;
  }
  return body;
}
