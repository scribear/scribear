import { type Static, Type } from 'typebox';

import type { ChannelDefinition } from '#src/server/shared/services/event-bus.service.js';

/**
 * Body of the `sessionEnded` event - empty payload, the event itself is the
 * signal. Mirrors the shape of the `sessionEnded` server message in
 * `@scribear/node-server-schema` so per-connection services can fan it out
 * without translation.
 */
export const SESSION_ENDED_MESSAGE_SCHEMA = Type.Object({});
export type SessionEndedMessage = Static<typeof SESSION_ENDED_MESSAGE_SCHEMA>;

/**
 * Bus channel keyed by sessionUid. The orchestrator publishes one message
 * when a session reaches its `effectiveEnd` (or when an extension/contraction
 * arrives via the session-config long-poll and the new end time is in the
 * past). Authenticated transcription-stream services subscribe so they can
 * emit `sessionEnded` to the socket and close 1000.
 */
export const SessionEndedChannel: ChannelDefinition<
  typeof SESSION_ENDED_MESSAGE_SCHEMA,
  [string]
> = {
  schema: SESSION_ENDED_MESSAGE_SCHEMA,
  key: (sessionUid) => `session-ended:${sessionUid}`,
};
