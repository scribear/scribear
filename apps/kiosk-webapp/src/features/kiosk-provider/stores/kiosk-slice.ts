import {
  type PayloadAction,
  createAction,
  createSlice,
} from '@reduxjs/toolkit';

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
