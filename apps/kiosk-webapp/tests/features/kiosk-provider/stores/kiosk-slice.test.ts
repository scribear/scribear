import { describe, expect } from 'vitest';

import { TranscriptionServiceDisconnectReason } from '@scribear/node-server-schema';

import type {
  KioskFault,
  SessionStatusSnapshot,
} from '#src/features/kiosk-provider/services/kiosk-service';
import { SessionConnectionStatus } from '#src/features/kiosk-provider/services/kiosk-service-status';
import {
  deriveConnectionBanner,
  kioskReducer,
  selectConnectionBanner,
  setActiveSession,
  setConnectionStatus,
  setError,
  setScheduleSyncError,
  setSessionStatus,
} from '#src/features/kiosk-provider/stores/kiosk-slice';
import type { RootState } from '#src/store/store';

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

describe('deriveConnectionBanner faults', (it) => {
  const warning: KioskFault = {
    severity: 'warning',
    message: 'Cannot reach the ScribeAR session service. Retrying…',
  };
  const fatal: KioskFault = {
    severity: 'error',
    message: 'This kiosk is not assigned to the room running this session.',
  };

  it('renders the service’s own explanation in the TERMINAL branch', () => {
    expect(
      deriveConnectionBanner(SessionConnectionStatus.TERMINAL, null, fatal),
    ).toEqual({ open: true, severity: 'error', message: fatal.message });
  });

  it('still says something useful in TERMINAL with no explanation attached', () => {
    const banner = deriveConnectionBanner(
      SessionConnectionStatus.TERMINAL,
      null,
      null,
    );

    expect(banner).toMatchObject({ open: true, severity: 'error' });
    expect(banner.open && banner.message).toMatch(/stopped trying/i);
  });

  it('reports a fault with no session at all - initialization failures reach the wall too', () => {
    // `'Failed to fetch device info.'` happens during INITIALIZING, before any
    // session exists. Gating the banner on an active session is how that
    // message was computed, dispatched, stored, and never seen.
    expect(deriveConnectionBanner(null, null, warning)).toEqual({
      open: true,
      severity: 'warning',
      message: warning.message,
    });
  });

  it('prefers a named cause over the generic "Connection lost" wording', () => {
    expect(
      deriveConnectionBanner(SessionConnectionStatus.CONNECTING, null, warning),
    ).toEqual({
      open: true,
      severity: 'warning',
      message: warning.message,
    });
  });

  it('reports degraded schedule sync when nothing more urgent is wrong', () => {
    const scheduleFault: KioskFault = {
      severity: 'warning',
      message: 'Cannot reach the ScribeAR schedule service.',
    };

    expect(deriveConnectionBanner(null, null, null, scheduleFault)).toEqual({
      open: true,
      severity: 'warning',
      message: scheduleFault.message,
    });
  });

  it('lets a live-session fault outrank degraded schedule sync', () => {
    const scheduleFault: KioskFault = {
      severity: 'warning',
      message: 'Cannot reach the ScribeAR schedule service.',
    };

    expect(
      deriveConnectionBanner(
        SessionConnectionStatus.TERMINAL,
        null,
        fatal,
        scheduleFault,
      ),
    ).toEqual({ open: true, severity: 'error', message: fatal.message });
  });

  it('is closed when a healthy session has no faults of either kind', () => {
    expect(
      deriveConnectionBanner(
        SessionConnectionStatus.CONNECTED,
        statusSnapshot(),
        null,
        null,
      ),
    ).toEqual({ open: false });
  });
});

describe('selectConnectionBanner', (it) => {
  const asRootState = (kiosk: ReturnType<typeof kioskReducer>) =>
    ({ kiosk }) as RootState;

  it('feeds selectError into the banner - the wiring that did not exist', () => {
    // The regression this pins: `selectError` was defined, dispatched to on
    // every failure, and read by no component. The service can emit whatever
    // it likes; if this selector drops it, the room learns nothing.
    const fault: KioskFault = {
      severity: 'error',
      message: 'Session stream protocol mismatch.',
    };
    const state = kioskReducer(undefined, setError(fault));

    expect(selectConnectionBanner(asRootState(state))).toEqual({
      open: true,
      severity: 'error',
      message: fault.message,
    });
  });

  it('feeds selectScheduleSyncError into the banner', () => {
    const fault: KioskFault = {
      severity: 'warning',
      message: 'Schedule updates have stopped arriving.',
    };
    const state = kioskReducer(undefined, setScheduleSyncError(fault));

    expect(selectConnectionBanner(asRootState(state))).toEqual({
      open: true,
      severity: 'warning',
      message: fault.message,
    });
  });

  it('renders the terminal branch from the active session’s connection status', () => {
    const fault: KioskFault = {
      severity: 'error',
      message: 'This kiosk is not permitted to join this session.',
    };
    let state = kioskReducer(
      undefined,
      setActiveSession({ sessionUid: 'session-1', name: 'Session One' }),
    );
    state = kioskReducer(
      state,
      setConnectionStatus(SessionConnectionStatus.TERMINAL),
    );
    state = kioskReducer(state, setError(fault));

    expect(selectConnectionBanner(asRootState(state))).toEqual({
      open: true,
      severity: 'error',
      message: fault.message,
    });
  });

  it('is closed on a clean initial state', () => {
    const state = kioskReducer(undefined, { type: 'noop' });

    expect(selectConnectionBanner(asRootState(state))).toEqual({ open: false });
  });
});

describe('kioskReducer fault fields', (it) => {
  it('stores and clears the session fault', () => {
    const fault: KioskFault = { severity: 'warning', message: 'Retrying…' };
    const set = kioskReducer(undefined, setError(fault));
    expect(set.error).toEqual(fault);

    expect(kioskReducer(set, setError(null)).error).toBeNull();
  });

  it('keeps the schedule fault independent of the session fault', () => {
    const sessionFault: KioskFault = {
      severity: 'error',
      message: 'Protocol mismatch.',
    };
    const scheduleFault: KioskFault = {
      severity: 'warning',
      message: 'Schedule sync degraded.',
    };
    let state = kioskReducer(undefined, setError(sessionFault));
    state = kioskReducer(state, setScheduleSyncError(scheduleFault));
    state = kioskReducer(state, setError(null));

    // Two failure domains: clearing one must not silence the other.
    expect(state.error).toBeNull();
    expect(state.scheduleSyncError).toEqual(scheduleFault);
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
