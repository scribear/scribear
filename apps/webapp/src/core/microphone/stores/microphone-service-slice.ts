import { type PayloadAction, createSlice } from '@reduxjs/toolkit';

import { MicrophoneServiceStatus } from '#src/core/microphone/services/microphone-service';
import type { RootState } from '#src/stores/store';

export interface MicrophoneServiceSliceState {
  microphoneServiceStatus: MicrophoneServiceStatus;
}

const initialState: MicrophoneServiceSliceState = {
  microphoneServiceStatus: MicrophoneServiceStatus.INACTIVE,
};

// Selectors
export const selectMicrophoneServiceStatus = (state: RootState) =>
  state.microphoneService.microphoneServiceStatus;
export const selectIsMicrophoneServiceActive = (state: RootState) =>
  state.microphoneService.microphoneServiceStatus ===
  MicrophoneServiceStatus.ACTIVE;

export const microphoneServiceSlice = createSlice({
  name: 'microphoneService',
  initialState,
  reducers: {
    setMicrophoneServiceStatus: (
      state,
      action: PayloadAction<MicrophoneServiceStatus>,
    ) => {
      state.microphoneServiceStatus = action.payload;
    },
  },
});
export const microphoneServiceReducer = microphoneServiceSlice.reducer;

export const { setMicrophoneServiceStatus } = microphoneServiceSlice.actions;
