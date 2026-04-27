import type {
  AutoSessionWindow,
  Schedule,
  SessionInsert,
} from '#src/server/features/schedule-management/schedule-management.repository.js';

import type { AutoSessionSlot } from './auto-session-materializer.js';
import type { Occurrence } from './schedule-materializer.js';

/**
 * Builds the `SessionInsert` row for one occurrence of a SCHEDULED session.
 * Copies transcription configuration and join-code scopes from the source
 * schedule onto the session.
 */
export function buildScheduledSessionRow(
  schedule: Schedule,
  occurrence: Occurrence,
): SessionInsert {
  return {
    roomUid: schedule.roomUid,
    name: schedule.name,
    type: 'SCHEDULED',
    scheduledSessionUid: schedule.uid,
    scheduledStartTime: occurrence.startUtc,
    scheduledEndTime: occurrence.endUtc,
    joinCodeScopes: schedule.joinCodeScopes,
    transcriptionProviderId: schedule.transcriptionProviderId,
    transcriptionStreamConfig: schedule.transcriptionStreamConfig,
  };
}

/**
 * Builds the `SessionInsert` row for one auto session slot. Copies the
 * transcription config from the source window; auto sessions always have
 * empty `join_code_scopes`.
 */
export function buildAutoSessionRow(
  slot: AutoSessionSlot,
  window: AutoSessionWindow,
): SessionInsert {
  return {
    roomUid: window.roomUid,
    name: 'Auto Session',
    type: 'AUTO',
    scheduledSessionUid: null,
    scheduledStartTime: slot.startTime,
    scheduledEndTime: slot.endTime,
    joinCodeScopes: [],
    transcriptionProviderId: window.transcriptionProviderId,
    transcriptionStreamConfig: window.transcriptionStreamConfig,
  };
}
