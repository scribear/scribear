import { type PayloadAction, createSlice } from '@reduxjs/toolkit';

import type { RootState } from '#src/store/store';

/**
 * Shape of the `roomConfig` Redux slice. Stores the registered device name,
 * device ID, the currently active session ID, the last received event ID used
 * for polling continuity, and the session refresh token for reconnection.
 */
export interface RoomConfigSliceState {
  deviceName: string | null;
  deviceId: string | null;
  activeSessionId: string | null;
  prevEventId: number;
  // Persisted so the room device can reconnect to an active session after page
  // refresh without re-authenticating via device token (preserving clientId).
  sessionRefreshToken: string | null;
}

const initialState: RoomConfigSliceState = {
  deviceName: null,
  deviceId: null,
  activeSessionId: null,
  prevEventId: -1,
  sessionRefreshToken: null,
};

/**
 * Selects the registered device name, or `null` if not yet registered.
 */
export const selectDeviceName = (state: RootState) =>
  state.roomConfig.deviceName;
/**
 * Selects the device ID, or `null` if not yet set.
 */
export const selectDeviceId = (state: RootState) => state.roomConfig.deviceId;
/**
 * Selects the ID of the session the room device is currently participating in, or `null`.
 */
export const selectActiveSessionId = (state: RootState) =>
  state.roomConfig.activeSessionId;
/**
 * Selects the event ID of the last processed device-session event, used to resume polling.
 */
export const selectPrevEventId = (state: RootState) =>
  state.roomConfig.prevEventId;
/**
 * Selects the persisted session refresh token for reconnection after page refresh.
 */
export const selectSessionRefreshToken = (state: RootState) =>
  state.roomConfig.sessionRefreshToken;

/**
 * Redux slice storing the room device registration details and active session state.
 */
export const roomConfigSlice = createSlice({
  name: 'roomConfig',
  initialState,
  reducers: {
    setDeviceName: (state, action: PayloadAction<string | null>) => {
      state.deviceName = action.payload;
    },
    setDeviceId: (state, action: PayloadAction<string | null>) => {
      state.deviceId = action.payload;
    },
    setActiveSessionId: (state, action: PayloadAction<string | null>) => {
      state.activeSessionId = action.payload;
    },
    setPrevEventId: (state, action: PayloadAction<number>) => {
      state.prevEventId = action.payload;
    },
    setSessionRefreshToken: (state, action: PayloadAction<string | null>) => {
      state.sessionRefreshToken = action.payload;
    },
  },
});

// Reducer for the roomConfig slice.
export const roomConfigReducer = roomConfigSlice.reducer;

// Action creators for the roomConfig slice.
export const {
  setDeviceName,
  setDeviceId,
  setActiveSessionId,
  setPrevEventId,
  setSessionRefreshToken,
} = roomConfigSlice.actions;
