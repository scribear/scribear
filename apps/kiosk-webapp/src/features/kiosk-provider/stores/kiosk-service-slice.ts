import {
  type PayloadAction,
  createAction,
  createSlice,
} from '@reduxjs/toolkit';

import type { RootState } from '#src/store/store';

import { KioskServiceStatus } from '../services/kiosk-service-status';

/**
 * Shape of the `kioskService` Redux slice. Tracks the current runtime status
 * of the `KioskService` (e.g. inactive, idle, active, or error states).
 */
export interface KioskServiceSliceState {
  kioskServiceStatus: KioskServiceStatus;
}

const initialState: KioskServiceSliceState = {
  kioskServiceStatus: KioskServiceStatus.INACTIVE,
};

/**
 * Selects the current `KioskServiceStatus` from the Redux store.
 */
export const selectKioskServiceStatus = (state: RootState) =>
  state.kioskService.kioskServiceStatus;

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
  },
});
// Reducer for the kioskService slice.
export const kioskServiceReducer = kioskServiceSlice.reducer;

// Action creator that updates the stored kiosk service status.
export const { setKioskServiceStatus } = kioskServiceSlice.actions;
/**
 * Action dispatched to trigger device registration with a given activation code.
 * Handled by `kioskServiceMiddleware`, which calls `KioskService.registerDevice`.
 */
export const registerDevice = createAction<string>(
  'kioskService/registerDevice',
);
