import { Type } from 'typebox';

import type { ChannelDefinition } from '#src/server/shared/services/event-bus.service.js';

/**
 * In-process channel carrying raw PCM-or-encoded audio frames from a session
 * source connection to the transcription orchestrator.
 *
 * Frames are passed by reference as `Buffer` instances with no serialization,
 * so this channel is intrinsically single-process. The transcription-stream
 * feature relies on sticky URL routing (sessionUid in the WS path) to keep
 * audio traffic on a single Node Server instance, which is exactly the case
 * the in-process bus handles natively.
 */
export const AUDIO_FRAME_SCHEMA = Type.Unsafe<Buffer>(Type.Any());

/**
 * Bus channel keyed by sessionUid. Per-connection source services publish
 * audio frames here; the orchestrator subscribes once per active session and
 * forwards frames to the upstream transcription provider WebSocket.
 */
export const AudioFrameChannel: ChannelDefinition<
  typeof AUDIO_FRAME_SCHEMA,
  [string]
> = {
  schema: AUDIO_FRAME_SCHEMA,
  key: (sessionUid) => `audio-frame:${sessionUid}`,
};
