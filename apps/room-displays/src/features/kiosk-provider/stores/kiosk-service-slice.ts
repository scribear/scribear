import {
  type PayloadAction,
  createAction,
  createSlice,
} from '@reduxjs/toolkit';

import type { RootState } from '#src/store/store';

import { KioskServiceStatus } from '../services/kiosk-service-status';

interface SessionStatus {
  transcriptionServiceConnected: boolean;
  sourceDeviceConnected: boolean;
}

/**
 * Shape of the `kioskService` Redux slice. Tracks the current runtime status
 * of the `KioskService`, session connection status, and the active join code.
 */
export interface KioskServiceSliceState {
  kioskServiceStatus: KioskServiceStatus;
  sessionStatus: SessionStatus | null;
  joinCode: string | null;
  joinCodeExpiresAtUnixMs: number | null;
}

const initialState: KioskServiceSliceState = {
  kioskServiceStatus: KioskServiceStatus.INACTIVE,
  sessionStatus: null,
  joinCode: null,
  joinCodeExpiresAtUnixMs: null,
};

/**
 * Selects the current `KioskServiceStatus` from the Redux store.
 */
export const selectKioskServiceStatus = (state: RootState) =>
  state.kioskService.kioskServiceStatus;

/**
 * Selects the current session connection status, or null if no session is active.
 */
export const selectSessionStatus = (state: RootState) =>
  state.kioskService.sessionStatus;

/**
 * Selects the current join code and its expiry for display.
 */
export const selectJoinCode = (state: RootState) => state.kioskService.joinCode;
export const selectJoinCodeExpiresAtUnixMs = (state: RootState) =>
  state.kioskService.joinCodeExpiresAtUnixMs;

/**
 * Redux slice tracking the runtime status of the `KioskService`.
 */
export const kioskServiceSlice = createSlice({
  name: 'kioskService',
  initialState,
  reducers: {
    setKioskServiceStatus: (
      state,
      action: PayloadAction<KioskServiceStatus>,
    ) => {
      state.kioskServiceStatus = action.payload;
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
  },
});
// Reducer for the kioskService slice.
export const kioskServiceReducer = kioskServiceSlice.reducer;

// Action creator that updates the stored kiosk service status.
export const { setKioskServiceStatus, setSessionStatus, setJoinCode } =
  kioskServiceSlice.actions;
/**
 * Action dispatched to trigger device registration with a given activation code.
 * Handled by `kioskServiceMiddleware`, which calls `KioskService.registerDevice`.
 */
export const registerDevice = createAction<string>(
  'kioskService/registerDevice',
);
