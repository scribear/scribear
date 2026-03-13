import { type PayloadAction, createSlice } from '@reduxjs/toolkit';

import type { RootState } from '#src/stores/store';

import { KioskServiceStatus } from '../services/kiosk-service-status';

export interface KioskServiceSliceState {
  kioskServiceStatus: KioskServiceStatus;
}

const initialState: KioskServiceSliceState = {
  kioskServiceStatus: KioskServiceStatus.INACTIVE,
};

// Selectors
export const selectKioskServiceStatus = (state: RootState) =>
  state.kioskService.kioskServiceStatus;

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
    registerDevice: (state, action: PayloadAction<string>) => {},
  },
});
export const kioskServiceReducer = kioskServiceSlice.reducer;

export const { setKioskServiceStatus, registerDevice } =
  kioskServiceSlice.actions;
