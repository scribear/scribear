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

/** True iff `a` and `b` contain the same strings, ignoring order. */
export function sameStringArray(
  a: readonly string[],
  b: readonly string[],
): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((v, i) => v === sb[i]);
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
 *
 * NOTE (locked-in current behavior, not "fixed" here): `daysOfWeek` below is
 * compared with a plain `JSON.stringify` — order-sensitive — while
 * `joinCodeScopes` a few lines down (and the auto-window dialog's own
 * `daysOfWeek`, see `diffAutoWindowUpdate`) use the order-insensitive
 * `sameStringArray`. A same-set-but-reordered `daysOfWeek` is therefore
 * treated as "changed" here, unlike everywhere else in this file. Whether
 * that asymmetry is intended is unclear; it is preserved as-is rather than
 * "fixed" as part of a test-coverage pass.
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
  if (
    JSON.stringify(next.daysOfWeek) !== JSON.stringify(schedule.daysOfWeek)
  ) {
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
