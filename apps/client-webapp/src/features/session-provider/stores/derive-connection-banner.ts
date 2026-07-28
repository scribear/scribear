import type { ConnectionStatusSeverity } from '@scribear/core-ui';
import { TranscriptionServiceDisconnectReason } from '@scribear/node-server-schema';

import type { RootState } from '#src/store/store';

import type { SessionStatusSnapshot } from '../services/client-session-service';
import { SessionConnectionStatus } from '../services/client-session-service-status';
import { selectSession } from './client-session-service-slice';

/**
 * What {@link ConnectionStatusBanner} (mounted in `root.tsx`) should render,
 * derived from the two independent connection concerns the client tracks:
 * the client's own WebSocket to node-server (`connectionStatus`), and
 * node-server's own upstream link to the Transcription Service
 * (`sessionStatus.transcriptionServiceConnected`).
 */
export type ConnectionBanner =
  | { open: false }
  | { open: true; severity: ConnectionStatusSeverity; message: string };

/**
 * Pure derivation of the connection-status banner shown to the user.
 *
 * Priority (most severe/explanatory first):
 * 1. The client's own socket to node-server isn't `CONNECTED` (it's
 *    `CONNECTING` or `DISCONNECTED`). This subsumes whatever node-server's
 *    upstream state was - there's no live channel to have learned it over -
 *    so the nested transcription-service state is deliberately not reported
 *    alongside it.
 * 2. The client's socket is fine, but the last known `sessionStatus` says
 *    node-server's link to the Transcription Service is down. If the reason
 *    is known to be admission control (`AT_CAPACITY`), say so specifically;
 *    otherwise use a generic "lost the upstream connection" message.
 * 3. Otherwise, nothing to report - the banner is unmounted.
 *
 * Every branch here is a retrying/transient state (the client and
 * node-server both keep retrying automatically), matching this feature's
 * "wrong refusal is worse than wrong admission" / fail-open philosophy
 * elsewhere in admission control - so severity is always `'warning'`, never
 * `'error'`. There is currently no modeled terminal/unrecoverable connection
 * state in this service for the socket-drop case (an unrecoverable *session*
 * failure, e.g. an expired refresh token, instead routes through
 * `JoinError`/`leaveSession` and drops the user back to `IDLE`, off this
 * banner's `ACTIVE`-only concern entirely) - if one is added later, that's
 * the natural place for an `'error'` branch here.
 */
export function deriveConnectionBanner(
  connectionStatus: SessionConnectionStatus,
  sessionStatus: SessionStatusSnapshot | null,
): ConnectionBanner {
  if (connectionStatus !== SessionConnectionStatus.CONNECTED) {
    return {
      open: true,
      severity: 'warning',
      message: 'Connection lost. Reconnecting…',
    };
  }

  if (sessionStatus !== null && !sessionStatus.transcriptionServiceConnected) {
    if (
      sessionStatus.transcriptionServiceDisconnectReason ===
      TranscriptionServiceDisconnectReason.AT_CAPACITY
    ) {
      return {
        open: true,
        severity: 'warning',
        message:
          'The live transcription service is at capacity. Retrying automatically…',
      };
    }
    return {
      open: true,
      severity: 'warning',
      message:
        'Connection to the transcription service was lost. Reconnecting…',
    };
  }

  return { open: false };
}

/**
 * Selector wrapping {@link deriveConnectionBanner} for the current session
 * state. Returns `{ open: false }` whenever there's no active session (the
 * banner only makes sense during {@link ClientLifecycle.ACTIVE}).
 */
export const selectConnectionBanner = (state: RootState): ConnectionBanner => {
  const session = selectSession(state);
  if (session === null) return { open: false };
  return deriveConnectionBanner(
    session.connectionStatus,
    session.sessionStatus,
  );
};
