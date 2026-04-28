import { type Static, Type } from 'typebox';

import { TRANSCRIPT_FRAGMENT_SCHEMA } from '@scribear/node-server-schema';

import type { ChannelDefinition } from '#src/server/shared/services/event-bus.service.js';

/**
 * Transcript message body delivered to subscribers of {@link TranscriptChannel}.
 * Mirrors the body of the `transcript` server message in
 * `@scribear/node-server-schema` so per-connection services can fan it out
 * to clients without further translation.
 */
export const TRANSCRIPT_MESSAGE_SCHEMA = Type.Object({
  final: Type.Union([TRANSCRIPT_FRAGMENT_SCHEMA, Type.Null()]),
  inProgress: Type.Union([TRANSCRIPT_FRAGMENT_SCHEMA, Type.Null()]),
});
export type TranscriptMessage = Static<typeof TRANSCRIPT_MESSAGE_SCHEMA>;

/**
 * Bus channel keyed by sessionUid. The orchestrator publishes transcripts as
 * the upstream provider emits them; per-connection services (both source and
 * client roles) subscribe once authenticated and forward to their socket.
 *
 * Unlike the audio channel, transcript messages are JSON-serializable and a
 * future Redis-backed implementation could carry them across processes.
 */
export const TranscriptChannel: ChannelDefinition<
  typeof TRANSCRIPT_MESSAGE_SCHEMA,
  [string]
> = {
  schema: TRANSCRIPT_MESSAGE_SCHEMA,
  key: (sessionUid) => `transcript:${sessionUid}`,
};
