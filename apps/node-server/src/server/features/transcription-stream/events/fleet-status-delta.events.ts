import { type Static, Type } from 'typebox';

import type { ChannelDefinition } from '#src/server/shared/services/event-bus.service.js';

/**
 * A session status transition, tagged with the session it belongs to. Unlike
 * `SessionStatusChannel` (keyed by `sessionUid`, one subscriber per session:
 * the connections serving that room), this carries the identity inside the
 * message because its one subscriber - the Redis telemetry publisher, B1.7
 * §2.5 - listens across every session at once, to forward each transition to
 * `scribe:v1:events` sub-second instead of waiting for the next heartbeat.
 */
export const FLEET_STATUS_DELTA_SCHEMA = Type.Object({
  sessionUid: Type.String(),
  transcriptionServiceConnected: Type.Boolean(),
  sourceDeviceConnected: Type.Boolean(),
  sourceMicrophoneActive: Type.Optional(
    Type.Union([Type.Boolean(), Type.Null()]),
  ),
  at: Type.Integer(),
});
export type FleetStatusDelta = Static<typeof FLEET_STATUS_DELTA_SCHEMA>;

/**
 * Global bus channel (no key): every session's status transition, in
 * publish order. Kept separate from `SessionStatusChannel` rather than having
 * the publisher subscribe once per known session, since the publisher does
 * not track which sessions exist independently of the orchestrator.
 */
export const FleetStatusDeltaChannel: ChannelDefinition<
  typeof FLEET_STATUS_DELTA_SCHEMA,
  []
> = {
  schema: FLEET_STATUS_DELTA_SCHEMA,
  key: () => 'fleet-status-delta',
};
