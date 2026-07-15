import { type Static, Type } from 'typebox';

import type { ChannelDefinition } from '#src/server/shared/services/event-bus.service.js';

/**
 * Emitted whenever `rooms.room_schedule_version` is bumped (any successful
 * write to the room's schedules, auto-session windows, or sessions). Backs
 * the `schedule-changes-stream` SSE endpoint.
 */
export const RoomScheduleVersionBumpedSchema = Type.Object({
  roomUid: Type.String(),
  roomScheduleVersion: Type.Number(),
});
export type RoomScheduleVersionBumpedEvent = Static<
  typeof RoomScheduleVersionBumpedSchema
>;

export const RoomScheduleVersionBumpedChannel: ChannelDefinition<
  typeof RoomScheduleVersionBumpedSchema,
  [string]
> = {
  schema: RoomScheduleVersionBumpedSchema,
  key: (roomUid) => `room-schedule-version-bumped:${roomUid}`,
};

/**
 * Emitted whenever a session's `session_config_version` is bumped (any
 * mutation to its scheduled times, overrides, name, scopes, or transcription
 * config). Backs the `session-config-stream` SSE endpoint.
 */
export const SessionConfigVersionBumpedSchema = Type.Object({
  sessionUid: Type.String(),
  sessionConfigVersion: Type.Number(),
});
export type SessionConfigVersionBumpedEvent = Static<
  typeof SessionConfigVersionBumpedSchema
>;

export const SessionConfigVersionBumpedChannel: ChannelDefinition<
  typeof SessionConfigVersionBumpedSchema,
  [string]
> = {
  schema: SessionConfigVersionBumpedSchema,
  key: (sessionUid) => `session-config-version-bumped:${sessionUid}`,
};
