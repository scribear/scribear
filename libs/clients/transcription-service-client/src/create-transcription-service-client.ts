import {
  type WebSocketClientFactory,
  createWebSocketClient,
} from '@scribear/base-websocket-client';
import {
  TRANSCRIPTION_STREAM_ROUTE,
  TRANSCRIPTION_STREAM_SCHEMA,
} from '@scribear/transcription-service-schema';

import { createProbesClient } from './probes-client.js';

interface TranscriptionServiceClient {
  probes: ReturnType<typeof createProbesClient>;
  transcriptionStream: WebSocketClientFactory<
    typeof TRANSCRIPTION_STREAM_SCHEMA
  >;
}

/**
 * Reconnect backoff for `transcriptionStream` connections, baked in here so
 * every consumer of this client gets the same deliberate policy rather than
 * inheriting `WebSocketClient`'s bare defaults by accident.
 *
 * Per `archived-plans/2026-07-27-02-PLAN-AdmissionControl.md` §4: close 1013
 * ("try again later") is how the transcription service now refuses a session
 * for being at capacity.
 * 1013 is deliberately NOT added to `normalCloseCodes` - capacity is
 * transient (it frees up as other sessions end), so the right behavior is to
 * keep retrying, not give up. But "keep retrying forever" needs a policy
 * chosen on purpose, not the library's catch-all default applied to a code
 * nobody was thinking about when that default was written. These values
 * happen to equal `WebSocketClient`'s own defaults - the point of writing
 * them out is that they are now a conscious choice, reviewed and pinned
 * here, not an inherited default:
 *   - `initialMs: 1000` - a refusal has a reasonable chance of resolving in a
 *     few seconds (another session ending), so the first retry shouldn't
 *     make a caption gap worse than it has to be.
 *   - `maxMs: 30_000` - caps the delay so a session that stays over capacity
 *     for a while still gets a retry roughly every 30s, without hammering an
 *     already-saturated worker pool.
 *   - `factor: 2`, `jitterPct: 0.3` - standard exponential ramp with jitter,
 *     so many sessions refused by the same capacity event don't all retry in
 *     lockstep and re-trigger the same refusal together.
 */
const TRANSCRIPTION_STREAM_BACKOFF = {
  initialMs: 1000,
  maxMs: 30_000,
  factor: 2,
  jitterPct: 0.3,
};

/**
 * Creates a typed client bundle for the transcription service.
 *
 * HTTP routes (e.g. probes) are exposed as fetch functions from
 * `createEndpointClient`. WebSocket routes are exposed as
 * {@link WebSocketClientFactory}s that produce an independent
 * {@link WebSocketClient} instance per call, allowing multiple concurrent
 * connections to the same route without sharing client state.
 *
 * @param baseUrl Base URL of the transcription service. HTTP schemes are
 *   translated to ws/wss when each WebSocket connection is established.
 */
function createTranscriptionServiceClient(
  baseUrl: string,
): TranscriptionServiceClient {
  return {
    probes: createProbesClient(baseUrl),
    transcriptionStream: createWebSocketClient(
      TRANSCRIPTION_STREAM_SCHEMA,
      TRANSCRIPTION_STREAM_ROUTE,
      baseUrl,
      { backoff: TRANSCRIPTION_STREAM_BACKOFF },
    ),
  };
}

export { createTranscriptionServiceClient };
export type { TranscriptionServiceClient };
