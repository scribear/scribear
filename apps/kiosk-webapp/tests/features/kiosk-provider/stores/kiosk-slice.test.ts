import { describe, expect } from 'vitest';

import { TranscriptionServiceDisconnectReason } from '@scribear/node-server-schema';

import type { SessionStatusSnapshot } from '#src/features/kiosk-provider/services/kiosk-service';
import { SessionConnectionStatus } from '#src/features/kiosk-provider/services/kiosk-service-status';
import {
  deriveConnectionBanner,
  kioskReducer,
  setActiveSession,
  setSessionStatus,
} from '#src/features/kiosk-provider/stores/kiosk-slice';

function statusSnapshot(
  overrides: Partial<SessionStatusSnapshot> = {},
): SessionStatusSnapshot {
  return {
    transcriptionServiceConnected: true,
    sourceDeviceConnected: true,
    ...overrides,
  };
}

describe('deriveConnectionBanner', (it) => {
  it('is closed when there is no active session', () => {
    expect(deriveConnectionBanner(null, null)).toEqual({ open: false });
  });

  it('warns "Connection lost" while the kiosk socket is CONNECTING', () => {
    expect(
      deriveConnectionBanner(SessionConnectionStatus.CONNECTING, null),
    ).toEqual({
      open: true,
      severity: 'warning',
      message: 'Connection lost. Reconnecting…',
    });
  });

  it('warns "Connection lost" while the kiosk socket is DISCONNECTED', () => {
    expect(
      deriveConnectionBanner(SessionConnectionStatus.DISCONNECTED, null),
    ).toEqual({
      open: true,
      severity: 'warning',
      message: 'Connection lost. Reconnecting…',
    });
  });

  it('warns about capacity when the socket is up but the transcription service refused for capacity', () => {
    const status = statusSnapshot({
      transcriptionServiceConnected: false,
      transcriptionServiceDisconnectReason:
        TranscriptionServiceDisconnectReason.AT_CAPACITY,
    });

    expect(
      deriveConnectionBanner(SessionConnectionStatus.CONNECTED, status),
    ).toEqual({
      open: true,
      severity: 'warning',
      message:
        'The live transcription service is at capacity. Retrying automatically…',
    });
  });

  it('reports a permanent error when the transcription service rejected the request', () => {
    // Close 1007 - in practice a transcriptionProviderId that is not in the
    // deployment's provider_config.json. The retry loop re-sends the identical
    // config forever, so "Reconnecting…" would be a promise nothing can keep.
    const status = statusSnapshot({
      transcriptionServiceConnected: false,
      transcriptionServiceDisconnectReason:
        TranscriptionServiceDisconnectReason.INVALID_REQUEST,
    });

    expect(
      deriveConnectionBanner(SessionConnectionStatus.CONNECTED, status),
    ).toEqual({
      open: true,
      severity: 'error',
      message:
        'Live transcription is misconfigured for this room and cannot start. An administrator needs to check the session’s transcription provider.',
    });
  });

  it('warns generically when the socket is up but the transcription service is down for an unknown reason', () => {
    const status = statusSnapshot({ transcriptionServiceConnected: false });

    expect(
      deriveConnectionBanner(SessionConnectionStatus.CONNECTED, status),
    ).toEqual({
      open: true,
      severity: 'warning',
      message:
        'Connection to the transcription service was lost. Reconnecting…',
    });
  });

  it('is closed when the socket is CONNECTED and the transcription service is connected', () => {
    expect(
      deriveConnectionBanner(
        SessionConnectionStatus.CONNECTED,
        statusSnapshot(),
      ),
    ).toEqual({ open: false });
  });

  it('prioritizes the kiosk socket status over a stale sessionStatus (own socket down explains everything else)', () => {
    // Even if the last-known sessionStatus says the transcription service is
    // fine, a non-CONNECTED kiosk socket means no session data is flowing at
    // all right now, so that takes priority.
    const status = statusSnapshot({ transcriptionServiceConnected: true });

    expect(
      deriveConnectionBanner(SessionConnectionStatus.CONNECTING, status),
    ).toEqual({
      open: true,
      severity: 'warning',
      message: 'Connection lost. Reconnecting…',
    });
  });
});

describe('kioskReducer setSessionStatus', (it) => {
  it('passes transcriptionServiceDisconnectReason through into activeSession.sessionStatus', () => {
    const withSession = kioskReducer(
      undefined,
      setActiveSession({ sessionUid: 'session-1', name: 'Session One' }),
    );

    const next = kioskReducer(
      withSession,
      setSessionStatus(
        statusSnapshot({
          transcriptionServiceConnected: false,
          transcriptionServiceDisconnectReason:
            TranscriptionServiceDisconnectReason.AT_CAPACITY,
        }),
      ),
    );

    expect(next.activeSession?.sessionStatus).toEqual({
      transcriptionServiceConnected: false,
      sourceDeviceConnected: true,
      transcriptionServiceDisconnectReason:
        TranscriptionServiceDisconnectReason.AT_CAPACITY,
    });
  });

  it('leaves transcriptionServiceDisconnectReason absent when the publisher omits it', () => {
    const withSession = kioskReducer(
      undefined,
      setActiveSession({ sessionUid: 'session-1', name: 'Session One' }),
    );

    const next = kioskReducer(withSession, setSessionStatus(statusSnapshot()));

    expect(
      next.activeSession?.sessionStatus.transcriptionServiceDisconnectReason,
    ).toBeUndefined();
  });

  it('is a no-op when there is no active session', () => {
    const state = kioskReducer(undefined, setSessionStatus(statusSnapshot()));

    expect(state.activeSession).toBeNull();
  });
});
