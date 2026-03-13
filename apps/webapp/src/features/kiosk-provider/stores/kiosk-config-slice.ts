import { type PayloadAction, createSlice } from '@reduxjs/toolkit';

import type { RootState } from '#src/stores/store';

export interface KioskConfigSliceState {
  deviceName: string | null;
  activeSessionId: string | null;
  prevEventId: number;
}

const initialState: KioskConfigSliceState = {
  deviceName: null,
  activeSessionId: null,
  prevEventId: -1,
};

// Selectors
export const selectDeviceName = (state: RootState) =>
  state.kioskConfig.deviceName;
export const selectActiveSessionId = (state: RootState) =>
  state.kioskConfig.activeSessionId;
export const selectPrevEventId = (state: RootState) =>
  state.kioskConfig.prevEventId;

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
  },
});

export const kioskConfigReducer = kioskConfigSlice.reducer;

export const { setDeviceName, setActiveSessionId, setPrevEventId } = kioskConfigSlice.actions;
