import { type Static, Type } from 'typebox';

import type { ChannelDefinition } from '#src/server/shared/services/event-bus.service.js';

/**
 * Snapshot of a session's real-time connectivity, mirroring the body of the
 * `sessionStatus` server message in `@scribear/node-server-schema`. The
 * orchestrator publishes one of these whenever the upstream transcription
 * connection state or the source-device count crosses a meaningful boundary,
 * so per-connection services can fan it out to their sockets without further
 * translation.
 */
export const SESSION_STATUS_MESSAGE_SCHEMA = Type.Object({
  transcriptionServiceConnected: Type.Boolean(),
  sourceDeviceConnected: Type.Boolean(),
});
export type SessionStatusMessage = Static<typeof SESSION_STATUS_MESSAGE_SCHEMA>;

/**
 * Bus channel keyed by sessionUid. The orchestrator is the sole publisher;
 * every authenticated transcription-stream service (source or client role)
 * subscribes once after auth so newly-arriving connections start receiving
 * status changes alongside transcripts.
 */
export const SessionStatusChannel: ChannelDefinition<
  typeof SESSION_STATUS_MESSAGE_SCHEMA,
  [string]
> = {
  schema: SESSION_STATUS_MESSAGE_SCHEMA,
  key: (sessionUid) => `session-status:${sessionUid}`,
};
