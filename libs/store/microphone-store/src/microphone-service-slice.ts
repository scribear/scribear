import { type PayloadAction, createSlice } from '@reduxjs/toolkit';

import { MicrophoneServiceStatus } from './microphone-service.js';

/**
 * State shape for the microphone service slice, which reflects the current
 * runtime status of the {@link MicrophoneService}.
 */
export interface MicrophoneServiceSliceState {
  microphoneServiceStatus: MicrophoneServiceStatus;
}

interface WithMicrophoneService {
  microphoneService: MicrophoneServiceSliceState;
}

const initialState: MicrophoneServiceSliceState = {
  microphoneServiceStatus: MicrophoneServiceStatus.INACTIVE,
};

/**
 * Selects the current status of the microphone service.
 * @param state - The Redux state containing the microphoneService slice.
 * @returns The current {@link MicrophoneServiceStatus} value.
 */
export const selectMicrophoneServiceStatus = (state: WithMicrophoneService) =>
  state.microphoneService.microphoneServiceStatus;

/**
 * Selects whether the microphone service is currently in the ACTIVE state.
 * @param state - The Redux state containing the microphoneService slice.
 * @returns `true` if the microphone is actively capturing audio.
 */
export const selectIsMicrophoneServiceActive = (state: WithMicrophoneService) =>
  state.microphoneService.microphoneServiceStatus ===
  MicrophoneServiceStatus.ACTIVE;

/**
 * Redux slice that mirrors the runtime status of the {@link MicrophoneService}
 * into the Redux store. Updated by the microphone service middleware.
 */
export const microphoneServiceSlice = createSlice({
  name: 'microphoneService',
  initialState,
  reducers: {
    /**
     * Updates the stored microphone service status to reflect the service's current state.
     */
    setMicrophoneServiceStatus: (
      state,
      action: PayloadAction<MicrophoneServiceStatus>,
    ) => {
      state.microphoneServiceStatus = action.payload;
    },
  },
});

// Reducer for the microphoneService slice.
export const microphoneServiceReducer = microphoneServiceSlice.reducer;

export const { setMicrophoneServiceStatus } = microphoneServiceSlice.actions;
