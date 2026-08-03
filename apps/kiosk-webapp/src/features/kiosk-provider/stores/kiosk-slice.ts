import {
  type PayloadAction,
  createAction,
  createSlice,
} from '@reduxjs/toolkit';

import type { ConnectionStatusSeverity } from '@scribear/core-ui';
import { TranscriptionServiceDisconnectReason } from '@scribear/node-server-schema';
import type { Session } from '@scribear/session-manager-schema';

import type { RootState } from '#src/store/store';

import type {
  DeviceInfo,
  JoinCodeEntry,
  KioskFault,
  RoomInfo,
  SessionStatusSnapshot,
} from '../services/kiosk-service';
import {
  KioskLifecycle,
  SessionConnectionStatus,
} from '../services/kiosk-service-status';

/**
 * UX-shaped state for the kiosk app, mirroring the spec's `KioskUxState`.
 * Everything in this slice is rebuilt from API responses on page load - the
 * only persisted credential is the `DEVICE_TOKEN` cookie, which the browser
 * manages.
 */
export interface KioskSliceState {
  lifecycle: KioskLifecycle;
  device: DeviceInfo | null;
  room: RoomInfo | null;
  sessions: Session[];
  activeSession: {
    sessionUid: string;
    name: string;
    connectionStatus: SessionConnectionStatus;
    sessionStatus: SessionStatusSnapshot;
    currentJoinCode: JoinCodeEntry | null;
    nextJoinCode: JoinCodeEntry | null;
  } | null;
  registrationError: string | null;
  /** Why the kiosk is degraded or stuck. Rendered by the connection banner. */
  error: KioskFault | null;
  /**
   * Health of the schedule long-poll. Separate from {@link error} because
   * they are independent failure domains - the schedule can be dead while a
   * session runs fine, and vice versa - and one must not overwrite the other.
   */
  scheduleSyncError: KioskFault | null;
}

const initialState: KioskSliceState = {
  lifecycle: KioskLifecycle.INITIALIZING,
  device: null,
  room: null,
  sessions: [],
  activeSession: null,
  registrationError: null,
  error: null,
  scheduleSyncError: null,
};

export const selectLifecycle = (state: RootState) => state.kiosk.lifecycle;
export const selectDevice = (state: RootState) => state.kiosk.device;
export const selectRoom = (state: RootState) => state.kiosk.room;
export const selectSessions = (state: RootState) => state.kiosk.sessions;
export const selectActiveSession = (state: RootState) =>
  state.kiosk.activeSession;
export const selectRegistrationError = (state: RootState) =>
  state.kiosk.registrationError;
export const selectError = (state: RootState) => state.kiosk.error;
export const selectScheduleSyncError = (state: RootState) =>
  state.kiosk.scheduleSyncError;

/**
 * Result of {@link deriveConnectionBanner}: either the banner should be
 * hidden, or shown with a severity/message pair matching
 * `ConnectionStatusBannerProps` (minus `open`, which the discriminant here
 * already carries).
 */
export type ConnectionBannerState =
  | { open: false }
  | { open: true; severity: ConnectionStatusSeverity; message: string };

/**
 * Pure derivation of what the kiosk's `ConnectionStatusBanner` should show,
 * given the four independent signals the kiosk tracks: whatever the service
 * has named as the current fault (`error`), the kiosk's own socket to
 * node-server (`connectionStatus`), node-server's upstream link to the
 * transcription service (`sessionStatus.transcriptionServiceConnected`), and
 * the health of the schedule long-poll (`scheduleSyncError`).
 *
 * Priority, most explanatory first:
 * 1. `TERMINAL` - the kiosk has stopped retrying. Always an `'error'`, and it
 *    renders the service's own explanation rather than a generic string,
 *    because the whole point of a terminal state is naming *which*
 *    unrecoverable thing happened and who has to fix it.
 * 2. Any other named fault (`error`), at the severity the service chose. This
 *    is what makes `selectError` real: `'Failed to fetch device info…'` and
 *    friends were dispatched into Redux on every failure and read by nothing,
 *    so the code looked like it reported errors and the wall stayed silent.
 *    A named cause outranks the generic "Connection lost" below because it
 *    says the same thing with the reason attached.
 * 3. A broken `connectionStatus`, which explains everything under it - no
 *    session data is flowing at all, regardless of what the last-known
 *    `sessionStatus` said.
 * 4. node-server's upstream link, only once the kiosk's own socket is
 *    confirmed `CONNECTED` and a stale-but-informative snapshot can be
 *    trusted.
 * 5. Degraded schedule sync. Last because it does not stop a running session
 *    from working; it stops the *next* one from starting, which is invisible
 *    behind an idle kiosk's perfectly calm status panel.
 *
 * No session (`connectionStatus === null`) means there is nothing to report
 * about a session - but the kiosk can still be broken in the other three
 * ways, all of which are reachable while `IDLE` or `INITIALIZING`.
 *
 * Almost every case here is a retrying/transient state (matching this
 * feature's fail-open philosophy elsewhere) and so is a `'warning'`. The
 * exceptions are `TERMINAL`, a fault the service itself marked `'error'`, and
 * `INVALID_REQUEST`: the transcription service rejected this session's
 * configuration and will reject the identical retry forever, so there is
 * nothing to wait for.
 */
export function deriveConnectionBanner(
  connectionStatus: SessionConnectionStatus | null,
  sessionStatus: SessionStatusSnapshot | null,
  error: KioskFault | null = null,
  scheduleSyncError: KioskFault | null = null,
): ConnectionBannerState {
  if (connectionStatus === SessionConnectionStatus.TERMINAL) {
    return {
      open: true,
      severity: 'error',
      message:
        error?.message ??
        'This kiosk cannot connect to the session running in this room and has stopped trying. An administrator needs to check it.',
    };
  }

  if (error !== null) {
    return { open: true, severity: error.severity, message: error.message };
  }

  if (
    connectionStatus !== null &&
    connectionStatus !== SessionConnectionStatus.CONNECTED
  ) {
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
    // Permanent, unlike every other branch here: the transcription service
    // rejected this session's configuration (close 1007 - typically a
    // transcriptionProviderId that does not exist on this deployment) and will
    // reject the identical retry forever. "Reconnecting…" would be a promise
    // nothing can keep, so this says what has to happen instead, and says it
    // as an error rather than a warning.
    if (
      sessionStatus.transcriptionServiceDisconnectReason ===
      TranscriptionServiceDisconnectReason.INVALID_REQUEST
    ) {
      return {
        open: true,
        severity: 'error',
        message:
          'Live transcription is misconfigured for this room and cannot start. An administrator needs to check the session’s transcription provider.',
      };
    }
    return {
      open: true,
      severity: 'warning',
      message:
        'Connection to the transcription service was lost. Reconnecting…',
    };
  }

  if (scheduleSyncError !== null) {
    return {
      open: true,
      severity: scheduleSyncError.severity,
      message: scheduleSyncError.message,
    };
  }

  return { open: false };
}

/**
 * Selector wrapping {@link deriveConnectionBanner} over the active session's
 * `connectionStatus`/`sessionStatus` plus the two service-reported faults.
 * The session pair is `null` when there is no active session, which
 * `deriveConnectionBanner` treats as "nothing to report about a session" -
 * the faults are still reported, since both can occur with no session at all.
 *
 * This is the sole consumer of `selectError`, and the reason that slice field
 * exists.
 */
export const selectConnectionBanner = (
  state: RootState,
): ConnectionBannerState =>
  deriveConnectionBanner(
    state.kiosk.activeSession?.connectionStatus ?? null,
    state.kiosk.activeSession?.sessionStatus ?? null,
    selectError(state),
    selectScheduleSyncError(state),
  );

export const kioskSlice = createSlice({
  name: 'kiosk',
  initialState,
  reducers: {
    setLifecycle: (state, action: PayloadAction<KioskLifecycle>) => {
      state.lifecycle = action.payload;
    },
    setDevice: (state, action: PayloadAction<DeviceInfo | null>) => {
      state.device = action.payload;
    },
    setRoom: (state, action: PayloadAction<RoomInfo | null>) => {
      state.room = action.payload;
    },
    setSessions: (state, action: PayloadAction<Session[]>) => {
      state.sessions = action.payload;
    },
    setActiveSession: (
      state,
      action: PayloadAction<{ sessionUid: string; name: string } | null>,
    ) => {
      if (action.payload === null) {
        state.activeSession = null;
        return;
      }
      state.activeSession = {
        ...action.payload,
        connectionStatus: SessionConnectionStatus.CONNECTING,
        sessionStatus: {
          transcriptionServiceConnected: false,
          sourceDeviceConnected: false,
        },
        currentJoinCode: null,
        nextJoinCode: null,
      };
    },
    setConnectionStatus: (
      state,
      action: PayloadAction<SessionConnectionStatus>,
    ) => {
      if (state.activeSession === null) return;
      state.activeSession.connectionStatus = action.payload;
    },
    setSessionStatus: (state, action: PayloadAction<SessionStatusSnapshot>) => {
      if (state.activeSession === null) return;
      state.activeSession.sessionStatus = action.payload;
    },
    setJoinCodes: (
      state,
      action: PayloadAction<{
        current: JoinCodeEntry;
        next: JoinCodeEntry | null;
      } | null>,
    ) => {
      if (state.activeSession === null) return;
      state.activeSession.currentJoinCode = action.payload?.current ?? null;
      state.activeSession.nextJoinCode = action.payload?.next ?? null;
    },
    setRegistrationError: (state, action: PayloadAction<string | null>) => {
      state.registrationError = action.payload;
    },
    setError: (state, action: PayloadAction<KioskFault | null>) => {
      state.error = action.payload;
    },
    setScheduleSyncError: (state, action: PayloadAction<KioskFault | null>) => {
      state.scheduleSyncError = action.payload;
    },
  },
});

export const kioskReducer = kioskSlice.reducer;

export const {
  setLifecycle,
  setDevice,
  setRoom,
  setSessions,
  setActiveSession,
  setConnectionStatus,
  setSessionStatus,
  setJoinCodes,
  setRegistrationError,
  setError,
  setScheduleSyncError,
} = kioskSlice.actions;

/**
 * Action dispatched to trigger device activation with a given activation
 * code. Handled by the kiosk middleware, which calls
 * `KioskService.activateDevice`.
 */
export const activateDevice = createAction<string>('kiosk/activateDevice');
