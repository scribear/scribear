import { type Static, Type } from 'typebox';

import { LatencyKind } from '@scribear/node-server-schema';

import type { ChannelDefinition } from '#src/server/shared/services/event-bus.service.js';

/**
 * Latency sample delivered to subscribers of {@link LatencyChannel}. Mirrors
 * the body of the `latencyUpdate` server message in
 * `@scribear/node-server-schema` so per-connection services can fan it out to
 * clients without further translation.
 *
 * `pipelineMs` is measured entirely on the node's monotonic clock (audio
 * ingress -> transcript received) and is therefore immune to client/server
 * clock skew. `e2eMs` additionally includes the capture and uplink legs using
 * the source's clock corrected via time-sync, and is null when no reliable
 * offset is available.
 */
export const LATENCY_MESSAGE_SCHEMA = Type.Object({
  kind: Type.Enum(LatencyKind),
  pipelineMs: Type.Number(),
  e2eMs: Type.Union([Type.Number(), Type.Null()]),
});
export type LatencyMessage = Static<typeof LATENCY_MESSAGE_SCHEMA>;

/**
 * Bus channel keyed by sessionUid. The orchestrator publishes a sample each
 * time it correlates a transcript back to the audio frame that produced it;
 * per-connection services subscribe once authenticated and forward to their
 * socket.
 */
export const LatencyChannel: ChannelDefinition<
  typeof LATENCY_MESSAGE_SCHEMA,
  [string]
> = {
  schema: LATENCY_MESSAGE_SCHEMA,
  key: (sessionUid) => `latency:${sessionUid}`,
};
