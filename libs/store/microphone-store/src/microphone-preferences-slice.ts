import { createSlice } from '@reduxjs/toolkit';

/**
 * State shape for the microphone preferences slice, which stores whether
 * the user wants the microphone to be active.
 */
export interface MicrophonePreferencesSlice {
  isPreferMicrophoneActive: boolean;
}

interface WithMicrophonePreferences {
  microphonePreferences: MicrophonePreferencesSlice;
}

const initialState: MicrophonePreferencesSlice = {
  isPreferMicrophoneActive: false,
};

/**
 * Selects whether the user has expressed a preference to have the microphone active.
 * @param state - The Redux state containing the microphonePreferences slice.
 * @returns `true` if the user wants the microphone to be active.
 */
export const selectIsPreferMicrophoneActive = (
  state: WithMicrophonePreferences,
) => state.microphonePreferences.isPreferMicrophoneActive;

/**
 * Redux slice storing the user's microphone activation preference.
 * The middleware observes this preference and drives the {@link MicrophoneService} accordingly.
 */
export const microphonePreferencesSlice = createSlice({
  name: 'microphonePreferences',
  initialState,
  reducers: {
    /**
     * Sets the microphone preference to active, signalling intent to use the mic.
     */
    activateMicrophone: (state) => {
      state.isPreferMicrophoneActive = true;
    },
    /**
     * Sets the microphone preference to inactive, signalling intent to stop the mic.
     */
    deactivateMicrophone: (state) => {
      state.isPreferMicrophoneActive = false;
    },
  },
});

// Reducer for the microphonePreferences slice.
export const microphonePreferencesReducer = microphonePreferencesSlice.reducer;

export const { activateMicrophone, deactivateMicrophone } =
  microphonePreferencesSlice.actions;
