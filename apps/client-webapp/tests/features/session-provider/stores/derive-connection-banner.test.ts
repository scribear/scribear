import { describe, expect, it } from 'vitest';

import { TranscriptionServiceDisconnectReason } from '@scribear/node-server-schema';

import type { SessionStatusSnapshot } from '#src/features/session-provider/services/client-session-service';
import { SessionConnectionStatus } from '#src/features/session-provider/services/client-session-service-status';
import {
  type ConnectionBanner,
  deriveConnectionBanner,
} from '#src/features/session-provider/stores/derive-connection-banner';

const SOCKET_DOWN: ConnectionBanner = {
  open: true,
  severity: 'warning',
  message: 'Connection lost. Reconnecting…',
};
const WAITING_FOR_SOURCE: ConnectionBanner = {
  open: true,
  severity: 'info',
  message: "Waiting for the room's microphone to connect.",
};
const AT_CAPACITY: ConnectionBanner = {
  open: true,
  severity: 'warning',
  message:
    'The live transcription service is at capacity. Retrying automatically…',
};
const UPSTREAM_LOST: ConnectionBanner = {
  open: true,
  severity: 'warning',
  message: 'Connection to the transcription service was lost. Reconnecting…',
};
const CLOSED: ConnectionBanner = { open: false };
const TERMINAL_FALLBACK: ConnectionBanner = {
  open: true,
  severity: 'error',
  message:
    'Disconnected from this session and unable to reconnect. Leave the session and join again with a new join code.',
};

const CONNECTION_STATUSES = [
  SessionConnectionStatus.CONNECTING,
  SessionConnectionStatus.CONNECTED,
  SessionConnectionStatus.DISCONNECTED,
  SessionConnectionStatus.TERMINAL,
] as const;

const REASONS = [
  undefined,
  TranscriptionServiceDisconnectReason.AT_CAPACITY,
] as const;

function snapshot(
  sourceDeviceConnected: boolean,
  transcriptionServiceConnected: boolean,
  reason: TranscriptionServiceDisconnectReason | undefined,
): SessionStatusSnapshot {
  return {
    sourceDeviceConnected,
    transcriptionServiceConnected,
    ...(reason !== undefined
      ? { transcriptionServiceDisconnectReason: reason }
      : {}),
  };
}

/** Every snapshot the client can hold, including "none reported yet". */
const ALL_SESSION_STATUSES: (SessionStatusSnapshot | null)[] = [
  null,
  ...[false, true].flatMap((source) =>
    [false, true].flatMap((transcription) =>
      REASONS.map((reason) => snapshot(source, transcription, reason)),
    ),
  ),
];

function caseKey(
  connectionStatus: SessionConnectionStatus,
  sessionStatus: SessionStatusSnapshot | null,
): string {
  if (sessionStatus === null) return `${connectionStatus} | no-status-yet`;
  return (
    `${connectionStatus} | source=${String(sessionStatus.sourceDeviceConnected)}` +
    ` transcription=${String(sessionStatus.transcriptionServiceConnected)}` +
    ` reason=${sessionStatus.transcriptionServiceDisconnectReason ?? 'none'}`
  );
}

/**
 * The complete input space of this pure function, written out as literals
 * rather than re-derived from the implementation: 4 connection statuses x
 * (the `sessionStatus === null` case + 2 x 2 x 2 snapshot combinations) = 36
 * rows. Spot-checking instead of pinning this table is how the "healthy idle
 * room" case shipped - a successful join with nobody streaming yet was
 * rendered as "Connection to the transcription service was lost.
 * Reconnecting…", forever, on every real room.
 *
 * The fourth input, `error`, is `null` throughout this table and covered
 * separately below: it only reaches the output through the `TERMINAL` branch,
 * and the "it changes nothing anywhere else" half of that claim is asserted
 * against this same table rather than duplicated into it.
 */
const EXPECTED: Record<string, ConnectionBanner> = {
  // Own socket down: it subsumes everything node-server might have said.
  'CONNECTING | no-status-yet': SOCKET_DOWN,
  'CONNECTING | source=false transcription=false reason=none': SOCKET_DOWN,
  'CONNECTING | source=false transcription=false reason=at-capacity':
    SOCKET_DOWN,
  'CONNECTING | source=false transcription=true reason=none': SOCKET_DOWN,
  'CONNECTING | source=false transcription=true reason=at-capacity':
    SOCKET_DOWN,
  'CONNECTING | source=true transcription=false reason=none': SOCKET_DOWN,
  'CONNECTING | source=true transcription=false reason=at-capacity':
    SOCKET_DOWN,
  'CONNECTING | source=true transcription=true reason=none': SOCKET_DOWN,
  'CONNECTING | source=true transcription=true reason=at-capacity': SOCKET_DOWN,
  'DISCONNECTED | no-status-yet': SOCKET_DOWN,
  'DISCONNECTED | source=false transcription=false reason=none': SOCKET_DOWN,
  'DISCONNECTED | source=false transcription=false reason=at-capacity':
    SOCKET_DOWN,
  'DISCONNECTED | source=false transcription=true reason=none': SOCKET_DOWN,
  'DISCONNECTED | source=false transcription=true reason=at-capacity':
    SOCKET_DOWN,
  'DISCONNECTED | source=true transcription=false reason=none': SOCKET_DOWN,
  'DISCONNECTED | source=true transcription=false reason=at-capacity':
    SOCKET_DOWN,
  'DISCONNECTED | source=true transcription=true reason=none': SOCKET_DOWN,
  'DISCONNECTED | source=true transcription=true reason=at-capacity':
    SOCKET_DOWN,

  // Own socket up, nothing reported yet: silence, not a guess.
  'CONNECTED | no-status-yet': CLOSED,

  // Own socket up, no source streaming: the normal idle state of a healthy
  // room. `transcription=false` here carries no information - node-server
  // only dials the Transcription Service once a source registers - so the
  // source flag decides, including when a stale reason is still attached.
  'CONNECTED | source=false transcription=false reason=none':
    WAITING_FOR_SOURCE,
  'CONNECTED | source=false transcription=false reason=at-capacity':
    WAITING_FOR_SOURCE,
  'CONNECTED | source=false transcription=true reason=none': WAITING_FOR_SOURCE,
  'CONNECTED | source=false transcription=true reason=at-capacity':
    WAITING_FOR_SOURCE,

  // Own socket up, a source IS streaming: now the upstream flag is a real
  // fault signal.
  'CONNECTED | source=true transcription=false reason=none': UPSTREAM_LOST,
  'CONNECTED | source=true transcription=false reason=at-capacity': AT_CAPACITY,
  'CONNECTED | source=true transcription=true reason=none': CLOSED,
  'CONNECTED | source=true transcription=true reason=at-capacity': CLOSED,

  // Terminal: nothing is retrying, so nothing node-server last said matters.
  'TERMINAL | no-status-yet': TERMINAL_FALLBACK,
  'TERMINAL | source=false transcription=false reason=none': TERMINAL_FALLBACK,
  'TERMINAL | source=false transcription=false reason=at-capacity':
    TERMINAL_FALLBACK,
  'TERMINAL | source=false transcription=true reason=none': TERMINAL_FALLBACK,
  'TERMINAL | source=false transcription=true reason=at-capacity':
    TERMINAL_FALLBACK,
  'TERMINAL | source=true transcription=false reason=none': TERMINAL_FALLBACK,
  'TERMINAL | source=true transcription=false reason=at-capacity':
    TERMINAL_FALLBACK,
  'TERMINAL | source=true transcription=true reason=none': TERMINAL_FALLBACK,
  'TERMINAL | source=true transcription=true reason=at-capacity':
    TERMINAL_FALLBACK,
};

describe('deriveConnectionBanner', () => {
  describe('full input cross-product', () => {
    const covered = new Set<string>();

    for (const connectionStatus of CONNECTION_STATUSES) {
      for (const sessionStatus of ALL_SESSION_STATUSES) {
        const key = caseKey(connectionStatus, sessionStatus);
        covered.add(key);
        it(key, () => {
          expect(
            deriveConnectionBanner(connectionStatus, sessionStatus),
          ).toEqual(EXPECTED[key]);
        });
      }
    }

    // Guards the table both ways: no input row without an expectation, and no
    // expectation row that no longer corresponds to a reachable input.
    it('has exactly one expectation per reachable input', () => {
      expect([...covered].sort()).toEqual(Object.keys(EXPECTED).sort());
      expect(covered.size).toBe(36);
    });
  });

  describe('the error message, the fourth input', () => {
    const CAUSE = 'This session refused the connection.';

    it('is what TERMINAL renders, in place of the generic fallback', () => {
      expect(
        deriveConnectionBanner(SessionConnectionStatus.TERMINAL, null, CAUSE),
      ).toEqual({ open: true, severity: 'error', message: CAUSE });
    });

    it('falls back to a generic terminal message when absent', () => {
      expect(
        deriveConnectionBanner(SessionConnectionStatus.TERMINAL, null, null),
      ).toEqual(TERMINAL_FALLBACK);
    });

    it('changes nothing in any non-terminal state', () => {
      for (const connectionStatus of CONNECTION_STATUSES) {
        if (connectionStatus === SessionConnectionStatus.TERMINAL) continue;
        for (const sessionStatus of ALL_SESSION_STATUSES) {
          expect(
            deriveConnectionBanner(connectionStatus, sessionStatus, CAUSE),
          ).toEqual(EXPECTED[caseKey(connectionStatus, sessionStatus)]);
        }
      }
    });
  });

  describe('the regression this table exists for', () => {
    it('reports a healthy idle room as informational, never as "reconnecting"', () => {
      const result = deriveConnectionBanner(
        SessionConnectionStatus.CONNECTED,
        // Exactly what node-server sends immediately after a successful join
        // to a real room with no kiosk streaming yet.
        snapshot(false, false, undefined),
      );
      expect(result).toEqual({
        open: true,
        severity: 'info',
        message: "Waiting for the room's microphone to connect.",
      });
      expect(result.open && result.message).not.toMatch(/reconnect/i);
    });
  });
});
