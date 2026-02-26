/**
 * Redux slice for saving user preferences of microphone activity
 */
import { createSelector, createSlice } from '@reduxjs/toolkit';

import { selectAppMode } from '#src/core/app-mode/store/app-mode-slice';
import type { RootState } from '#src/stores/store';

import { MICROPHONE_ENABLED_APP_MODES } from '../config/microphone-enabled-app-modes';

export interface MicrophonePreferencesSlice {
  isPreferMicrophoneActive: boolean;
}

const initialState: MicrophonePreferencesSlice = {
  isPreferMicrophoneActive: false,
};

// Selectors
export const selectIsPreferMicrophoneActive = (state: RootState) =>
  state.microphonePreferences.isPreferMicrophoneActive;
export const selectIsTargetMicrophoneActive = createSelector(
  [selectAppMode, selectIsPreferMicrophoneActive],
  (appMode, isTargetMicrophoneActive) => {
    return (
      MICROPHONE_ENABLED_APP_MODES.includes(appMode) && isTargetMicrophoneActive
    );
  },
);

export const microphonePreferencesSlice = createSlice({
  name: 'microphonePreferences',
  initialState,
  reducers: {
    activateMicrophone: (state) => {
      state.isPreferMicrophoneActive = true;
    },
    deactivateMicrophone: (state) => {
      state.isPreferMicrophoneActive = false;
    },
  },
});
export const microphonePreferencesReducer = microphonePreferencesSlice.reducer;

// Action Creators
export const { activateMicrophone, deactivateMicrophone } =
  microphonePreferencesSlice.actions;
