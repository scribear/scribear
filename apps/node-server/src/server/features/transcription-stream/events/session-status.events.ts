import { type Static, Type } from 'typebox';

import type { ChannelDefinition } from '#src/server/shared/services/event-bus.service.js';

/**
 * Distinguishes *why* `transcriptionServiceConnected` is `false`, when known.
 * `AT_CAPACITY` means the Transcription Service explicitly refused the
 * connection (WebSocket close 1013, "try again later") rather than the
 * connection dropping or the service crashing - see
 * `PLAN-AdmissionControl.md` §4, "node-server must distinguish 'service
 * refused' from 'service crashed'". Mirrored in
 * `@scribear/node-server-schema`'s `sessionStatus` message; keep both in
 * sync.
 */
export enum TranscriptionServiceDisconnectReason {
  AT_CAPACITY = 'at-capacity',
}

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
  sourceMicrophoneActive: Type.Optional(
    Type.Union([Type.Boolean(), Type.Null()]),
  ),
  /**
   * Present only when `transcriptionServiceConnected` is `false` and the
   * cause is known to be capacity refusal, not e.g. a crash or network drop.
   * Optional so a client built against a Node Server that predates this
   * field still validates (same rolling-upgrade convention as the other
   * optional fields here).
   */
  transcriptionServiceDisconnectReason: Type.Optional(
    Type.Enum(TranscriptionServiceDisconnectReason),
  ),
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
