import {
  type PayloadAction,
  createAction,
  createSlice,
} from '@reduxjs/toolkit';

import type { RootState } from '#src/store/store';

import { RoomServiceStatus } from '../services/room-service-status';

export interface UpcomingSession {
  sessionId: string;
  startTime: number;
  endTime: number | null;
  isActive: boolean;
}

export interface SessionStatus {
  transcriptionServiceConnected: boolean;
  sourceDeviceConnected: boolean;
}

/**
 * Shape of the `roomService` Redux slice. Tracks the current runtime status
 * of the `RoomService`, session connection status, the active join code,
 * upcoming sessions, and the mute state.
 */
export interface RoomServiceSliceState {
  roomServiceStatus: RoomServiceStatus;
  sessionStatus: SessionStatus | null;
  joinCode: string | null;
  joinCodeExpiresAtUnixMs: number | null;
  upcomingSessions: UpcomingSession[];
  isMuted: boolean;
}

const initialState: RoomServiceSliceState = {
  roomServiceStatus: RoomServiceStatus.INACTIVE,
  sessionStatus: null,
  joinCode: null,
  joinCodeExpiresAtUnixMs: null,
  upcomingSessions: [],
  isMuted: false,
};

/**
 * Selects the current `RoomServiceStatus` from the Redux store.
 */
export const selectRoomServiceStatus = (state: RootState) =>
  state.roomService.roomServiceStatus;

/**
 * Selects the current session connection status, or null if no session is active.
 */
export const selectSessionStatus = (state: RootState) =>
  state.roomService.sessionStatus;

/**
 * Selects the current join code for display.
 */
export const selectJoinCode = (state: RootState) => state.roomService.joinCode;

/**
 * Selects the expiry timestamp of the current join code.
 */
export const selectJoinCodeExpiresAtUnixMs = (state: RootState) =>
  state.roomService.joinCodeExpiresAtUnixMs;

/**
 * Selects the list of upcoming sessions for this room device.
 */
export const selectUpcomingSessions = (state: RootState) =>
  state.roomService.upcomingSessions;

/**
 * Selects whether the room device's microphone is currently muted.
 */
export const selectIsMuted = (state: RootState) => state.roomService.isMuted;

/**
 * Redux slice tracking the runtime status of the `RoomService`.
 */
export const roomServiceSlice = createSlice({
  name: 'roomService',
  initialState,
  reducers: {
    setRoomServiceStatus: (
      state,
      action: PayloadAction<RoomServiceStatus>,
    ) => {
      state.roomServiceStatus = action.payload;
    },
    setSessionStatus: (state, action: PayloadAction<SessionStatus | null>) => {
      state.sessionStatus = action.payload;
    },
    setJoinCode: (
      state,
      action: PayloadAction<{
        joinCode: string;
        expiresAtUnixMs: number;
      } | null>,
    ) => {
      state.joinCode = action.payload?.joinCode ?? null;
      state.joinCodeExpiresAtUnixMs = action.payload?.expiresAtUnixMs ?? null;
    },
    setUpcomingSessions: (state, action: PayloadAction<UpcomingSession[]>) => {
      state.upcomingSessions = action.payload;
    },
    setIsMuted: (state, action: PayloadAction<boolean>) => {
      state.isMuted = action.payload;
    },
  },
});

// Reducer for the roomService slice.
export const roomServiceReducer = roomServiceSlice.reducer;

// Action creators for the roomService slice.
export const {
  setRoomServiceStatus,
  setSessionStatus,
  setJoinCode,
  setUpcomingSessions,
  setIsMuted,
} = roomServiceSlice.actions;

/**
 * Action dispatched to trigger device registration with a given activation code.
 * Handled by the room service middleware, which calls `RoomService.registerDevice`.
 */
export const registerDevice = createAction<string>(
  'roomService/registerDevice',
);

/**
 * Action dispatched to toggle the mute state.
 * Payload is the new muted value (`true` = muted, `false` = unmuted).
 * Handled by the room service middleware, which calls `RoomService.muteSession`.
 */
export const muteToggle = createAction<boolean>('roomService/muteToggle');
