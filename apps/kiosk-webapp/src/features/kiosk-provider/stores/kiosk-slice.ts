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
  error: string | null;
}

const initialState: KioskSliceState = {
  lifecycle: KioskLifecycle.INITIALIZING,
  device: null,
  room: null,
  sessions: [],
  activeSession: null,
  registrationError: null,
  error: null,
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
 * given the two independent signals the kiosk tracks while a session is
 * active: the kiosk's own socket to node-server (`connectionStatus`), and
 * node-server's upstream link to the transcription service
 * (`sessionStatus.transcriptionServiceConnected`).
 *
 * Priority: a broken `connectionStatus` explains everything else (no session
 * data is flowing at all, regardless of what the last-known `sessionStatus`
 * said), so it's checked first. Only once the kiosk's own socket is
 * confirmed `CONNECTED` does a stale-but-still-informative
 * `sessionStatus.transcriptionServiceConnected === false` matter.
 *
 * No session (`connectionStatus === null`) means there is nothing to report
 * - the kiosk isn't participating in a session, so there's no connection to
 * be lost. Every case here is a retrying/transient state (matching this
 * feature's fail-open philosophy elsewhere), so severity is always
 * `'warning'`, never `'error'`.
 */
export function deriveConnectionBanner(
  connectionStatus: SessionConnectionStatus | null,
  sessionStatus: SessionStatusSnapshot | null,
): ConnectionBannerState {
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
 * Selector wrapping {@link deriveConnectionBanner} over the active session's
 * `connectionStatus`/`sessionStatus`. `null` for both when there is no
 * active session, which `deriveConnectionBanner` treats as "nothing to
 * report".
 */
export const selectConnectionBanner = (
  state: RootState,
): ConnectionBannerState =>
  deriveConnectionBanner(
    state.kiosk.activeSession?.connectionStatus ?? null,
    state.kiosk.activeSession?.sessionStatus ?? null,
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
    setError: (state, action: PayloadAction<string | null>) => {
      state.error = action.payload;
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
} = kioskSlice.actions;

/**
 * Action dispatched to trigger device activation with a given activation
 * code. Handled by the kiosk middleware, which calls
 * `KioskService.activateDevice`.
 */
export const activateDevice = createAction<string>('kiosk/activateDevice');
