import { type PayloadAction, createSlice } from '@reduxjs/toolkit';

import type { RootState } from '#src/store/store';

/**
 * Shape of the `kioskConfig` Redux slice. Stores the registered device name,
 * the currently active session ID, the last received event ID used for
 * polling continuity, and the session refresh token for reconnection.
 */
export interface KioskConfigSliceState {
  deviceName: string | null;
  activeSessionId: string | null;
  prevEventId: number;
  // Persisted so the kiosk can reconnect to an active session after page
  // refresh without re-authenticating via device token (preserving clientId).
  sessionRefreshToken: string | null;
}

const initialState: KioskConfigSliceState = {
  deviceName: null,
  activeSessionId: null,
  prevEventId: -1,
  sessionRefreshToken: null,
};

/**
 * Selects the registered device name, or `null` if not yet registered.
 */
export const selectDeviceName = (state: RootState) =>
  state.kioskConfig.deviceName;
/**
 * Selects the ID of the session the kiosk is currently participating in, or `null`.
 */
export const selectActiveSessionId = (state: RootState) =>
  state.kioskConfig.activeSessionId;
/**
 * Selects the event ID of the last processed device-session event, used to resume polling.
 */
export const selectPrevEventId = (state: RootState) =>
  state.kioskConfig.prevEventId;
/**
 * Selects the persisted session refresh token for reconnection after page refresh.
 */
export const selectSessionRefreshToken = (state: RootState) =>
  state.kioskConfig.sessionRefreshToken;

/**
 * Redux slice storing the kiosk device registration details and active session state.
 */
export const kioskConfigSlice = createSlice({
  name: 'kioskConfig',
  initialState,
  reducers: {
    setDeviceName: (state, action: PayloadAction<string | null>) => {
      state.deviceName = action.payload;
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

// Reducer for the kioskConfig slice.
export const kioskConfigReducer = kioskConfigSlice.reducer;

// Action creators for the kioskConfig slice.
export const {
  setDeviceName,
  setActiveSessionId,
  setPrevEventId,
  setSessionRefreshToken,
} = kioskConfigSlice.actions;
